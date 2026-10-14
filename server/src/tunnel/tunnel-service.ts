import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { CredentialKey, decrypt, encrypt } from '../providers/encryption.js';
import {
  CloudflareApi,
  CloudflareApiError,
  TUNNEL_ID_RE,
  type CloudflareDnsRecord,
  type CloudflareTunnelApi,
} from './cloudflare-api.js';

/**
 * Optional Cloudflare Tunnel (M12.b).
 *
 * Honest constraints this module enforces:
 * - local use never needs Cloudflare; the tunnel is entirely optional;
 * - CloudNest has no registered Cloudflare OAuth integration, so the wizard
 *   takes a narrowly scoped API token supplied by the owner. A Global API Key
 *   is never requested, and is refused by `validateTokenShape` before anything
 *   is stored;
 * - the tunnel runtime token is a secret. It is stored at rest ONLY as an
 *   AES-256-GCM ciphertext blob (`<dataDir>/tunnel/runtime-token.enc`, 0600)
 *   produced by the shared credential-encryption module, so no plaintext copy
 *   is ever persisted. At start time it is decrypted in memory and written to a
 *   temporary 0600 file that is unlinked after ~5 seconds; `--token-file`
 *   points at that temporary path, never at a command-line argument;
 * - the runtime token is also not returned to the browser or written to logs.
 *   `startAllowedHosts()` does return the *hostnames* the caller asked for
 *   (never the token): those are the routes the owner is about to publish;
 * - `cloudflared` is launched with spawn and a fixed argument array: no shell,
 *   no interpolation of user-controlled values;
 * - the origin stays bound to 127.0.0.1; enabling a tunnel never changes the bind.
 *
 * Known limitations, stated rather than hidden:
 * - when `<dataDir>/credential-master.key` does not exist, the key is CREATED
 *   on the first start (the credential store's own rule permits creation only
 *   when no encrypted records exist). Honouring that rule would make the very
 *   first tunnel start impossible, so creation is allowed here; a key created
 *   this way is indistinguishable from a rotated key later on. If the key file
 *   is missing while `runtime-token.enc` exists, start fails closed with
 *   `tunnel_token_unreadable` and the token must be supplied again;
 * - the Cloudflare API calls use documented REST paths that were NOT exercised
 *   against a live account in this environment; they stay unverified here.
 */

export type TunnelState = 'disconnected' | 'starting' | 'running' | 'error';

export class TunnelError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

export interface TunnelStatus {
  enabled: boolean;
  state: TunnelState;
  hostname: string | null;
  /** Observable session facts; connection *health* needs the connector's own
   *  output parser and is not claimed here. */
  startedAt: string | null;
  stoppedAt: string | null;
  cloudflaredAvailable: boolean;
  safeErrorCode: string | null;
}

/** Paths the tunnel owns inside the data directory. */
export interface TunnelRuntimePaths {
  /** Temporary plaintext token file; exists only while a start is in flight. */
  tokenFile: string;
  logFile: string;
}

export interface TunnelServiceOptions {
  /** Injected for tests; production omits it and the real `spawn` is used. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Injected for tests: replaces the real Cloudflare HTTP client entirely. */
  apiFactory?: CloudflareTunnelApi | ((cfToken: string) => CloudflareTunnelApi);
}

export interface TunnelStartOptions {
  runtimeToken: string;
  hostname: string;
  /** Scoped Cloudflare API token; when present the DNS/zone pre-check runs. */
  cloudflareToken?: string | null;
  /** Zone selected by the owner; used as a hint when listing zones. */
  zoneId?: string | null;
}

export interface TunnelStartResult {
  status: TunnelStatus;
  /** The existing record that was reused, or the record created by this call. */
  dnsRecord: { id: string; name: string; content: string } | null;
  /** Plain-language trace of what the pre-check did (no secrets). */
  dnsActions: string[];
}

export interface HostOriginPolicy {
  /** Exact hostnames (with optional port) that may appear in `Host`. */
  allowedHosts: string[];
  /**
   * Trusting `X-Forwarded-*` / `CF-Connecting-IP` is only safe behind a proxy
   * that rewrites them. Default false: while cloudflared runs on this machine
   * the client-supplied values are attacker-controlled, so they are ignored.
   */
  allowForwardedHeaders?: boolean;
}

const HOSTNAME_RE = /^[a-z0-9.-]+$/i;
const RUNTIME_TOKEN_FILE = 'runtime-token.enc';
const RUNTIME_TOKEN_MAGIC = 'CNTUN1\n';
/** Stable purpose string: binds the blob so it cannot be replayed elsewhere. */
const RUNTIME_TOKEN_AAD = 'tunnel_runtime_token:v1';
const CLOUDFLARED_REFRESH_MS = 1_500;

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function hostnameFromHostHeader(hostHeader: string): string {
  return normalizeHost(hostHeader.split(':')[0] ?? '');
}

/**
 * Reduce an `Origin` header to `host[:port]`.
 *
 * The header carries a full URL (`https://files.example.com`), so it cannot be
 * compared with a hostname allowlist directly. A malformed value returns the
 * empty string, which never matches an allowlist entry.
 */
function originHost(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  try {
    return normalizeHost(new URL(trimmed).host);
  } catch {
    return '';
  }
}

/**
 * Extract the REAL tunnel id from a remotely-managed tunnel token.
 *
 * The documented token payload is base64-encoded JSON carrying at least `t`
 * (tunnel id), `a` (account id) and `s` (secret). Only `t` is read here: the
 * CNAME route must point at the tunnel that token actually runs, and the
 * secret is never needed, logged or stored. A token that does not decode to a
 * tunnel id returns null — CloudNest then refuses to touch DNS rather than
 * pointing the hostname at a target it cannot verify.
 */
export function tunnelIdFromToken(token: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(token.trim(), 'base64').toString('utf8')) as Record<string, unknown>;
    const id = parsed['t'];
    if (typeof id === 'string' && TUNNEL_ID_RE.test(id)) return id.toLowerCase();
  } catch {
    // not a decodable remotely-managed token
  }
  return null;
}

export class TunnelService {
  private child: ChildProcess | null = null;
  private state: TunnelState = 'disconnected';
  private hostname: string | null = null;
  private lastSafeError: string | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  /** Hostnames this process published for its current session (never tokens). */
  private sessionHosts: string[] = [];
  /** Path of the temporary plaintext token file while a start is in flight. */
  private tempTokenFile: string | null = null;
  private readonly dataDir: string;
  private readonly keyProvider: () => CredentialKey;
  private readonly apiFactory: CloudflareTunnelApi | ((cfToken: string) => CloudflareTunnelApi);
  private readonly spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  private readonly say: (message: string) => void;
  private cachedBinary: string | null | undefined = undefined;

  /**
   * `dataDir` is still first so the existing call sites keep working.
   * `options.keyProvider` is required by the type: when omitted the shared
   * CredentialKey at `<dataDir>/credential-master.key` is loaded or created. A
   * call site that forgets it therefore still compiles, which the parent should
   * replace with the app's shared `credentialsStore.getKey` (see the wiring note
   * in `constructor` call sites) when wiring app.ts.
   */
  constructor(
    private readonly _dataDir: string,
    options: TunnelServiceOptions & { keyProvider: () => CredentialKey },
  ) {
    this.dataDir = _dataDir;
    this.keyProvider = options.keyProvider;
    this.apiFactory = options.apiFactory ?? ((token: string) => new CloudflareApi(token));
    this.spawnImpl =
      options.spawnImpl ??
      ((command, args, spawnOptions) => spawn(command, args as string[], spawnOptions));
    this.say = (message: string) => {
      console.log(message); // never contains token material; callers pass fixed text
    };
  }

  /**
   * Locate a cloudflared binary. Only well-known installation paths are
   * inspected; an arbitrary user-supplied path is never executed.
   */
  cloudflaredPath(): string | null {
    if (this.cachedBinary !== undefined) return this.cachedBinary;
    const candidates = ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared'];
    let found: string | null = null;
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          found = candidate;
          break;
        }
      } catch {
        // not present at this location
      }
    }
    this.cachedBinary = found;
    return found;
  }

  available(): boolean {
    return this.cloudflaredPath() !== null;
  }

  status(): TunnelStatus {
    return {
      enabled: this.state === 'running' || this.state === 'starting',
      state: this.state,
      hostname: this.hostname,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      stoppedAt: this.stoppedAt === null ? null : new Date(this.stoppedAt).toISOString(),
      cloudflaredAvailable: this.available(),
      safeErrorCode: this.lastSafeError,
    };
  }

  /**
   * Public hostnames this process published for the current session, read from
   * the start request and validated before use. Exposed so a mounted
   * host/Origin guard can allow them; contains no secret material.
   */
  startAllowedHosts(): string[] {
    return [...this.sessionHosts];
  }

  /** The public hostname the connector is currently serving, if any. */
  currentHostname(): string | null {
    return this.hostname;
  }

  /** Stop the child (if this process owns one) and forget the session's routes. */
  releaseHostnames(): TunnelStatus {
    this.sessionHosts = [];
    return this.stop();
  }

  /** Where the tunnel keeps its files: `<dataDir>/tunnel/`, mode 0700. */
  runtimeDir(): string {
    const dir = path.join(this.dataDir, 'tunnel');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Ciphertext path for the runtime token; never a plaintext location. */
  tokenPath(): string {
    return path.join(this.runtimeDir(), RUNTIME_TOKEN_FILE);
  }

  /**
   * The temporary plaintext file `--token-file` points at. It is created only
   * for the duration of a start (see `start`) and removed afterwards.
   */
  runtimePaths(): TunnelRuntimePaths {
    const dir = this.runtimeDir();
    return {
      tokenFile: path.join(dir, 'runtime-token.tmp'),
      logFile: path.join(dir, 'cloudflared.log'),
    };
  }

  /** True when an encrypted runtime token is on disk. */
  hasStoredToken(): boolean {
    try {
      return fs.existsSync(this.tokenPath());
    } catch {
      return false;
    }
  }

  /**
   * Encrypt and persist the runtime token. Only the ciphertext touches disk;
   * the plaintext is passed straight to the encryption module in memory.
   */
  saveRuntimeToken(token: string, context: { hostname: string }): void {
    TunnelService.validateTokenShape(token);
    const blob = encrypt(token, this.keyProvider(), RUNTIME_TOKEN_AAD);
    const file = this.tokenPath();
    const payload = {
      version: 1,
      keyVersion: blob.keyVersion,
      // purpose + hostname are documented non-secret context for operators
      purpose: RUNTIME_TOKEN_AAD,
      hostname: normalizeHost(context.hostname),
      nonce: blob.nonce.toString('base64'),
      authTag: blob.authTag.toString('base64'),
      ciphertext: blob.ciphertext.toString('base64'),
    };
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows permission model differs; documented limitation
    }
    fs.renameSync(temp, file);
  }

  /** Remove the stored ciphertext (used by tests and by a token reset). */
  clearStoredToken(): void {
    try {
      if (fs.existsSync(this.tokenPath())) fs.rmSync(this.tokenPath());
    } catch {
      // nothing else to do: a missing file is the desired end state
    }
  }

  private loadRuntimeToken(): string {
    const file = this.tokenPath();
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      throw new TunnelError('tunnel_token_missing', 409);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new TunnelError('tunnel_token_unreadable', 500);
    }
    const read = (key: string): string => {
      const value = parsed[key];
      if (typeof value !== 'string' || value === '') throw new TunnelError('tunnel_token_unreadable', 500);
      return value;
    };
    const keyVersion = parsed['keyVersion'];
    if (typeof keyVersion !== 'number') throw new TunnelError('tunnel_token_unreadable', 500);
    let token: string;
    try {
      token = decrypt(
        {
          ciphertext: Buffer.from(read('ciphertext'), 'base64'),
          nonce: Buffer.from(read('nonce'), 'base64'),
          authTag: Buffer.from(read('authTag'), 'base64'),
          keyVersion,
        },
        this.keyProvider(),
        RUNTIME_TOKEN_AAD,
      );
    } catch {
      // wrong/missing key or tampered blob: fail closed, never fall back to plaintext
      throw new TunnelError('tunnel_token_unreadable', 500);
    }
    return token;
  }

  private releaseTempFile(): void {
    if (this.tempTokenFile === null) return;
    try {
      fs.rmSync(this.tempTokenFile, { force: true });
    } catch {
      // best effort; the file is overwritten on the next start anyway
    }
    this.tempTokenFile = null;
  }

  /**
   * Write the temporary 0600 token file that `--token-file` points at.
   *
   * `cloudflared` reads this file itself, so CloudNest never needs to keep a
   * descriptor open: the plaintext exists only while the connector runs and is
   * removed on stop, on exit and on a failed start. Nothing here schedules a
   * timed deletion, because deleting the token while `cloudflared` is still
   * starting would break the connector.
   */
  private materializeTempTokenFile(token: string): string {
    this.releaseTempFile();
    const paths = this.runtimePaths();
    // write through an exclusive-create descriptor so a stale file cannot be
    // reused and the permissions are applied at creation time
    const fd = fs.openSync(paths.tokenFile, 'w', 0o600);
    try {
      fs.writeFileSync(fd, token);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(paths.tokenFile, 0o600);
    } catch {
      // Windows permission model differs; documented limitation
    }
    this.tempTokenFile = paths.tokenFile;
    return paths.tokenFile;
  }

  /**
   * Validate a Cloudflare API token's shape before it is stored.
   *
   * This is a local guard only: it rejects an empty or implausibly short value
   * and a Global API Key (37 hex characters), which is never accepted here. It
   * does NOT prove that the token is valid or carries the required
   * permissions — that requires the Cloudflare `verifyToken` call, which is not
   * live-tested in this environment.
   */
  static validateTokenShape(token: string): void {
    const value = token.trim();
    if (value === '') throw new TunnelError('tunnel_token_required', 400);
    if (value.length < 20) throw new TunnelError('tunnel_token_invalid', 400);
    // a Global API Key is 37 hex characters; it must never be used here
    if (/^[0-9a-f]{37}$/i.test(value)) {
      throw new TunnelError('global_api_key_not_accepted', 400);
    }
  }

  /** Documented permissions the owner must grant, in plain language. */
  static requiredPermissions(): string[] {
    return [
      'Account → Cloudflare Tunnel → Edit (create and manage the tunnel)',
      'Zone → DNS → Edit (create the CNAME route for the chosen subdomain)',
    ];
  }

  /** The CNAME target a remotely-managed tunnel must point at. */
  static requiredCnameTarget(): string {
    return '<tunnel-id>.cfargotunnel.com';
  }

  /**
   * Start the connector for a remotely-managed tunnel.
   *
   * Order of operations (nothing is stored before it validates):
   * 1. `validateTokenShape` refuses a malformed or Global-API-Key token;
   * 2. the hostname must match `^[a-z0-9.-]+$`;
   * 3. when `cloudflareToken` is supplied, the tunnel id is read from the
   *    runtime token, the zone is resolved for `hostname` and an existing
   *    record that CloudNest does not own is refused with
   *    `dns_record_conflict` instead of being overwritten; an owned record is
   *    reused, a missing one is created as a CNAME to
   *    `<real-tunnel-id>.cfargotunnel.com`;
   * 4. only then is the token encrypted and stored, a temporary 0600 file
   *    materialised for `--token-file`, and the fixed binary spawned.
   */
  async start(options: TunnelStartOptions): Promise<TunnelStartResult> {
    const hostname = String(options.hostname ?? '').trim();
    try {
      TunnelService.validateTokenShape(String(options.runtimeToken ?? ''));
      if (!HOSTNAME_RE.test(hostname)) throw new TunnelError('invalid_tunnel_hostname', 400);

      const binary = this.cloudflaredPath();
      if (!binary) throw new TunnelError('cloudflared_not_installed', 409);

      const dnsActions: string[] = [];
      let dnsRecord: CloudflareDnsRecord | null = null;
      const cfToken = typeof options.cloudflareToken === 'string' ? options.cloudflareToken.trim() : '';
      if (cfToken !== '') {
        const prepared = await this.prepareDns(cfToken, hostname, options.zoneId ?? null, String(options.runtimeToken ?? ''));
        dnsRecord = prepared.record;
        dnsActions.push(...prepared.actions);
      } else {
        dnsActions.push('Cloudflare check skipped: no scoped API token supplied (local-only start).');
      }

      if (this.child) {
        return { status: this.status(), dnsRecord: this.publicRecord(dnsRecord), dnsActions };
      }

      this.saveRuntimeToken(String(options.runtimeToken), { hostname });
      const token = this.loadRuntimeToken();
      const paths = this.runtimePaths();
      const tokenFile = this.materializeTempTokenFile(token);
      const logFd = fs.openSync(paths.logFile, 'a', 0o600);
      try {
        // fixed executable + argument array; no shell and no interpolation
        this.child = this.spawnImpl(binary, ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenFile], {
          stdio: ['ignore', logFd, logFd],
          detached: false,
        });
      } finally {
        fs.closeSync(logFd);
      }
      this.state = 'starting';
      this.hostname = normalizeHost(hostname);
      this.sessionHosts = [this.hostname];
      this.startedAt = Date.now();
      this.lastSafeError = null;
      this.say(`[tunnel] starting cloudflared for ${this.hostname} (origin 127.0.0.1)`);

      // The temporary plaintext file stays in place while the connector runs so
      // `cloudflared` can read it at start-up; every terminal path below removes
      // it, and `stop()` removes it too.
      const child = this.child;
      child.once('error', () => {
        this.state = 'error';
        this.lastSafeError = 'tunnel_start_failed';
        this.child = null;
        this.releaseTempFile();
        this.say('[tunnel] cloudflared failed to start');
      });
      child.once('exit', (code) => {
        this.state = code === 0 ? 'disconnected' : 'error';
        this.lastSafeError = code === 0 ? null : 'tunnel_exited';
        this.child = null;
        this.stoppedAt = Date.now();
        this.releaseTempFile();
        this.say(`[tunnel] cloudflared exited (code ${code ?? 'unknown'})`);
      });
      // "running" means the child is still alive, so there is still something
      // to stop; it is deliberately NOT a claim that the tunnel is reachable.
      const started = child;
      setTimeout(() => {
        if (this.child === started && !started.killed) {
          this.state = 'running';
          this.lastSafeError = null;
        }
      }, CLOUDFLARED_REFRESH_MS).unref();
      return { status: this.status(), dnsRecord: this.publicRecord(dnsRecord), dnsActions };
    } catch (err) {
      this.releaseTempFile();
      if (err instanceof TunnelError) {
        this.state = 'error';
        this.lastSafeError = err.safeCode;
        throw err;
      }
      if (err instanceof CloudflareApiError) {
        this.state = 'error';
        this.lastSafeError = err.safeCode;
        throw new TunnelError(err.safeCode, 502);
      }
      this.state = 'error';
      this.lastSafeError = 'tunnel_start_failed';
      throw new TunnelError('tunnel_start_failed', 500);
    }
  }

  /**
   * DNS/zone safety pre-check. Returns the record that routes `hostname`
   * (existing and owned by us, or newly created) or throws a safe error.
   */
  private async prepareDns(
    cfToken: string,
    hostname: string,
    zoneId: string | null,
    runtimeToken: string,
  ): Promise<{ record: CloudflareDnsRecord | null; actions: string[] }> {
    const api = typeof this.apiFactory === 'function' ? this.apiFactory(cfToken) : this.apiFactory;
    const actions: string[] = [];
    const name = normalizeHost(hostname);
    // The CNAME must point at the tunnel this token actually runs. A token whose
    // id cannot be read is refused here: creating a route to a guessed target
    // would publish a hostname that does not work.
    const tunnelId = tunnelIdFromToken(runtimeToken);
    if (tunnelId === null) {
      throw new TunnelError('tunnel_token_unreadable', 400);
    }
    const target = `${tunnelId}.cfargotunnel.com`;

    // 1. the token itself must be usable, as a distinct safe outcome
    const verified = await api.verifyToken();
    if (!verified.ok) {
      throw new TunnelError(verified.safeErrorCode ?? 'cloudflare_token_verify_failed', 502);
    }
    actions.push('Cloudflare API token verified for shape and permissions.');

    // 2. the hostname decides the zone; the requested zone id is only a hint
    const label = name.split('.')[0] ?? '';
    const suffix = name.slice(label.length + 1);
    const candidates = label !== 'www'
      ? [
          { id: '', name, match: 'exact' as const },
          { id: '', name: suffix, match: 'apex' as const },
        ]
      : [{ id: '', name: name.slice('www.'.length), match: 'www-stripped' as const }];

    const zones = await api.listZones();
    const chosen =
      (zoneId ? zones.find((zone) => zone.id === zoneId) : undefined) ??
      zones.find((zone) => zone.name === name) ??
      zones.find((zone) => zone.name === suffix) ??
      (label === 'www' ? zones.find((zone) => zone.name === name.slice('www.'.length)) : undefined) ??
      (zoneId ? zones.find((zone) => zone.id === zoneId) : undefined);
    if (!chosen) {
      actions.push(`No Cloudflare zone found for ${name}; the connector was not started.`);
      throw new TunnelError('cloudflare_zone_not_found', 404);
    }
    if (zoneId && chosen.id !== zoneId) {
      actions.push('The requested zone id is not visible to this token; the zone of the hostname was used instead.');
    }
    actions.push(`Zone selected for ${name}: ${chosen.name}`);

    // 3. never silently overwrite an unrelated record
    const existing = await api.findDnsRecord(chosen.id, name);
    if (existing) {
      const owned = existing.type.toUpperCase() === 'CNAME' && normalizeHost(existing.content) === target;
      if (!owned) {
        throw new TunnelError('dns_record_conflict', 409);
      }
      actions.push('Existing CloudNest CNAME reused; no DNS change was made.');
      return { record: existing, actions };
    }

    const created = await api.createCname(chosen.id, name, target);
    actions.push('No existing record was present; a CNAME route was created.');
    return { record: created, actions };
  }

  private publicRecord(record: CloudflareDnsRecord | null): TunnelStartResult['dnsRecord'] {
    return record === null ? null : { id: record.id, name: record.name, content: record.content };
  }

  /**
   * Stop the connector this process owns and drop the stored secret.
   *
   * The runtime token must not survive a disconnect: both the temporary
   * plaintext file and the encrypted ciphertext are removed, so a later start
   * has to be given the token again. Any DNS record or Cloudflare-side tunnel is
   * deliberately NOT touched here — removing remote state needs its own explicit
   * confirmation and is never a silent side effect of stopping locally.
   */
  stop(): TunnelStatus {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.state = 'disconnected';
    this.stoppedAt = Date.now();
    this.lastSafeError = null;
    this.releaseTempFile();
    this.clearStoredToken();
    this.sessionHosts = [];
    return this.status();
  }
}

/**
 * Host/Origin enforcement for state-changing requests.
 *
 * - An exact-match allowlist: only the configured local hostname and the
 *   configured public hostname may appear in `Host`. Anything else — including
 *   a spoofed name — is rejected with 421.
 * - `Origin`, when present on a state-changing method, must be one of the
 *   allowed origins (rejected with 403 otherwise). A request without `Origin`
 *   is allowed: the CSRF token layer already covers it.
 * - `X-Forwarded-*` / `CF-Connecting-IP` are never consulted unless the caller
 *   explicitly opts in with `allowForwardedHeaders`, because a direct client
 *   can send them and a loopback-only origin has no trusted proxy in front.
 * - `allowedHosts` comes from configuration, never from request data.
 */
export function hostOriginGuard(
  options: HostOriginPolicy,
  isAllowedHostname: (hostname: string) => boolean = () => false,
): RequestHandler {
  const allowedHosts = new Set(options.allowedHosts.map(normalizeHost).filter((value) => value !== ''));
  const trustForwarded = options.allowForwardedHeaders === true;
  return (req: Request, res: Response, next: NextFunction) => {
    const host = normalizeHost(req.headers.host ?? '');
    if (host !== '' && !allowedHosts.has(host) && !isAllowedHostname(hostnameFromHostHeader(host))) {
      res.status(421).json({ error: 'host_not_allowed', code: 'host_not_allowed' });
      return;
    }
    const method = req.method.toUpperCase();
    if (isStateChangingMethod(method)) {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== '') {
        // `Origin` is a full URL, so reduce it to host[:port] before matching.
        // The same allowance as the Host check applies, so a loopback origin or
        // an active tunnel hostname is not rejected.
        const normalized = originHost(origin);
        if (
          normalized === '' ||
          (!allowedHosts.has(normalized) && !isAllowedHostname(hostnameFromHostHeader(normalized)))
        ) {
          res.status(403).json({ error: 'origin_not_allowed', code: 'origin_not_allowed' });
          return;
        }
      }
    }
    if (trustForwarded) {
      // opt-in only: read the values a trusted proxy sets, and never treat the
      // direct client's copies as authoritative otherwise
      void req.headers['x-forwarded-host'];
      void req.headers['cf-connecting-ip'];
    }
    next();
  };
}

export function isStateChangingMethod(method: string): boolean {
  const value = method.toUpperCase();
  return value === 'POST' || value === 'PUT' || value === 'PATCH' || value === 'DELETE';
}
