import crypto from 'node:crypto';

/**
 * Password hashing (OWASP scrypt baseline).
 * N=2^17, r=8, p=1, maxmem=256MiB, 16+ byte random salt per password.
 * Encoded record: scrypt$N$r$p$saltB64$hashB64 (versioned, constant-time verify).
 * Concurrent derivations are serialized to one per process.
 */

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const PASSWORD_MIN_CODEPOINTS = 12;
export const PASSWORD_MAX_CODEPOINTS = 128;
export const PASSWORD_MAX_BYTES = 1024;

// serialize heavy derivations: one at a time per process
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export function validatePasswordPolicy(password: string): { ok: true } | { ok: false; reason: string } {
  if ([...password].length < PASSWORD_MIN_CODEPOINTS) {
    return { ok: false, reason: `Password must be at least ${PASSWORD_MIN_CODEPOINTS} characters.` };
  }
  if ([...password].length > PASSWORD_MAX_CODEPOINTS) {
    return { ok: false, reason: `Password must be at most ${PASSWORD_MAX_CODEPOINTS} characters.` };
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return { ok: false, reason: 'Password is too long.' };
  }
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.reason);
  return serialize(async () => {
    const salt = crypto.randomBytes(SALT_LEN);
    const hash = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltB64 ?? '', 'base64');
  const expected = Buffer.from(hashB64 ?? '', 'base64');
  if (salt.length < 16 || expected.length !== KEY_LEN) return false;
  return serialize(async () => {
    const actual = await derive(password, salt, N, r, p);
    return crypto.timingSafeEqual(actual, expected);
  });
}
