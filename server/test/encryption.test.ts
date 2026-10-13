import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialKey, encrypt, decrypt } from '../src/providers/encryption.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-crypt-'));
}

test('round-trip encryption with AAD binding', () => {
  const dir = tmpDir();
  const key = CredentialKey.loadOrCreate(dir, false);
  const blob = encrypt('secret-value', key, 'account_credentials:dropbox:acc-1');
  assert.equal(decrypt(blob, key, 'account_credentials:dropbox:acc-1'), 'secret-value');
});

test('AAD prevents ciphertext swapping between providers/rows', () => {
  const dir = tmpDir();
  const key = CredentialKey.loadOrCreate(dir, false);
  const blob = encrypt('token', key, 'account_credentials:dropbox:acc-1');
  assert.throws(() => decrypt(blob, key, 'account_credentials:google_drive:acc-1'));
  assert.throws(() => decrypt(blob, key, 'account_credentials:dropbox:acc-2'));
});

test('corrupted nonce/tag/ciphertext and unknown key version are rejected', () => {
  const dir = tmpDir();
  const key = CredentialKey.loadOrCreate(dir, false);
  const blob = encrypt('token', key, 'x');
  assert.throws(() => decrypt({ ...blob, nonce: Buffer.alloc(12) }, key, 'x'));
  assert.throws(() => decrypt({ ...blob, authTag: Buffer.alloc(16) }, key, 'x'));
  assert.throws(() => decrypt({ ...blob, ciphertext: Buffer.from('tampered') }, key, 'x'));
  assert.throws(() => decrypt({ ...blob, keyVersion: 99 }, key, 'x'));
});

test('wrong key is rejected', () => {
  const keyA = CredentialKey.loadOrCreate(tmpDir(), false);
  const keyB = CredentialKey.loadOrCreate(tmpDir(), false);
  const blob = encrypt('token', keyA, 'x');
  assert.throws(() => decrypt(blob, keyB, 'x'));
});

test('missing key with existing encrypted records fails closed (no auto new key)', () => {
  const dir = tmpDir();
  CredentialKey.loadOrCreate(dir, false); // create key once
  fs.rmSync(path.join(dir, 'credential-master.key'));
  assert.throws(() => CredentialKey.loadOrCreate(dir, true), /missing but encrypted credentials exist|Restore/);
  assert.ok(!fs.existsSync(path.join(dir, 'credential-master.key')), 'no replacement key was created');
});

test('key file has restricted permissions and is not a symlink', () => {
  const dir = tmpDir();
  const key = CredentialKey.loadOrCreate(dir, false);
  const st = fs.statSync(key.keyPath);
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(st.isFile());
  // a symlink at the key path is refused
  const dir2 = tmpDir();
  const target = path.join(dir2, 'elsewhere.key');
  fs.writeFileSync(target, Buffer.alloc(32));
  fs.symlinkSync(target, path.join(dir2, 'credential-master.key'));
  assert.throws(() => CredentialKey.loadOrCreate(dir2, false), /not a regular file|wrong length/);
});
