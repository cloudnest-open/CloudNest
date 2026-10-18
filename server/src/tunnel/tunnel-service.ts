import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { CredentialKey } from '../providers/encryption.js';
import { BrowserAuthorization, BrowserAuthError, type BrowserAuthStatus } from './browser-auth.js';

/**
 * Optional Cloudflare Tunnel (M12.b) — browser-authorized (approved design §6).
 *
 * The flow is exactly `cloudflared tunnel login`, rclone-style, and the old
 * paste-an-API-token step is GONE:
 * - "Connect your domain" spawns `cloudflared tunnel login --origincert …`,
 *   hands the dash.cloudflare.com authorize URL to the UI and waits; the OWNER
 *   completes the login in their own browser (the account that is logged in
 *   there is the one that authorizes);
 * - the resulting origin cert and the `tunnel create` credentials JSON are
 *   stored ONLY as AES-256-GCM ciphertext blobs in `<dataDir>/tunnel/` (0600,
 *   outside git); their plaintext exists for seconds and is deleted right
 *   after encryption;
 * - starting spawns, in order: `tunnel create` (once, cred reused after),
 *   `tunnel route dns <id> <hostname>` (cert-authorized — the DNS REST API and
 *   its scoped token are no longer involved at all), then
 *   `tunnel --no-autoupdate run --cred-file <temp 0600>`.
 * - Disconnect/Reconnect: stopping the connector KEEPS the stored
 *   authorization, so Reconnect never re-asks the browser; `forget()` is the
 *   explicit way to start over. Connection-check reads the connector's own
 *   log for its "Registered tunnel connection" lines — an honest signal, not
 *   a guess.
 *
 * Unchanged invariants: local use never needs Cloudflare; the tunnel is
 * optional; the origin stays bound to 127.0.0.1; `cloudflared` is spawned
 * with fixed argv (no shell, no interpolation); hostnames never leak secret
 * material; enabling a tunnel never changes the server bind.
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
  startedAt: string | null;
  stoppedAt: string | null;
  cloudflaredAvailable: boolean;
  safeErrorCode: string | null;
  /** Browser-authorization state (login/authorize/forget lifecycle). */
  authorization: BrowserAuthStatus;
  /** The connector's own log reported registered connections — the honest
   * "reachable through Cloudflare" signal; null = no evidence yet. */
  connectorRegistered: boolean | null;
}

/** Paths the tunnel owns inside the data directory. */
export interface TunnelRuntimePaths {
  /** Temporary plaintext credentials file; exists only while a start is live. */
  credFile: string;
  logFile: string;
}

export interface TunnelServiceOptions {
  /** Injected for tests; production omits it and the real `spawn` is used. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Injected for tests: fixes the binary discovery (the real discovery is
   * process-wide cached, so a CI runner without cloudflared must not poison
   * the fake-spawn tests). Production omits it. */
  cloudflaredPathImpl?: () => string | null;
}

export interface TunnelStartOptions {
  hostname: string;
}

export interface TunnelStartResult {
  status: TunnelStatus;
  /** Plain-language trace of what this start did (no secrets). */
  actions: string[];
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
const CONNECTOR_REGISTERED_RE = /Registered tunnel connection/i;
const CLOUDFLARED_REFRESH_MS = 1_500;
/** Non-secret start metadata (hostname/tunnel id), 0600 in the tunnel dir. */
const META_FILE = 'tunnel-meta.json';

/** The real well-known-path discovery (injectable for tests). */
function realCloudflaredPath(): string | null {
  const candidates = ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared'];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present at this location
    }
  }
  return null;
}

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

interface TunnelMeta {
  hostname: string | null;
  tunnelId: string | null;
  tunnelName: string;
}

/** Run one cloudflared CLI step to completion; rejects with a safe code. */
function runStep(
  child: ChildProcess,
  timeoutMs: number,
  timeoutCode: string,
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new TunnelError(timeoutCode, 504));
    }, timeoutMs);
    timer.unref();
    child.once('error', (err) => {
      clearTimeout(timer);
      void err;
      reject(new TunnelError('tunnel_start_failed', 500));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code });
      else reject(new TunnelError('tunnel_step_failed', 502));
    });
  });
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
  /** Path of the temporary plaintext credentials file while a start is live. */
  private tempCredFile: string | null = null;
  /** The connector's own "Registered tunnel connection" evidence, if seen. */
  private connectorRegistered: boolean | null = null;
  private readonly dataDir: string;
  private readonly keyProvider: () => CredentialKey;
  private readonly spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  private readonly say: (message: string) => void;
  private readonly pathImpl: () => string | null;
  private cachedBinary: string | null | undefined = undefined;
  /** Browser-authorized cert/credentials (the design §6 lifecycle owner). */
  readonly browserAuth: BrowserAuthorization;

  constructor(
    private readonly _dataDir: string,
    options: TunnelServiceOptions & { keyProvider: () => CredentialKey },
  ) {
    this.dataDir = _dataDir;
    this.keyProvider = options.keyProvider;
    this.spawnImpl =
      options.spawnImpl ??
      ((command, args, spawnOptions) => spawn(command, args as string[], spawnOptions));
    this.pathImpl = options.cloudflaredPathImpl ?? realCloudflaredPath;
    this.say = (message: string) => {
      console.log(message); // never contains credential material; callers pass fixed text
    };
    this.browserAuth = new BrowserAuthorization(
      this.dataDir,
      this.keyProvider,
      this.spawnImpl,
      () => this.cloudflaredPath(),
      this.say,
    );
  }

  /**
   * Locate a cloudflared binary. Only well-known installation paths are
   * inspected; an arbitrary user-supplied path is never executed. Tests inject
   * the lookup, because the real result is cached process-wide.
   */
  cloudflaredPath(): string | null {
    if (this.cachedBinary !== undefined) return this.cachedBinary;
    this.cachedBinary = this.pathImpl();
    return this.cachedBinary;
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
      authorization: this.browserAuth.status(),
      connectorRegistered: this.connectorRegistered,
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

  runtimePaths(): TunnelRuntimePaths {
    const dir = this.runtimeDir();
    return {
      credFile: path.join(dir, 'runtime-cred.tmp'),
      logFile: path.join(dir, 'cloudflared.log'),
    };
  }

  /** Non-secret start metadata (hostname/tunnel id), 0600. */
  private metaPath(): string {
    return path.join(this.runtimeDir(), META_FILE);
  }

  private loadMeta(): TunnelMeta {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metaPath(), 'utf8')) as Partial<TunnelMeta>;
      return {
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
        tunnelId: typeof parsed.tunnelId === 'string' ? parsed.tunnelId : null,
        tunnelName: typeof parsed.tunnelName === 'string' ? parsed.tunnelName : 'cloudnest',
      };
    } catch {
      return { hostname: null, tunnelId: null, tunnelName: 'cloudnest' };
    }
  }

  private saveMeta(meta: TunnelMeta): void {
    const file = this.metaPath();
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(meta, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows permission model differs; documented limitation
    }
    fs.renameSync(temp, file);
  }

  /** Forget the stored hostname/tunnel id (used by forgetAuthorization). */
  clearMeta(): void {
    try {
      if (fs.existsSync(this.metaPath())) fs.rmSync(this.metaPath());
    } catch {
      // nothing else to do: a missing file is the desired end state
    }
  }

  /**
   * Write a temporary 0600 file (the decrypted credentials JSON) that
   * `--cred-file` points at. Created exclusively so a stale file cannot be
   * reused; removed on stop/exit/error via `releaseTempFile`.
   */
  private materializeTempCredFile(contents: string): string {
    this.releaseTempFile();
    const paths = this.runtimePaths();
    let fd: number;
    try {
      fd = fs.openSync(paths.credFile, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      fs.rmSync(paths.credFile, { force: true });
      fd = fs.openSync(paths.credFile, 'wx', 0o600);
    }
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(paths.credFile, 0o600);
    } catch {
      // Windows permission model differs; documented limitation
    }
    this.tempCredFile = paths.credFile;
    return paths.credFile;
  }

  /** Remove the temporary plaintext credentials file (best effort). */
  releaseTempFile(): void {
    if (this.tempCredFile === null) return;
    try {
      fs.rmSync(this.tempCredFile, { force: true });
    } catch {
      // best effort; the file is overwritten on the next start anyway
    }
    this.tempCredFile = null;
  }

  /** The tunnel id from the stored credentials JSON (memory only). */
  private tunnelIdFromCred(credJson: string): string {
    try {
      const parsed = JSON.parse(credJson) as Record<string, unknown>;
      const id = parsed['TunnelID'];
      if (typeof id === 'string' && id.trim() !== '') return id.trim();
    } catch {
      // fall through to the honest refusal
    }
    throw new TunnelError('tunnel_cred_unreadable', 500);
  }

  /**
   * Start the connector for the browser-authorized tunnel.
   *
   * Order of operations (nothing runs before it validates):
   * 1. the hostname must match `^[a-z0-9.-]+$` and an origin cert must be
   *    stored (browser authorization completed);
   * 2. credentials: the stored blob is reused; when absent the cert-authorized
   *    `tunnel create` runs once and its JSON is encrypted into place;
   * 3. `tunnel route dns` cert-creates/reuses the CNAME for the hostname
   *    (cloudflared itself refuses to clobber a record it does not own);
   * 4. the decrypted credentials go to a temporary 0600 file and the fixed
   *    argv `tunnel --no-autoupdate run --cred-file …` is spawned.
   */
  async start(options: TunnelStartOptions): Promise<TunnelStartResult> {
    const hostname = String(options.hostname ?? '').trim();
    const actions: string[] = [];
    let certTempWritten = false;
    try {
      if (!HOSTNAME_RE.test(hostname)) throw new TunnelError('invalid_tunnel_hostname', 400);
      const binary = this.cloudflaredPath();
      if (!binary) throw new TunnelError('cloudflared_not_installed', 409);
      if (!this.browserAuth.certStored()) throw new TunnelError('tunnel_not_authorized', 409);

      if (this.child) {
        return { status: this.status(), actions };
      }

      // 2. credentials (create once, reuse forever)
      let credJson: string;
      let tunnelId: string;
      const meta = this.loadMeta();
      if (this.browserAuth.credStored()) {
        credJson = this.browserAuth.loadCredJson();
        tunnelId = this.tunnelIdFromCred(credJson);
        actions.push('Existing tunnel credentials reused.');
      } else {
        const certFile = this.browserAuth.plaintextCertPath();
        certTempWritten = this.writeCertTemp(certFile);
        const credPath = this.browserAuth.plaintextCredPath();
        try {
          fs.rmSync(credPath, { force: true });
        } catch {
          // a leftover file from an interrupted create is replaced
        }
        const create = this.spawnImpl(
          binary,
          ['tunnel', 'create', '--origincert', certFile, '--cred-file', credPath, meta.tunnelName],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        await runStep(create, 60_000, 'tunnel_step_failed');
        credJson = fs.readFileSync(credPath, 'utf8');
        this.browserAuth.storeCredJson(credJson);
        fs.rmSync(credPath, { force: true });
        tunnelId = this.tunnelIdFromCred(credJson);
        actions.push('Tunnel created with the browser-authorized certificate.');
      }

      // 3. DNS route (cert-authorized; cloudflared owns the conflict rules)
      const certFile2 = this.browserAuth.plaintextCertPath();
      certTempWritten = this.writeCertTemp(certFile2);
      const route = this.spawnImpl(
        binary,
        ['tunnel', 'route', 'dns', '--origincert', certFile2, tunnelId, hostname],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let routed = false;
      try {
        await runStep(route, 60_000, 'tunnel_step_failed');
        routed = true;
      } finally {
        fs.rmSync(certFile2, { force: true });
      }
      actions.push(routed ? 'DNS route created/reused for the hostname.' : 'DNS route step did not complete.');

      this.saveMeta({ hostname: normalizeHost(hostname), tunnelId, tunnelName: meta.tunnelName });

      // 4. run from the temporary credentials file
      const paths = this.runtimePaths();
      const credFile = this.materializeTempCredFile(credJson);
      const logFd = fs.openSync(paths.logFile, 'a', 0o600);
      try {
        this.child = this.spawnImpl(binary, ['tunnel', '--no-autoupdate', 'run', '--cred-file', credFile], {
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
      this.connectorRegistered = null;
      this.say(`[tunnel] starting cloudflared for ${this.hostname} (origin 127.0.0.1)`);

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
      // to stop; reachability is claimed only by the connector's own log.
      const started = child;
      setTimeout(() => {
        if (this.child === started && !started.killed) {
          this.state = 'running';
          this.lastSafeError = null;
        }
      }, CLOUDFLARED_REFRESH_MS).unref();
      return { status: this.status(), actions };
    } catch (err) {
      this.releaseTempFile();
      if (err instanceof TunnelError) {
        this.state = 'error';
        this.lastSafeError = err.safeCode;
        throw err;
      }
      if (err instanceof BrowserAuthError) {
        this.state = 'error';
        this.lastSafeError = err.safeCode;
        throw new TunnelError(err.safeCode, err.httpStatus);
      }
      this.state = 'error';
      this.lastSafeError = 'tunnel_start_failed';
      throw new TunnelError('tunnel_start_failed', 500);
    } finally {
      // the plaintext cert helper files never outlive the start attempt
      if (certTempWritten) {
        try {
          fs.rmSync(this.browserAuth.plaintextCertPath(), { force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  /** Decrypt the cert into a 0600 helper file for one CLI step. */
  private writeCertTemp(certFile: string): boolean {
    // exclusive create with a stale-file retry: two steps back-to-back reuse
    // the same helper path, and a leftover file must never be reused
    let fd: number;
    try {
      fd = fs.openSync(certFile, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      fs.rmSync(certFile, { force: true });
      fd = fs.openSync(certFile, 'wx', 0o600);
    }
    try {
      fs.writeFileSync(fd, this.browserAuth.loadCert());
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  /**
   * Connection-check (owner requirement): read the connector's own log for
   * "Registered tunnel connection" lines since the current start. This is the
   * connector's own success signal — never an invented reachability claim.
   */
  checkConnection(): { registered: boolean | null; checkedAt: string } {
    if (this.state !== 'running' && this.state !== 'starting') {
      return { registered: this.connectorRegistered, checkedAt: new Date().toISOString() };
    }
    try {
      const text = fs.readFileSync(this.runtimePaths().logFile, 'utf8');
      // only evidence written after the current start counts
      const marker = text.lastIndexOf('starting cloudflared for');
      const relevant = marker >= 0 ? text.slice(marker) : text;
      this.connectorRegistered = CONNECTOR_REGISTERED_RE.test(relevant);
    } catch {
      // no log yet — honest null, not a guess
      this.connectorRegistered = this.connectorRegistered ?? null;
    }
    return { registered: this.connectorRegistered, checkedAt: new Date().toISOString() };
  }

  /**
   * Stop the connector this process owns. The stored authorization (origin
   * cert + tunnel credentials) SURVIVES: Disconnect is reversible, Reconnect
   * never re-asks the browser (owner requirement). `forgetAuthorization` is
   * the explicit way to delete the stored secrets. Remote Cloudflare-side
   * state is deliberately NOT touched here.
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
    this.sessionHosts = [];
    return this.status();
  }

  /** Delete the stored authorization + metadata (the explicit "start over"). */
  forgetAuthorization(): TunnelStatus {
    this.browserAuth.forget();
    this.clearMeta();
    this.hostname = null;
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
