import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { UploadService, CapacityInsufficientError } from '../src/uploads/upload-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';

/**
 * Roadmap Phase 1 acceptance: tier isolation (a business file can never land
 * on a personal OAuth pool and vice versa), the owner-set capacity cap for
 * S3-compatible accounts, and honest CloudNest-tracked byte accounting.
 * Everything runs on temp databases with synthetic rows; no network.
 */

const MIB = 1024 * 1024;
const KEY = 'tier-key-0001';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tier-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, tier,
      quota_total_bytes, used_bytes, quota_status, capacity_cap_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'acc-personal', 'google_drive', 'Personal Drive', 'ident-p', 'personal',
    100 * MIB, 0, 'current', null, now, now,
  );
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, tier,
      quota_total_bytes, used_bytes, quota_status, capacity_cap_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'acc-business', 's3', 'Business bucket', 'bucket@r2.example', 'business',
    null, null, 'current', 50 * MIB, now, now,
  );
  const store = new CredentialsStore(db, dir);
  const service = new UploadService(db, store);
  return { db, close, service, dir };
}

function allocationsOn(result: { allocations: Array<{ accountId: string }> }): string[] {
  return [...new Set(result.allocations.map((a) => a.accountId))];
}

test('a business plan allocates only on the business (S3) pool', () => {
  const { db, close, service } = setup();
  try {
    const plan = service.plan({
      originalName: 'biz.bin', sizeBytes: 20 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY, tier: 'business',
    });
    assert.deepEqual(allocationsOn(plan), ['acc-business'], 'every chunk went to the business pool');
    const file = db.prepare('SELECT tier FROM files WHERE id = ?').get(plan.fileId) as { tier: string };
    assert.equal(file.tier, 'business');
  } finally {
    close();
  }
});

test('a personal plan never touches the business pool (and defaults to personal)', () => {
  const { db, close, service } = setup();
  try {
    const explicit = service.plan({
      originalName: 'home.bin', sizeBytes: 20 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-personal', tier: 'personal',
    });
    assert.deepEqual(allocationsOn(explicit), ['acc-personal']);
    const implicit = service.plan({
      originalName: 'home2.bin', sizeBytes: 20 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-personal-2',
    });
    assert.deepEqual(allocationsOn(implicit), ['acc-personal'], 'a missing tier defaults to personal');
    const file = db.prepare('SELECT tier FROM files WHERE id = ?').get(implicit.fileId) as { tier: string };
    assert.equal(file.tier, 'personal');
  } finally {
    close();
  }
});

test('a business file is refused when it exceeds the owner-set bucket cap (honest preflight)', () => {
  const { close, service } = setup();
  try {
    // cap is 50 MiB: a 60 MiB plan must fail with the real shortfall
    try {
      service.plan({ originalName: 'big.bin', sizeBytes: 60 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-cap', tier: 'business' });
      assert.fail('the plan should have been refused');
    } catch (err) {
      assert.ok(err instanceof CapacityInsufficientError);
      assert.equal(err.detail.shortfallBytes, 10 * MIB, 'the shortfall is reported truthfully');
      const business = err.detail.accounts.find((a) => a.label === 'Business bucket');
      assert.equal(business?.usableBytes, 50 * MIB, 'the capped bucket offers exactly its cap');
    }
  } finally {
    close();
  }
});

test('committed chunk bytes are tracked immediately: free space shrinks without any refresh', () => {
  const { close, service } = setup();
  try {
    const plan = service.plan({
      originalName: 'first.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-track-1', tier: 'business',
    });
    const allocation = plan.allocations[0]!;
    const attempt = service.beginAttempt({ jobId: plan.jobId, chunkIndex: allocation.chunkIndex, accountId: allocation.accountId });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: allocation.chunkIndex, accountId: allocation.accountId,
      objectKey: attempt.objectKey, remoteObjectId: 'remote-1', sha256: 'a'.repeat(64), sizeBytes: 8 * MIB,
    });
    // cap 50 MiB, tracked used 8 MiB (nothing else reserved) → 42 MiB usable
    assert.throws(
      () => service.plan({ originalName: 'second.bin', sizeBytes: 45 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-track-2', tier: 'business' }),
      (err: unknown) => err instanceof CapacityInsufficientError && err.detail.shortfallBytes === 3 * MIB,
      'the tracked bytes reduce usable space at once',
    );
    // and a fitting plan still succeeds
    const fits = service.plan({ originalName: 'third.bin', sizeBytes: 42 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-track-3', tier: 'business' });
    assert.deepEqual(allocationsOn(fits), ['acc-business']);
  } finally {
    close();
  }
});

test('an uncapped S3-compatible account is excluded (never treated as infinite space)', () => {
  const { db, close, service } = setup();
  try {
    db.prepare('UPDATE provider_accounts SET capacity_cap_bytes = NULL WHERE id = ?').run('acc-business');
    assert.throws(
      () => service.plan({ originalName: 'x.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-nocap', tier: 'business' }),
      (err: unknown) => err instanceof CapacityInsufficientError,
      'no cap means no known capacity — never an invented number',
    );
  } finally {
    close();
  }
});

test('the same idempotency key cannot silently switch tiers', () => {
  const { close, service } = setup();
  try {
    service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-switch', tier: 'business' });
    assert.throws(
      () => service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k-switch', tier: 'personal' }),
      (err: unknown) => (err as { safeCode?: string }).safeCode === 'idempotency_key_reused',
    );
  } finally {
    close();
  }
});
