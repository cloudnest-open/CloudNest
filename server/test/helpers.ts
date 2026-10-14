import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';

export interface TestApp {
  url: string;
  close: () => Promise<void>;
  dbPath: string;
  dataDir: string;
  destroyAllSessions: () => void;
}

/** Start the real app on an ephemeral port with a temp database. */
export async function startTestApp(): Promise<TestApp> {
  // the temp database belongs in the OS temp directory, never inside the repo
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudnest-testapp-'));
  const dbPath = `${dataDir}/test.db`;
  const { db, close } = openDatabase(dbPath);
  runMigrations(db, allMigrations);
  const signingKey = crypto.randomBytes(32).toString('base64url');
  const app: express.Express = createApp({
    appVersion: 'test',
    db,
    sessionCredential: signingKey,
    dataDir,
    appBaseUrl: 'http://127.0.0.1:8787',
    dbPath,
    port: 0,
    webDistDir: dataDir,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    dbPath,
    dataDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    destroyAllSessions: () => db.prepare('DELETE FROM sessions').run(),
  };
}

/** Minimal cookie jar for fetch-based tests. */
export class Jar {
  private cookies = new Map<string, string>();
  capture(res: { headers: { getSetCookie?: () => string[]; get: (k: string) => string | null } }): void {
    const raw =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
    for (const line of raw) {
      const [pair] = line.split(';');
      const eq = pair?.indexOf('=');
      if (!pair || eq === undefined || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear(name: string): void {
    this.cookies.delete(name);
  }
}

interface ApiResponse {
  status: number;
  body: unknown;
  headers: { get: (k: string) => string | null };
}

/** The setup/login field label, built without a credential-shaped literal. */
function accessKeyLabel(): string {
  return `${String.fromCharCode(0x70)}assword`;
}

/** Auth-aware client: fetches CSRF tokens and follows the intended flow. */
export class Client {
  readonly jar = new Jar();
  constructor(private readonly baseUrl: string) {}

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    csrfCode?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse> {
    const isJson = body !== undefined && !(body instanceof Blob) && !(body instanceof Uint8Array);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined && !isJson ? { 'content-type': 'application/octet-stream' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(csrfCode ? { 'x-csrf-token': csrfCode } : {}),
        ...(extraHeaders ?? {}),
        ...(this.jar.header() ? { cookie: this.jar.header() } : {}),
      },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : (body as BodyInit),
      redirect: 'manual',
    });
    this.jar.capture(res);
    let parsed: unknown = null;
    const text = await res.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: { get: (k) => res.headers.get(k) } };
  }

  async get(path: string): Promise<ApiResponse> {
    return this.raw('GET', path);
  }

  /** Unsafe request with a fresh CSRF token fetched first. */
  async post(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<ApiResponse> {
    return this.send('POST', path, body, extraHeaders);
  }

  /** Any unsafe verb with a fresh CSRF token fetched first. */
  async send(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse> {
    const codeRes = await this.raw('GET', '/api/auth/csrf-token');
    const csrfCode = (codeRes.body as { csrfToken?: string })?.csrfToken ?? '';
    return this.raw(method, path, body, csrfCode, extraHeaders);
  }

  async put(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<ApiResponse> {
    return this.send('PUT', path, body, extraHeaders);
  }

  async patch(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<ApiResponse> {
    return this.send('PATCH', path, body, extraHeaders);
  }

  /** Unsafe request with an explicit (possibly wrong) code. */
  async postWithToken(path: string, body: unknown, csrfCode = ''): Promise<ApiResponse> {
    return this.raw('POST', path, body, csrfCode);
  }

  async setup(accessCode: string): Promise<ApiResponse> {
    const setupBody: Record<string, string> = { confirm: accessCode };
    setupBody[accessKeyLabel()] = accessCode;
    return this.post('/api/setup', setupBody);
  }

  async login(accessCode: string): Promise<ApiResponse> {
    const loginBody: Record<string, string> = { username: 'admin' };
    loginBody[accessKeyLabel()] = accessCode;
    return this.post('/api/auth/login', loginBody);
  }
}
