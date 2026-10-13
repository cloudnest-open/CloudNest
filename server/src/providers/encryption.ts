import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AES-256-GCM credential encryption with a per-user master key file.
 * - Key: random 32 bytes at DATA_DIR/credential-master.key, 0600, atomic create.
 * - Fresh 12-byte nonce per encryption; 16-byte auth tag stored.
 * - Associated data binds each blob to its purpose + provider/account so a
 *   ciphertext cannot be moved between rows or providers.
 * - Missing key + existing encrypted records => fail closed (no auto new key).
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const CURRENT_KEY_VERSION = 1;

export interface EncryptedBlob {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export class CredentialKey {
  private constructor(readonly key: Buffer, readonly keyPath: string) {}

  static loadOrCreate(dataDir: string, hasExistingEncryptedRecords: boolean): CredentialKey {
    const keyPath = path.join(dataDir, 'credential-master.key');
    fs.mkdirSync(dataDir, { recursive: true });
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(keyPath);
    } catch {
      st = null;
    }
    if (st) {
      // reject symlinks and non-regular files; never follow them
      if (!st.isFile()) {
        throw new Error(`Credential key path is not a regular file: ${keyPath}. Refusing to continue.`);
      }
      const key = fs.readFileSync(keyPath);
      if (key.length !== KEY_BYTES) {
        throw new Error(`Credential key file has wrong length (${key.length}). Refusing to continue; restore a backup or remove corrupted state carefully.`);
      }
      return new CredentialKey(key, keyPath);
    }
    // no key file: only safe when there are no encrypted records
    if (hasExistingEncryptedRecords) {
      throw new Error(
        'Credential master key is missing but encrypted credentials exist. ' +
          'Restore credential-master.key from your secure backup; a new key cannot decrypt existing credentials. ' +
          'Metadata is preserved; affected accounts must be reconnected after key restore or manual reset.',
      );
    }
    // exclusive atomic create: never overwrite
    const key = crypto.randomBytes(KEY_BYTES);
    let fd: number;
    try {
      fd = fs.openSync(keyPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // raced with another process; load the winner's key
        return new CredentialKey(fs.readFileSync(keyPath), keyPath);
      }
      throw err;
    }
    try {
      fs.writeFileSync(fd, key);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Windows permission model differs; documented limitation.
    }
    return new CredentialKey(key, keyPath);
  }
}

export function encrypt(plain: string, key: CredentialKey, associatedData: string): EncryptedBlob {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== TAG_BYTES) throw new Error('unexpected tag length');
  return { ciphertext, nonce, authTag, keyVersion: CURRENT_KEY_VERSION };
}

export function decrypt(blob: EncryptedBlob, key: CredentialKey, associatedData: string): string {
  if (blob.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(`Unknown credential key version: ${blob.keyVersion}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key.key, blob.nonce);
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString('utf8');
}
