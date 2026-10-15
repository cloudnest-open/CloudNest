import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { makeProviderQueries } from '../src/db/provider-queries.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { ProviderAccountService } from '../src/services/provider-account-service.js';
import { installTestAdapter, clearTestAdapters } from '../src/providers/registry.js';
import { makeFakeAdapter } from './fake-adapter.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * Task §4.A + §4.B — same-provider multi-account connection/identity and
 * per-account isolation, exercised against the REAL service layer with mocked
 * adapters only. No live provider credentials are used anywhere here.
 */

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sp-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const service = new ProviderAccountService(db, makeProviderQueries(db), store);
  return { db, close, store, service, dir };
}

function bundle(provider: 'google_drive' | 'dropbox' | 'onedrive', token: string): ProviderCredentialBundle {
  if (provider === 'onedrive') {
    return { schemaVersion: 1, provider: 'onedrive', accessToken: token, refreshToken: `refresh-${token}`, authority: 'common', grantedScopes: [] };
  }
  if (provider === 'dropbox') {
    return { schemaVersion: 1, provider: 'dropbox', accessToken: token, refreshToken: `refresh-${token}`, grantedScopes: [] };
  }
  return { schemaVersion: 1, provider: 'google_drive', accessToken: token, refreshToken: `refresh-${token}`, grantedScopes: [] };
}

function pcloudBundle(userId: string): ProviderCredentialBundle {
  return { schemaVersion: 1, provider: 'pcloud', accessToken: `tok-${userId}`, apiHost: 'api.pcloud.com', userId };
}

function megaBundle(email: string): ProviderCredentialBundle {
  return { schemaVersion: 1, provider: 'mega', email, password: 'fake-test-only-password' };
}

const quota = { totalBytes: 1000, usedBytes: 100, status: 'current' as const };

test('A1: two distinct Google Drive identities create two independent accounts', () => {
  const { close, service } = setup();
  try {
    const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'a@x', quota }, bundle: bundle('google_drive', 'tok-A') });
    const b = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'b@x', quota }, bundle: bundle('google_drive', 'tok-B') });
    assert.notEqual(a.row.id, b.row.id, 'separate internal account IDs');
    assert.notEqual(a.row.account_identifier, b.row.account_identifier);
    assert.equal(service.list().length, 2);
  } finally {
    close();
  }
});

test('A2: the same holds for Dropbox, OneDrive, pCloud and MEGA identity paths', () => {
  const { close, service } = setup();
  try {
    const pairs: Array<{ provider: 'dropbox' | 'onedrive' | 'pcloud' | 'mega'; idA: string; idB: string; bA: ProviderCredentialBundle; bB: ProviderCredentialBundle }> = [
      { provider: 'dropbox', idA: 'dbx-A', idB: 'dbx-B', bA: bundle('dropbox', 'tok-A'), bB: bundle('dropbox', 'tok-B') },
      { provider: 'onedrive', idA: 'od-A', idB: 'od-B', bA: bundle('onedrive', 'tok-A'), bB: bundle('onedrive', 'tok-B') },
      { provider: 'pcloud', idA: '7', idB: '8', bA: pcloudBundle('A'), bB: pcloudBundle('B') },
      { provider: 'mega', idA: 'a@mega', idB: 'b@mega', bA: megaBundle('a@mega'), bB: megaBundle('b@mega') },
    ];
    for (const p of pairs) {
      const a = service.upsertConnection({ provider: p.provider, account: { providerAccountId: p.idA, displayLabel: `${p.idA}@x`, quota }, bundle: p.bA });
      const b = service.upsertConnection({ provider: p.provider, account: { providerAccountId: p.idB, displayLabel: `${p.idB}@x`, quota }, bundle: p.bB });
      assert.notEqual(a.row.id, b.row.id, `${p.provider}: distinct rows for distinct identities`);
      const rows = service.list().filter((r) => r.provider === p.provider);
      assert.equal(rows.length, 2, `${p.provider}: both accounts listed`);
    }
  } finally {
    close();
  }
});

test('A3: connecting the same external identity again updates its existing record', () => {
  const { close, service } = setup();
  try {
    const first = service.upsertConnection({ provider: 'dropbox', account: { providerAccountId: 'dbx-1', displayLabel: 'same@x', quota }, bundle: bundle('dropbox', 'tok-1') });
    const again = service.upsertConnection({ provider: 'dropbox', account: { providerAccountId: 'dbx-1', displayLabel: 'same@x', quota: { totalBytes: 2000, usedBytes: 20, status: 'current' } }, bundle: bundle('dropbox', 'tok-1b') });
    assert.equal(again.row.id, first.row.id);
    assert.equal(again.reconnected, true);
    assert.equal(service.list().length, 1, 'no duplicate row');
    const loaded = service['store'].loadAccountBundle(service.get(first.row.id)!);
    assert.equal(loaded && 'accessToken' in loaded ? loaded.accessToken : '', 'tok-1b', 'credentials replaced on the same record');
  } finally {
    close();
  }
});

test('A4: connecting a second identity never overwrites the first account', () => {
  const { close, store, service } = setup();
  try {
    const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'first@x', quota: { totalBytes: 1111, usedBytes: 11, status: 'current' } }, bundle: bundle('google_drive', 'tok-A') });
    service.rename(a.row.id, 'My Drive');
    service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'second@x', quota: { totalBytes: 9999, usedBytes: 99, status: 'current' } }, bundle: bundle('google_drive', 'tok-B') });
    const after = service.get(a.row.id)!;
    assert.equal(after.display_label, 'My Drive', 'label untouched');
    assert.equal(after.quota_total_bytes, 1111, 'quota untouched');
    assert.equal(after.status, 'connected', 'status untouched');
    const aBundle = store.loadAccountBundle(after);
    assert.equal(aBundle && 'accessToken' in aBundle ? aBundle.accessToken : '', 'tok-A', 'credentials untouched');
  } finally {
    close();
  }
});

test('A5: listing returns every connected account record independently', () => {
  const { close, service } = setup();
  try {
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: id, displayLabel: `${id}@x`, quota }, bundle: bundle('google_drive', `tok-${id}`) });
    }
    const rows = service.list();
    assert.equal(rows.length, 5);
    assert.deepEqual(new Set(rows.map((r) => r.account_identifier)), new Set(['p1', 'p2', 'p3', 'p4', 'p5']));
  } finally {
    close();
  }
});

test('A6: renaming or quota-refreshing one account affects only that account', () => {
  const { close, service } = setup();
  try {
    const a = service.upsertConnection({ provider: 'onedrive', account: { providerAccountId: 'od-A', displayLabel: 'A@x', quota }, bundle: bundle('onedrive', 'tok-A') });
    const b = service.upsertConnection({ provider: 'onedrive', account: { providerAccountId: 'od-B', displayLabel: 'B@x', quota }, bundle: bundle('onedrive', 'tok-B') });
    service.rename(a.row.id, 'Renamed A');
    service.applyQuotaResult(b.row.id, { totalBytes: 5555, usedBytes: 5, status: 'current' });
    const aRow = service.get(a.row.id)!;
    const bRow = service.get(b.row.id)!;
    assert.equal(aRow.display_label, 'Renamed A');
    assert.equal(bRow.display_label, 'B@x', 'rename did not leak');
    assert.equal(aRow.quota_total_bytes, 1000, 'quota refresh did not leak');
    assert.equal(bRow.quota_total_bytes, 5555);
  } finally {
    close();
  }
});

test('A7: a reconnect for one identity cannot silently replace another account', () => {
  const { close, store, service } = setup();
  try {
    const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'A@x', quota }, bundle: bundle('google_drive', 'tok-A') });
    const b = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'B@x', quota }, bundle: bundle('google_drive', 'tok-B') });
    // reconnect flow resolves the identity from the provider, so a reconnect
    // for B carries B's identity — even if the user clicked "reconnect" on A
    const reconnectedB = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'B@x', quota }, bundle: bundle('google_drive', 'tok-B2') });
    assert.equal(reconnectedB.row.id, b.row.id, 'B reconnects B');
    assert.notEqual(reconnectedB.row.id, a.row.id);
    const aBundle = store.loadAccountBundle(service.get(a.row.id)!);
    const bBundle = store.loadAccountBundle(service.get(b.row.id)!);
    assert.equal(aBundle && 'accessToken' in aBundle ? aBundle.accessToken : '', 'tok-A', 'A credentials untouched');
    assert.equal(bBundle && 'accessToken' in bBundle ? bBundle.accessToken : '', 'tok-B2', 'B credentials replaced only on B');
  } finally {
    close();
  }
});

test('A8 (service level): interleaved upserts of distinct identities never merge', () => {
  const { close, service } = setup();
  try {
    // better-sqlite3 is synchronous, so Promise.all serializes deterministically;
    // the HTTP-level concurrent-callback race is covered in the e2e suite with a
    // delayed fake adapter.
    const results = [1, 2, 3, 4].map((n) =>
      service.upsertConnection({ provider: 'dropbox', account: { providerAccountId: `dbx-${n}`, displayLabel: `${n}@x`, quota }, bundle: bundle('dropbox', `tok-${n}`) }),
    );
    assert.equal(new Set(results.map((r) => r.row.id)).size, 4, 'four identities → four rows, zero merges');
  } finally {
    close();
  }
});

test('B: status/reauth marking is per account', () => {
  const { close, service } = setup();
  try {
    const a = service.upsertConnection({ provider: 'dropbox', account: { providerAccountId: 'dbx-A', displayLabel: 'A@x', quota }, bundle: bundle('dropbox', 'tok-A') });
    const b = service.upsertConnection({ provider: 'dropbox', account: { providerAccountId: 'dbx-B', displayLabel: 'B@x', quota }, bundle: bundle('dropbox', 'tok-B') });
    service.markNeedsReauth(a.row.id, 'needs_reauth');
    assert.equal(service.get(a.row.id)!.status, 'needs_reauth');
    assert.equal(service.get(b.row.id)!.status, 'connected', 'sibling account unaffected');
    service.markError(b.row.id, 'provider_unavailable');
    assert.equal(service.get(b.row.id)!.status, 'error');
    assert.equal(service.get(a.row.id)!.status, 'needs_reauth', 'error marking did not leak');
  } finally {
    close();
  }
});

test('B: quota failure isolation — one account goes stale, the other stays current', () => {
  const { close, service } = setup();
  try {
    const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'A@x', quota }, bundle: bundle('google_drive', 'tok-A') });
    const b = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'B@x', quota }, bundle: bundle('google_drive', 'tok-B') });
    service.applyQuotaResult(a.row.id, { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' });
    const aRow = service.get(a.row.id)!;
    const bRow = service.get(b.row.id)!;
    assert.equal(aRow.quota_status, 'stale');
    assert.equal(bRow.quota_status, 'current', 'sibling quota untouched');
  } finally {
    close();
  }
});

test('B: disconnecting one account leaves other same-provider accounts usable', async () => {
  const { close, store, service } = setup();
  try {
    // the disconnect path calls the adapter's revoke; use the fake so no
    // network is touched and the revoke deterministically succeeds
    const fake = makeFakeAdapter('google_drive');
    installTestAdapter('google_drive', fake.adapter);
    try {
      const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'A@x', quota }, bundle: bundle('google_drive', 'tok-A') });
      const b = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'B@x', quota }, bundle: bundle('google_drive', 'tok-B') });
      const result = await service.disconnect(a.row.id);
      assert.equal(result.revokedRemotely, true);
      const aRow = service.get(a.row.id)!;
      const bRow = service.get(b.row.id)!;
      assert.equal(aRow.status, 'disconnected');
      assert.equal(aRow.credential_ciphertext, null);
      assert.equal(bRow.status, 'connected', 'sibling still connected');
      assert.notEqual(bRow.credential_ciphertext, null, 'sibling credentials intact');
      const bBundle = store.loadAccountBundle(bRow);
      assert.equal(bBundle && 'accessToken' in bBundle ? bBundle.accessToken : '', 'tok-B', 'sibling still authenticates with its own token');
    } finally {
      clearTestAdapters();
    }
  } finally {
    close();
  }
});

test('B: per-account credential refresh writes only the refreshed account bundle', async () => {
  const { close, store, service } = setup();
  try {
    const fake = makeFakeAdapter('google_drive', { rotateRefreshFor: ['tok-A'] });
    installTestAdapter('google_drive', fake.adapter);
    try {
      const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'A@x', quota }, bundle: bundle('google_drive', 'tok-A') });
      const b = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'B@x', quota }, bundle: bundle('google_drive', 'tok-B') });
      // same code path the refresh route uses
      const refreshedA = await fake.adapter.ensureValidCredentials(store.loadAccountBundle(service.get(a.row.id)!)!);
      service.saveRefreshedBundle(service.get(a.row.id)!, refreshedA);
      const aLoaded = store.loadAccountBundle(service.get(a.row.id)!);
      const bLoaded = store.loadAccountBundle(service.get(b.row.id)!);
      assert.equal(aLoaded && 'refreshToken' in aLoaded ? aLoaded.refreshToken : '', 'refresh-tok-A-rotated', 'A rotated');
      assert.equal(bLoaded && 'refreshToken' in bLoaded ? bLoaded.refreshToken : '', 'refresh-tok-B', 'B untouched');
    } finally {
      clearTestAdapters();
    }
  } finally {
    close();
  }
});

test('B: credential blobs are AAD-bound per account — one account cannot decrypt the other', () => {
  const { close, store, service, db } = setup();
  try {
    const a = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-A', displayLabel: 'A@x', quota }, bundle: bundle('google_drive', 'tok-A') });
    const b = service.upsertConnection({ provider: 'google_drive', account: { providerAccountId: 'perm-B', displayLabel: 'B@x', quota }, bundle: bundle('google_drive', 'tok-B') });
    // copy A's ciphertext into B's row: decryption must fail (wrong AAD), so a
    // swapped credential blob can never silently authenticate as another account
    const aCred = db.prepare('SELECT credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version FROM provider_accounts WHERE id = ?').get(a.row.id) as Record<string, Buffer | number>;
    db.prepare('UPDATE provider_accounts SET credential_ciphertext = ?, credential_nonce = ?, credential_auth_tag = ?, credential_key_version = ? WHERE id = ?')
      .run(aCred.credential_ciphertext as Buffer, aCred.credential_nonce as Buffer, aCred.credential_auth_tag as Buffer, aCred.credential_key_version as number, b.row.id);
    assert.throws(() => store.loadAccountBundle(service.get(b.row.id)!), 'cross-account blob must not decrypt');
    const realA = service.get(a.row.id)!;
    assert.ok(store.loadAccountBundle(realA), 'the original account still decrypts');
  } finally {
    close();
  }
});
