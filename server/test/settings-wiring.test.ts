import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocateChunks, assessCapacity, type AccountCapacityInput } from '../src/uploads/capacity.js';
import { compareProviderChecksum } from '../src/uploads/upload-service.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { SettingsService } from '../src/settings/settings-service.js';

/**
 * M12.a settings wiring (server side).
 *
 * These tests exist because a review proved the Settings page saved values that
 * NO engine ever read. Each test below fails if the corresponding setting stops
 * taking effect.
 */

const MIB = 1024 * 1024;

function acct(over: Partial<AccountCapacityInput> = {}): AccountCapacityInput {
  return {
    accountId: 'acc-1',
    provider: 'google_drive',
    displayLabel: 'a@example.com',
    status: 'connected',
    quotaStatus: 'current',
    quotaTotalBytes: 100 * MIB,
    quotaUsedBytes: 10 * MIB,
    reserveBytes: 0,
    outstandingReservationBytes: 0,
    ...over,
  };
}

const chunks = [
  { chunkIndex: 0, offsetBytes: 0, sizeBytes: 8 * MIB },
  { chunkIndex: 1, offsetBytes: 8 * MIB, sizeBytes: 8 * MIB },
  { chunkIndex: 2, offsetBytes: 16 * MIB, sizeBytes: 8 * MIB },
  { chunkIndex: 3, offsetBytes: 24 * MIB, sizeBytes: 8 * MIB },
];

test('upload.spaceAwareRouting ON keeps the V1 rule: fill the largest account first', () => {
  const eligible = assessCapacity([
    acct({ accountId: 'big', quotaTotalBytes: 100 * MIB, quotaUsedBytes: 0 }),
    acct({ accountId: 'small', quotaTotalBytes: 40 * MIB, quotaUsedBytes: 0 }),
  ]).eligible;

  const assignments = allocateChunks(chunks, eligible, 'capacity-aware');
  assert.ok(assignments, 'a plan exists');
  const used = new Set(assignments!.map((a) => a.accountId));
  assert.deepEqual([...used], ['big'], 'the largest account absorbs every chunk while it has room');
});

test('upload.spaceAwareRouting OFF spreads chunks across accounts without exceeding any budget', () => {
  const eligible = assessCapacity([
    acct({ accountId: 'big', quotaTotalBytes: 100 * MIB, quotaUsedBytes: 0 }),
    acct({ accountId: 'small', quotaTotalBytes: 40 * MIB, quotaUsedBytes: 0 }),
  ]).eligible;

  const assignments = allocateChunks(chunks, eligible, 'balanced');
  assert.ok(assignments, 'a plan exists');
  const counts = new Map<string, number>();
  for (const a of assignments!) counts.set(a.accountId, (counts.get(a.accountId) ?? 0) + 1);
  assert.ok((counts.get('small') ?? 0) >= 1, 'the smaller account is actually used, not left idle');
  assert.ok((counts.get('big') ?? 0) >= 1, 'the larger account is still used');

  // the hard budget rule survives the strategy change
  const perAccount = new Map<string, number>();
  for (const a of assignments!) perAccount.set(a.accountId, (perAccount.get(a.accountId) ?? 0) + a.sizeBytes);
  for (const account of eligible) {
    assert.ok(
      (perAccount.get(account.accountId) ?? 0) <= account.usableBytes,
      `account ${account.accountId} is never assigned more than its usable bytes`,
    );
  }
});

test('balanced routing still fails closed when a chunk fits nowhere', () => {
  const eligible = assessCapacity([
    acct({ accountId: 'tiny', quotaTotalBytes: 12 * MIB, quotaUsedBytes: 0 }),
  ]).eligible;
  const tooMany = [
    { chunkIndex: 0, offsetBytes: 0, sizeBytes: 8 * MIB },
    { chunkIndex: 1, offsetBytes: 8 * MIB, sizeBytes: 8 * MIB },
  ];
  assert.equal(allocateChunks(tooMany, eligible, 'balanced'), null, 'no partial reservation is allowed');
  assert.equal(allocateChunks(tooMany, eligible, 'capacity-aware'), null);
});

test('upload.verifyIntegrity compares a provider checksum only when the algorithm is the same', () => {
  const ours = 'a'.repeat(64);
  assert.equal(
    compareProviderChecksum({ type: 'sha256', value: ours.toUpperCase() }, ours),
    'match',
    'the same algorithm and value verifies',
  );
  assert.equal(
    compareProviderChecksum({ type: 'sha256', value: 'b'.repeat(64) }, ours),
    'mismatch',
    'the same algorithm with a different value is a real mismatch',
  );
  assert.equal(
    compareProviderChecksum({ type: 'dropbox_content_hash', value: 'f'.repeat(64) }, ours),
    'not-comparable',
    'Dropbox content_hash is not SHA-256',
  );
  assert.equal(
    compareProviderChecksum({ type: 'onedrive_quickxorhash', value: 'z'.repeat(28) }, ours),
    'not-comparable',
    'OneDrive quickXorHash is not SHA-256',
  );
  assert.equal(compareProviderChecksum(undefined, ours), 'not-comparable', 'no checksum means nothing to compare');
  assert.equal(compareProviderChecksum({ type: 'sha256' }, ours), 'not-comparable', 'a type without a value proves nothing');
});

test('an unknown vendor algorithm is never compared as if it were SHA-256', () => {
  for (const type of ['md5', 'crc32c', 'gdrive_md5', 'dropbox_content_hash', 'onedrive_quickxorhash']) {
    assert.equal(
      compareProviderChecksum({ type, value: 'deadbeef' }, 'deadbeef'),
      'not-comparable',
      `${type} must never be treated as SHA-256`,
    );
  }
});

test('effectiveChunkSizeMiB re-validates a hand-edited settings row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-chunk-'));
  try {
    const { db, close } = openDatabase(path.join(dir, 't.db'));
    runMigrations(db, allMigrations);
    const settings = new SettingsService(db);
    assert.equal(settings.effectiveChunkSizeMiB(), 64, 'the default stands with no row');
    db.prepare(
      "INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES ('upload.chunkSizeMiB', '37', ?)",
    ).run(new Date().toISOString());
    assert.equal(settings.effectiveChunkSizeMiB(), 64, 'a disallowed value falls back to the default');
    db.prepare("UPDATE app_settings SET value_json = '32' WHERE setting_key = 'upload.chunkSizeMiB'").run();
    assert.equal(settings.effectiveChunkSizeMiB(), 32, 'an allowed value still passes through');
    close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
