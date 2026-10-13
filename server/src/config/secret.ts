import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Random session-signing secret, generated once and stored in the per-user
 * data directory with restrictive permissions (0600). Kept out of Git and logs.
 * If the file is lost, all sessions become invalid and the owner logs in again.
 * Not rotated on every restart (by design).
 */
export function loadOrCreateSessionSecret(dataDir: string): string {
  const secretPath = path.join(dataDir, 'session-secret');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not present yet
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    // Windows: filesystem permissions differ; documented limitation.
  }
  return secret;
}
