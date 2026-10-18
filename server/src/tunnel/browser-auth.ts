import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { encrypt, decrypt, type CredentialKey } from '../providers/encryption.js';

/**
 * Browser-authorized Cloudflare credentials (approved design §6, the
 * `cloudflared tunnel login` flow — NO API token anywhere):
 *
 * 1. `startLogin()` spawns `cloudflared tunnel login --origincert <path>`,
 *    scrapes the dash.cloudflare.com authorize URL from its output and hands
 *    it to the UI; the OWNER completes the login in their own browser.
 * 2. When cloudflared exits successfully the origin cert exists at that path;
 *    its plaintext is encrypted into `<dataDir>/tunnel/cert.pem.enc` (AES-256-
 *    GCM, 0600, same pattern as the old runtime token) and the plaintext file
 *    is removed immediately.
 * 3. `tunnel create` writes the credentials JSON; it is treated the same way:
 *    encrypted to `tunnel-cred.enc`, plaintext removed.
 *
 * Disconnect/Reconnect (owner requirement): STOPPING the connector keeps the
 * stored authorization, so Reconnect never re-asks the browser. `forget()`
 * is the explicit way to start over. Nothing here is ever in git.
 */

export type BrowserAuthState = 'idle' | 'authorizing' | 'authorized' | 'failed';

export interface BrowserAuthStatus {
  state: BrowserAuthState;
  /** The authorize URL while a login is in flight (or the last one offered). */
  authUrl: string | null;
  safeErrorCode: string | null;
  /** An encrypted origin cert is stored — Reconnect can work offline. */
  certStored: boolean;
}

const CERT_FILE = 'cert.pem.enc';
const CRED_FILE = 'tunnel-cred.enc';
const CERT_AAD = 'tunnel_origin_cert:v1';
const CRED_AAD = 'tunnel_credentials:v1';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_RE = /https:\/\/dash\.cloudflare\.com\/[^\s"']+/;

export class BrowserAuthError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 409) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

interface EncryptedPayload {
  version: 1;
  keyVersion: number;
  purpose: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

export class BrowserAuthorization {
  private state: BrowserAuthState = 'idle';
  private authUrl: string | null = null;
  private lastError: string | null = null;
  private loginChild: ChildProcess | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly keyProvider: () => CredentialKey,
    private readonly spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
    private readonly cloudflaredPath: () => string | null,
    private readonly say: (message: string) => void,
  ) {}

  /** `<dataDir>/tunnel/` — 0700, outside git, same dir the service uses. */
  private dir(): string {
    const dir = path.join(this.dataDir, 'tunnel');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private blobPath(file: string): string {
    return path.join(this.dir(), file);
  }

  /** Where cloudflared writes the plaintext origin cert during login. */
  plaintextCertPath(): string {
    return path.join(this.dir(), 'cert.pem.tmp');
  }

  /** Where `tunnel create` writes the plaintext credentials JSON. */
  plaintextCredPath(): string {
    return path.join(this.dir(), 'tunnel-cred.tmp');
  }

  status(): BrowserAuthStatus {
    return {
      state: this.state,
      authUrl: this.authUrl,
      safeErrorCode: this.lastError,
      certStored: this.certStored(),
    };
  }

  certStored(): boolean {
    try {
      return fs.existsSync(this.blobPath(CERT_FILE));
    } catch {
      return false;
    }
  }

  credStored(): boolean {
    try {
      return fs.existsSync(this.blobPath(CRED_FILE));
    } catch {
      return false;
    }
  }

  private writeBlob(file: string, aad: string, plaintext: string): void {
    const blob = encrypt(plaintext, this.keyProvider(), aad);
    const payload: EncryptedPayload = {
      version: 1,
      keyVersion: blob.keyVersion,
      purpose: aad,
      nonce: blob.nonce.toString('base64'),
      authTag: blob.authTag.toString('base64'),
      ciphertext: blob.ciphertext.toString('base64'),
    };
    const target = this.blobPath(file);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows permission model differs; documented limitation
    }
    fs.renameSync(temp, target);
  }

  private readBlob(file: string, aad: string): string {
    let raw: string;
    try {
      raw = fs.readFileSync(this.blobPath(file), 'utf8');
    } catch {
      throw new BrowserAuthError('tunnel_not_authorized', 409);
    }
    let parsed: EncryptedPayload;
    try {
      parsed = JSON.parse(raw) as EncryptedPayload;
    } catch {
      throw new BrowserAuthError('tunnel_auth_unreadable', 500);
    }
    try {
      return decrypt(
        {
          keyVersion: parsed.keyVersion,
          nonce: Buffer.from(parsed.nonce, 'base64'),
          authTag: Buffer.from(parsed.authTag, 'base64'),
          ciphertext: Buffer.from(parsed.ciphertext, 'base64'),
        },
        this.keyProvider(),
        aad,
      );
    } catch {
      throw new BrowserAuthError('tunnel_auth_unreadable', 500);
    }
  }

  /** The origin cert plaintext (memory only; callers must not write it). */
  loadCert(): string {
    return this.readBlob(CERT_FILE, CERT_AAD);
  }

  /** The tunnel credentials JSON (memory only). */
  loadCredJson(): string {
    return this.readBlob(CRED_FILE, CRED_AAD);
  }

  storeCredJson(json: string): void {
    this.writeBlob(CRED_FILE, CRED_AAD, json);
  }

  /** Encrypt the origin cert into place (login exit path + test seeding). */
  storeCert(plaintext: string): void {
    this.writeBlob(CERT_FILE, CERT_AAD, plaintext);
  }

  /**
   * One browser-authorization flow at a time. The URL is scraped from
   * cloudflared's own output — the owner opens it, picks the domain and
   * Authorizes; the process exits 0 once the origin cert lands.
   */
  startLogin(): BrowserAuthStatus {
    if (this.state === 'authorizing' && this.loginChild) {
      return this.status();
    }
    const binary = this.cloudflaredPath();
    if (!binary) throw new BrowserAuthError('cloudflared_not_installed', 409);
    const certPath = this.plaintextCertPath();
    try {
      fs.rmSync(certPath, { force: true });
    } catch {
      // a stale file will be overwritten by cloudflared anyway
    }
    this.state = 'authorizing';
    this.lastError = null;
    this.say('[tunnel] browser authorization: waiting for the owner to approve in the browser');
    // fixed argv, no shell; the URL goes to the UI, never spawned
    const child = this.spawnImpl(binary, ['tunnel', 'login', '--origincert', certPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.loginChild = child;
    const collect = (chunk: Buffer | string): void => {
      // late pipe output after the flow completed must not resurrect a URL
      if (this.state !== 'authorizing') return;
      const text = String(chunk);
      if (this.authUrl === null) {
        const match = URL_RE.exec(text);
        if (match) {
          this.authUrl = match[0];
          this.say('[tunnel] browser authorization URL captured');
        }
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => {
      this.state = 'failed';
      this.lastError = 'tunnel_login_failed';
      this.loginChild = null;
    });
    child.once('exit', (code) => {
      this.loginChild = null;
      this.authUrl = null;
      if (code === 0 && fs.existsSync(certPath)) {
        try {
          this.storeCert(fs.readFileSync(certPath, 'utf8'));
          fs.rmSync(certPath, { force: true });
          this.state = 'authorized';
          this.lastError = null;
          this.say('[tunnel] browser authorization complete; origin cert stored encrypted');
        } catch {
          this.state = 'failed';
          this.lastError = 'tunnel_auth_unreadable';
        }
        return;
      }
      this.state = 'failed';
      this.lastError = 'tunnel_login_failed';
    });
    // an abandoned authorize tab must not park the state machine forever
    setTimeout(() => {
      if (this.loginChild === child && !child.killed) {
        try {
          child.kill();
        } catch {
          // already gone
        }
        this.state = 'failed';
        this.lastError = 'tunnel_login_timeout';
        this.say('[tunnel] browser authorization timed out');
      }
    }, LOGIN_TIMEOUT_MS).unref();
    return this.status();
  }

  /** Remove the stored authorization (the explicit "start over"). */
  forget(): void {
    for (const file of [CERT_FILE, CRED_FILE]) {
      try {
        if (fs.existsSync(this.blobPath(file))) fs.rmSync(this.blobPath(file));
      } catch {
        // best effort; a missing file is the desired end state
      }
    }
    this.state = this.certStored() ? 'authorized' : 'idle';
    this.authUrl = null;
    this.lastError = null;
  }
}
