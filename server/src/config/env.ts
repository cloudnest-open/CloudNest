import path from 'node:path';
import { existsSync } from 'node:fs';
import envPaths from 'env-paths';

/**
 * Validated application configuration (Step 1).
 *
 * Security notes:
 * - The server binds to loopback only in this step; a HOST override is
 *   intentionally NOT supported yet because authentication is not implemented.
 * - Secrets are never logged or included in HTTP responses.
 */

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  dataDir: string;
  dbPath: string;
  appVersion: string;
  /** Canonical origin for OAuth callbacks. Never derived from a Host header. */
  appBaseUrl: string;
}

function parseAppBaseUrl(raw: string | undefined): string {
  const value = (raw === undefined || raw.trim() === '') ? 'http://127.0.0.1:8787' : raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid APP_BASE_URL: ${JSON.stringify(raw)}. Use an origin like http://127.0.0.1:8787.`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('APP_BASE_URL must be an origin only (scheme + host + optional port; no path, query, credentials or fragment).');
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'http:') {
    if (!isLoopback) throw new Error('APP_BASE_URL: plain HTTP is only allowed for loopback origins; use HTTPS otherwise.');
  } else if (url.protocol !== 'https:') {
    throw new Error('APP_BASE_URL: scheme must be http (loopback) or https.');
  }
  return url.origin;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT value: ${JSON.stringify(raw)}. Use an integer between 1 and 65535.`,
    );
  }
  return port;
}

function parseNodeEnv(raw: string | undefined): AppConfig['nodeEnv'] {
  if (raw === undefined || raw.trim() === '') return 'development';
  const value = raw.trim().toLowerCase();
  if (value === 'development' || value === 'production' || value === 'test') {
    return value;
  }
  throw new Error(
    `Invalid NODE_ENV value: ${JSON.stringify(raw)}. Use development, production or test.`,
  );
}

function resolveDataDir(raw: string | undefined): string {
  if (raw !== undefined && raw.trim() !== '') {
    return path.resolve(raw.trim());
  }
  // Per-user OS application data directory, e.g.
  // ~/.local/share/CloudNest-nodejs/Data on Linux.
  const paths = envPaths('CloudNest', { suffix: '' });
  return paths.data;
}

/** Load and validate configuration once. Reads .env when present. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = parsePort(env.PORT);
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const dataDir = resolveDataDir(env.DATA_DIR);
  const dbPath = path.join(dataDir, 'cloudnest.db');
  const appBaseUrl = parseAppBaseUrl(env.APP_BASE_URL);
  return {
    port,
    nodeEnv,
    dataDir,
    dbPath,
    appVersion: '0.1.0',
    appBaseUrl,
  };
}

/** True when a local .env file exists next to the repository root (informational only). */
export function dotenvFileExists(cwd: string = process.cwd()): boolean {
  return existsSync(path.join(cwd, '.env'));
}
