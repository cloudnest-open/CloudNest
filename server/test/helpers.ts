import express from 'express';
import fs from 'node:fs';
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
  const dataDir = fs.mkdtempSync('cloudnest-testapp-');
  const dbPath = `${dataDir}/test.db`;
  const { db, close } = openDatabase(dbPath);
  runMigrations(db, allMigrations);
  const secret = crypto.randomBytes(32).toString('base64url');
  const app: express.Express = createApp({ appVersion: 'test', db, sessionSecret: secret, dataDir, appBaseUrl: 'http://127.0.0.1:8787', webDistDir: dataDir });
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

/** Auth-aware client: fetches CSRF tokens and follows the intended flow. */
export class Client {
  readonly jar = new Jar();
  constructor(private readonly baseUrl: string) {}

  private async raw(method: string, path: string, body?: unknown, csrfToken?: string): Promise<ApiResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...(this.jar.header() ? { cookie: this.jar.header() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
  async post(path: string, body?: unknown): Promise<ApiResponse> {
    return this.send('POST', path, body);
  }

  /** Any unsafe verb with a fresh CSRF token fetched first. */
  async send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResponse> {
    const tokenRes = await this.raw('GET', '/api/auth/csrf-token');
    const token = (tokenRes.body as { csrfToken?: string })?.csrfToken ?? '';
    return this.raw(method, path, body, token);
  }

  async put(path: string, body?: unknown): Promise<ApiResponse> {
    return this.send('PUT', path, body);
  }

  async patch(path: string, body?: unknown): Promise<ApiResponse> {
    return this.send('PATCH', path, body);
  }

  /** Unsafe request with an explicit (possibly wrong) token. */
  async postWithToken(path: string, body: unknown, token: string): Promise<ApiResponse> {
    return this.raw('POST', path, body, token);
  }

  async setup(password: string): Promise<ApiResponse> {
    return this.post('/api/setup', { password, confirm: password });
  }

  async login(password: string): Promise<ApiResponse> {
    return this.post('/api/auth/login', { username: 'admin', password });
  }
}
