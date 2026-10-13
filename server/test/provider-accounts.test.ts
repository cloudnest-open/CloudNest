import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { makeProviderQueries } from '../src/db/provider-queries.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { ProviderAccountService } from '../src/services/provider-account-service.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-svc-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const service = new ProviderAccountService(db, makeProviderQueries(db), store);
  return { db, close, store, service, dir };
}

const gBundle = (token: string) => ({
  schemaVersion: 1 as const,
  provider: 'google_drive' as const,
  accessToken: token,
  refreshToken: 'refresh',
  grantedScopes: ['https://www.googleapis.com/auth/drive.file'],
});

test('connect stores credentials encrypted; plaintext token is never in the DB bytes', () => {
  const { db, close, service } = setup();
  try {
    const token = 'ya29.SUPER-SECRET-TOKEN-VALUE';
    const { row } = service.upsertConnection({
      provider: 'google_drive',
      account: { providerAccountId: 'perm-1', displayLabel: 'a@example.com', quota: { totalBytes: 1000, usedBytes: 100, status: 'current' } },
      bundle: gBundle(token),
    });
    assert.equal(row.status, 'connected');
    assert.equal(row.quota_status, 'current');
    const raw = db.prepare('SELECT credential_ciphertext FROM provider_accounts WHERE id = ?').get(row.id) as { credential_ciphertext: Buffer };
    assert.ok(!raw.credential_ciphertext.toString('utf8').includes(token));
    // round-trips back
    const loaded = service['store'].loadAccountBundle(row);
    assert.equal(loaded?.provider, 'google_drive');
  } finally {
    close();
  }
});

test('duplicate identity reconnects the same row instead of creating a second', () => {
  const { close, service } = setup();
  try {
    const first = service.upsertConnection({
      provider: 'google_drive',
      account: { providerAccountId: 'perm-1', displayLabel: 'a@example.com', quota: { totalBytes: 1000, usedBytes: 100, status: 'current' } },
      bundle: gBundle('t1'),
    });
    const second = service.upsertConnection({
      provider: 'google_drive',
      account: { providerAccountId: 'perm-1', displayLabel: 'a@example.com', quota: { totalBytes: 2000, usedBytes: 200, status: 'current' } },
      bundle: gBundle('t2'),
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.reconnected, true);
    assert.equal(service.list().length, 1);
    assert.equal(second.row.quota_total_bytes, 2000);
  } finally {
    close();
  }
});

test('quota-only failure keeps the account connected and marks quota unknown/stale', () => {
  const { close, service } = setup();
  try {
    const { row } = service.upsertConnection({
      provider: 'dropbox',
      account: { providerAccountId: 'dbx-1', displayLabel: 'b@example.com', quota: { totalBytes: 500, usedBytes: 50, status: 'current' } },
      bundle: { schemaVersion: 1, provider: 'dropbox', accessToken: 't', refreshToken: 'r', grantedScopes: ['files.content.read'] },
    });
    const updated = service.applyQuotaResult(row.id, { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' });
    assert.equal(updated.status, 'connected', 'auth state unchanged');
    assert.equal(updated.quota_status, 'stale', 'prior data existed -> stale');
    assert.equal(updated.quota_total_bytes, 500, 'prior values preserved');
    assert.equal(updated.last_quota_error_code, 'quota_unavailable');
    assert.equal(updated.last_error_code, null, 'auth error state not overwritten by quota failure');
  } finally {
    close();
  }
});

test('refresh_token_missing does not create a normal connected account', () => {
  const { close, service } = setup();
  try {
    const { row } = service.upsertConnection({
      provider: 'google_drive',
      account: {
        providerAccountId: 'perm-2',
        displayLabel: 'c@example.com',
        quota: { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' },
        safeErrorCode: 'refresh_token_missing',
      },
      bundle: { schemaVersion: 1, provider: 'google_drive', accessToken: 'short-lived', grantedScopes: [] },
    });
    assert.equal(row.status, 'needs_reauth');
  } finally {
    close();
  }
});

test('rename and reserve update metadata only', () => {
  const { close, service } = setup();
  try {
    const { row } = service.upsertConnection({
      provider: 'pcloud',
      account: { providerAccountId: 'pc-1', displayLabel: 'd@example.com', quota: { totalBytes: 10, usedBytes: 1, status: 'current' } },
      bundle: { schemaVersion: 1, provider: 'pcloud', accessToken: 't', apiHost: 'api.pcloud.com', userId: 'pc-1' },
    });
    assert.equal(service.rename(row.id, 'My pCloud').display_label, 'My pCloud');
    assert.equal(service.updateReserve(row.id, 1024).reserve_bytes, 1024);
  } finally {
    close();
  }
});

test('disconnect erases local credentials but preserves the account row and metadata', async () => {
  const { close, service } = setup();
  try {
    const { row } = service.upsertConnection({
      provider: 'google_drive',
      account: { providerAccountId: 'perm-3', displayLabel: 'e@example.com', quota: { totalBytes: 100, usedBytes: 10, status: 'current' } },
      bundle: gBundle('token-to-erase'),
    });
    await service.disconnect(row.id);
    const after = service.get(row.id);
    assert.ok(after);
    assert.equal(after.status, 'disconnected');
    assert.equal(after.credential_ciphertext, null, 'credentials erased');
    assert.equal(after.account_identifier, 'perm-3', 'identity preserved');
    assert.equal(after.display_label, 'e@example.com', 'label preserved');
    assert.equal(after.quota_total_bytes, 100, 'quota metadata preserved');
  } finally {
    close();
  }
});

test('loadAccountBundle fails if the credential blob is corrupted', () => {
  const { db, close, store, service } = setup();
  try {
    const { row } = service.upsertConnection({
      provider: 'dropbox',
      account: { providerAccountId: 'dbx-2', displayLabel: 'f@example.com', quota: { totalBytes: null, usedBytes: null, status: 'unknown' } },
      bundle: { schemaVersion: 1, provider: 'dropbox', accessToken: 't', grantedScopes: [] },
    });
    db.prepare('UPDATE provider_accounts SET credential_auth_tag = ? WHERE id = ?').run(Buffer.alloc(16), row.id);
    const fresh = service.get(row.id)!;
    assert.throws(() => store.loadAccountBundle(fresh));
  } finally {
    close();
  }
});

test('provider config round-trips and never stores plaintext secret', () => {
  const { db, close, store } = setup();
  try {
    store.saveAppConfig('dropbox', { provider: 'dropbox', clientId: 'cid-123', clientSecret: 'SUPER-SECRET-SECRET' }, 'saved', null);
    const raw = db.prepare("SELECT config_ciphertext FROM provider_app_configs WHERE provider='dropbox'").get() as { config_ciphertext: Buffer };
    assert.ok(!raw.config_ciphertext.toString('utf8').includes('SUPER-SECRET-SECRET'));
    const loaded = store.getConfig('dropbox');
    assert.equal(loaded?.config.clientSecret, 'SUPER-SECRET-SECRET');
    // also not in app_settings
    const settings = db.prepare('SELECT COUNT(*) n FROM app_settings').get() as { n: number };
    assert.equal(settings.n, 0);
  } finally {
    close();
  }
});
