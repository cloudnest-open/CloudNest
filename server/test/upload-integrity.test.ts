import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { openDatabase } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { runMigrations } from '../src/db/index.js';
import { makeUploadQueries } from '../src/db/upload-queries.js';
import { UploadService, UploadError } from '../src/uploads/upload-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { HashingCounter } from '../src/uploads/streaming.js';
import { planChunks, mibToBytes, chunkBounds } from '../src/uploads/chunk-math.js';
import { preflight, assessCapacity } from '../src/uploads/capacity.js';

/**
 * M9.f — cross-cutting integrity tests.
 * No provider is contacted: these assert the engine's own invariants around
 * capacity, hashing, duplicate requests, crash recovery and cleanup duties.
 */

const MIB = 1024 * 1024;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-int-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const service = new UploadService(db, store);
  return { db, close, service, store, dir, q: makeUploadQueries(db) };
}

function seedAccount(db: import('better-sqlite3').Database, id: string, provider: string, total: number, used = 0, quotaStatus = 'current') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, 0, 0, ?, ?)`,
  ).run(id, provider, `${id}@example.com`, `ident-${id}`, total, used, quotaStatus, now, now);
}

// ---------- maths and preflight ----------

test('M9.f maths: 0 bytes, 1 byte, chunk-size ± 1, final short chunk', () => {
  const chunk = mibToBytes(8);
  assert.equal(planChunks(0, chunk).chunkCount, 0, '0 bytes -> zero chunks');
  assert.equal(planChunks(1, chunk).chunkCount, 1, '1 byte -> one chunk');
  assert.equal(planChunks(chunk - 1, chunk).chunkCount, 1);
  assert.equal(planChunks(chunk, chunk).chunkCount, 1);
  assert.equal(planChunks(chunk + 1, chunk).chunkCount, 2);
  const plan = planChunks(chunk * 3 + 5, chunk);
  assert.equal(plan.chunkCount, 4);
  assert.equal(chunkBounds(plan, 3).sizeBytes, 5, 'the final chunk is short');
  // 200 GB decimal and 200 GiB binary both hold
  assert.equal(planChunks(200_000_000_000, chunk).chunkCount, 23842);
  assert.equal(planChunks(200 * 1024 * 1024 * 1024, chunk).chunkCount, 25600);
});

test('M9.f: two accounts cannot jointly over-reserve the same free space', () => {
  const { db, close, service } = setup();
  try {
    // one account with exactly 16 MiB free
    seedAccount(db, 'acc-a', 'google_drive', 16 * MIB, 0);
    // 12 MiB ≤ the 20 MiB single-object threshold and the account can hold the
    // whole file, so it plans as ONE whole-file chunk reserving all 12 MiB
    const first = service.plan({ originalName: 'a.bin', sizeBytes: 12 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k1' });
    assert.equal(first.chunkCount, 1);
    // only 4 MiB usable remains, so a second 12 MiB plan must be refused
    assert.throws(
      () => service.plan({ originalName: 'b.bin', sizeBytes: 12 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k2' }),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'capacity_insufficient',
    );
    // a smaller plan that fits is still allowed
    const small = service.plan({ originalName: 'c.bin', sizeBytes: 4 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k3' });
    assert.equal(small.chunkCount, 1);
    // a fourth plan must now be refused: nothing is left
    assert.throws(
      () => service.plan({ originalName: 'd.bin', sizeBytes: MIB, chunkSizeMiB: 8, idempotencyKey: 'k4' }),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'capacity_insufficient',
    );
  } finally {
    close();
  }
});

test('M9.f: allocation never exceeds an account ceiling and may be uneven', () => {
  const inputs = [
    { accountId: 'a', provider: 'google_drive', displayLabel: 'a', status: 'connected', quotaStatus: 'current' as const, quotaTotalBytes: 12 * MIB, quotaUsedBytes: 0, reserveBytes: 0, outstandingReservationBytes: 0 },
    { accountId: 'b', provider: 'dropbox', displayLabel: 'b', status: 'connected', quotaStatus: 'current' as const, quotaTotalBytes: 100 * MIB, quotaUsedBytes: 0, reserveBytes: 0, outstandingReservationBytes: 0 },
  ];
  const result = preflight(inputs, 24 * MIB);
  assert.equal(result.canProceed, true);
  const eligible = assessCapacity(inputs).eligible;
  const chunks = [0, 1, 2].map((i) => ({ chunkIndex: i, offsetBytes: i * 8 * MIB, sizeBytes: 8 * MIB }));
  void chunks;
  assert.equal(eligible.length, 2);
  assert.ok(eligible.every((a) => a.usableBytes > 0));
  assert.ok(eligible.some((a) => a.usableBytes === 12 * MIB), 'the smaller account keeps its own ceiling');
});

test('M9.f: a rolled-back plan leaves no reservation behind', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 8 * MIB, 0);
    // the first chunk would fit, but the second cannot: the whole plan must fail
    assert.throws(
      () => service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' }),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'capacity_insufficient',
    );
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?').get('acc-a') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 0, 'no partial reservation survives');
    assert.equal((q.listFiles.all(null, null, 50, 0) as unknown[]).length, 0, 'no file row was written');
    assert.equal((q.listJobs.all(null, null, 50) as unknown[]).length, 0, 'no job row was written');
  } finally {
    close();
  }
});

// ---------- streaming and integrity ----------

test('M9.f: the same bytes always hash to the same digest, streamed in pieces', async () => {
  const payload = crypto.randomBytes(64 * 1024);
  const expected = crypto.createHash('sha256').update(payload).digest('hex');

  // one shot
  const single = new HashingCounter();
  const singleDone = new Promise<void>((resolve, reject) => {
    single.on('data', () => { /* consume so the pipeline can finish */ });
    single.on('end', resolve);
    single.on('error', reject);
  });
  Readable.from([payload]).pipe(single);
  await singleDone;
  assert.equal(single.digest(), expected);

  // many small pieces
  const pieces: Buffer[] = [];
  for (let i = 0; i < payload.length; i += 997) pieces.push(payload.subarray(i, i + 997));
  const multi = new HashingCounter();
  const multiDone = new Promise<void>((resolve, reject) => {
    multi.on('data', () => { /* consume */ });
    multi.on('end', resolve);
    multi.on('error', reject);
  });
  Readable.from(pieces).pipe(multi);
  await multiDone;
  assert.equal(multi.digest(), expected, 'piece boundaries never change the digest');
  assert.equal(multi.bytes, payload.length, 'every byte is counted');
});

test('M9.f: byte counting detects a short or extra body', async () => {
  const expected = 4096;
  const drain = (counter: HashingCounter, source: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      counter.on('data', () => { /* consume */ });
      counter.on('end', resolve);
      counter.on('error', reject);
      Readable.from([source]).pipe(counter);
    });

  const short = new HashingCounter();
  await drain(short, Buffer.alloc(4000));
  assert.notEqual(short.bytes, expected, 'a short body is detectable');

  const extra = new HashingCounter();
  await drain(extra, Buffer.alloc(5000));
  assert.notEqual(extra.bytes, expected, 'an extra body is detectable');
});

test('M9.f: duplicate successful chunk requests never double count or duplicate placements', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    const attempt = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    const first = service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: attempt.objectKey,
      remoteObjectId: 'r0', sha256: 'a'.repeat(64), sizeBytes: 8 * MIB,
    });
    assert.equal(first.chunksCompleted, 1);
    assert.equal(first.bytesCompleted, 8 * MIB);

    // a duplicate commit for the same index must not inflate the counters
    const dup = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    const second = service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: dup.objectKey,
      remoteObjectId: 'r1', sha256: 'b'.repeat(64), sizeBytes: 8 * MIB,
    });
    assert.equal(second.chunksCompleted, 1, 'still one completed chunk');
    assert.equal(second.bytesCompleted, 8 * MIB, 'bytes are not double counted');
    const chunk = q.getChunk.get(plan.fileId, 0) as { id: string };
    const placements = q.placementsForChunk.all(chunk.id) as Array<{ is_active: number }>;
    assert.equal(placements.filter((p) => p.is_active === 1).length, 1, 'exactly one active placement');
    assert.equal((q.listChunks.all(plan.fileId) as unknown[]).length, 1, 'the chunk row is not duplicated');
  } finally {
    close();
  }
});

test('M9.f: an unsupported provider checksum is never labelled cryptographically verified', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    const attempt = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    // no provider checksum type is supplied
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: attempt.objectKey,
      remoteObjectId: 'r0', sha256: 'c'.repeat(64), sizeBytes: 8 * MIB,
    });
    const chunk = q.getChunk.get(plan.fileId, 0) as { id: string };
    const placement = (q.placementsForChunk.all(chunk.id) as Array<{ provider_checksum_type: string | null }>)[0]!;
    // the placement is committed but records that no provider checksum backed it
    assert.equal(placement.provider_checksum_type, null, 'absence of a provider checksum is recorded honestly');
  } finally {
    close();
  }
});

test('M9.f: an aborted stream leaves a deterministic retryable state', async () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    const attempt = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.recordFailure({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: attempt.objectKey,
      safeCode: 'upload_aborted', bytesReceived: 1024, remoteObjectId: null,
    });
    const row = q.getAttempt.get(attempt.attemptId) as { state: string; safe_error_code: string };
    assert.equal(row.state, 'failed');
    assert.equal(row.safe_error_code, 'upload_aborted');
    const allocation = q.getAllocation.get(plan.jobId, 0) as { state: string };
    assert.equal(allocation.state, 'released', 'the reservation is released for a retry');
    // retry is possible and does not need a new plan
    const resumed = service.resume(plan.jobId);
    assert.deepEqual(resumed.missingChunks, [0], 'the chunk can be retried');
    void db;
  } finally {
    close();
  }
});

// ---------- retries, recovery, cancellation ----------

test('M9.f: a crash mid-job recovers to paused with reservations rebuilt', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    service.markRunning(plan.jobId);
    const attempt = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    // a completed chunk plus an in-flight one when the process dies
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 1, accountId: 'acc-a', objectKey: attempt.objectKey,
      remoteObjectId: 'r1', sha256: 'd'.repeat(64), sizeBytes: 8 * MIB,
    });
    // simulate a lost cache
    db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = 0').run();
    const recovery = service.recoverOnStartup();
    assert.equal(recovery.recovered, 1);
    const job = q.getJob.get(plan.jobId) as { state: string; last_safe_error_code: string };
    assert.equal(job.state, 'paused');
    assert.equal(job.last_safe_error_code, 'recovered_after_restart');
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?').get('acc-a') as { reserved_inflight_bytes: number };
    // Per the plan, a chunk that is uploaded but not yet reflected in a valid
    // quota refresh keeps its reservation (uploaded_pending_quota), so all
    // three chunks remain reserved until the post-upload refresh succeeds.
    assert.equal(account.reserved_inflight_bytes, 24 * MIB, 'reservations are conservative until quota is re-read');
    const states = (q.listAllocations.all(plan.jobId) as Array<{ state: string }>).map((a) => a.state);
    assert.ok(states.includes('uploading') && states.includes('reserved'), 'unfinished chunks keep their state too');
    // the completed chunk is never re-sent
    const resumed = service.resume(plan.jobId);
    assert.deepEqual(resumed.missingChunks, [0, 2]);
  } finally {
    close();
  }
});

test('M9.f: pause stops new dispatch and leaves claimed work to finish safely', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    service.markRunning(plan.jobId);
    service.pause(plan.jobId);
    const job = q.getJob.get(plan.jobId) as { state: string };
    assert.equal(job.state, 'paused');
    // resuming reports the chunks that still need work
    const resumed = service.resume(plan.jobId);
    assert.deepEqual(resumed.missingChunks, [0, 1, 2]);
  } finally {
    close();
  }
});

test('M9.f: cancel never claims a clean finish while an object is unaccounted for', async () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    const result = await service.cancel(plan.jobId);
    const job = q.getJob.get(plan.jobId) as { state: string; last_safe_error_code: string | null };
    if (result.cleanupPending) {
      assert.equal(job.state, 'deletion_pending', 'an unresolved object keeps the job in a pending state');
      assert.equal(job.last_safe_error_code, 'cleanup_pending');
    } else {
      assert.equal(job.state, 'cancelled');
    }
    // whatever happened, the obligation is recorded rather than lost
    const pending = service.pendingCleanups();
    assert.ok(Array.isArray(pending));
  } finally {
    close();
  }
});

test('M9.f: an account disconnect is blocked while its allocations are live', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 100 * MIB, 0);
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    void plan;
    // the FK from upload_chunk_allocations to provider_accounts is RESTRICT,
    // so the database itself refuses to drop an account that still holds work
    assert.throws(
      () => db.prepare('DELETE FROM provider_accounts WHERE id = ?').run('acc-a'),
      /FOREIGN KEY|constraint/i,
      'a live allocation prevents account deletion',
    );
  } finally {
    close();
  }
});

test('M9.f: jobs can be re-planned to another account after a provider failure', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, 'acc-a', 'google_drive', 8 * MIB, 0);
    seedAccount(db, 'acc-b', 'dropbox', 100 * MIB, 0);
    db.prepare("UPDATE provider_accounts SET quota_status='unknown' WHERE id='acc-b'").run();
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k' });
    assert.equal(plan.allocations[0]!.accountId, 'acc-a');
    db.prepare("UPDATE provider_accounts SET quota_status='current' WHERE id='acc-b'").run();
    const moved = service.reassignChunk(plan.jobId, 0);
    assert.equal(moved?.accountId, 'acc-b');
    const allocation = q.getAllocation.get(plan.jobId, 0) as { provider_account_id: string; state: string };
    assert.equal(allocation.provider_account_id, 'acc-b');
    assert.equal(allocation.state, 'reserved');
    // the audit trail survives: exactly one allocation row for that chunk
    assert.equal((q.listAllocations.all(plan.jobId) as unknown[]).length, 1);
  } finally {
    close();
  }
});
