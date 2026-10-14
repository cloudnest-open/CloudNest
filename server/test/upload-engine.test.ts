import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { makeUploadQueries } from '../src/db/upload-queries.js';
import { UploadService, UploadError, manifestHash } from '../src/uploads/upload-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { HashingCounter, assertByteCount, ByteCountMismatchError } from '../src/uploads/streaming.js';

const MIB = 1024 * 1024;

/** A deterministic fake provider so the engine can be tested end to end. */
function seedAccount(db: import('better-sqlite3').Database, opts: {
  id: string; provider: string; total: number; used: number;
  quotaStatus?: string; status?: string; reserve?: number;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.id, opts.provider, `${opts.id}@example.com`, `ident-${opts.id}`,
    opts.status ?? 'connected', opts.total, opts.used,
    opts.quotaStatus ?? 'current', opts.reserve ?? 0, now, now,
  );
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-up-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const service = new UploadService(db, store);
  return { db, close, store, service, dir, q: makeUploadQueries(db) };
}

const KEY = 'idem-key-0001';

test('plan creates a file, a job and one allocation per chunk — atomically', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({
      originalName: 'video.mp4', sizeBytes: 10 * MIB, chunkSizeMiB: 8, mimeType: 'video/mp4', idempotencyKey: KEY,
    });
    assert.equal(plan.chunkCount, 2);
    assert.equal(plan.chunkSizeBytes, 8 * MIB);
    assert.equal(plan.allocations.length, 2, 'one allocation per chunk');
    assert.deepEqual(plan.allocations.map((a) => a.sizeBytes), [8 * MIB, 2 * MIB], 'the final chunk is short');

    const job = q.getJob.get(plan.jobId) as { state: string; chunks_total: number };
    assert.equal(job.state, 'queued');
    assert.equal(job.chunks_total, 2);
    const file = q.getFile.get(plan.fileId) as { state: string; chunk_count: number };
    assert.equal(file.state, 'uploading');
    assert.equal(file.chunk_count, 2);
  } finally {
    close();
  }
});

test('usable capacity is reserved when the plan is created', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({
      originalName: 'a.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY,
    });
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?')
      .get('acc-a') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 10 * MIB, 'the whole file is reserved up front');
    const allocations = q.listAllocations.all(plan.jobId) as Array<{ state: string }>;
    assert.ok(allocations.every((a) => a.state === 'reserved'), 'every chunk is durably reserved before any bytes move');
  } finally {
    close();
  }
});

test('the same idempotency key with the same request returns the existing job', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const req = { originalName: 'a.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8 as const, idempotencyKey: KEY };
    const first = service.plan(req);
    const second = service.plan(req);
    assert.equal(second.jobId, first.jobId, 'no second job is created');
    assert.equal(second.reused, true);
    const jobs = service.listJobs();
    assert.equal(jobs.length, 1, 'exactly one job exists');
  } finally {
    close();
  }
});

test('the same key with different metadata is rejected as a reused key', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    service.plan({ originalName: 'a.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    assert.throws(
      () => service.plan({ originalName: 'different.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY }),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'idempotency_key_reused',
    );
  } finally {
    close();
  }
});

test('insufficient capacity stops the plan and reserves nothing', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 10 * MIB, used: 9 * MIB });
    assert.throws(
      () => service.plan({ originalName: 'big.bin', sizeBytes: 50 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY }),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'capacity_insufficient',
    );
    const jobs = q.listJobs.all(50) as unknown[];
    assert.equal(jobs.length, 0, 'no job was created');
    const files = q.listFiles.all(50, 0) as unknown[];
    assert.equal(files.length, 0, 'no file was created');
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?')
      .get('acc-a') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 0, 'nothing was reserved');
  } finally {
    close();
  }
});

test('an unknown-quota account cannot be used for automatic placement', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0, quotaStatus: 'unknown' });
    assert.throws(
      () => service.plan({ originalName: 'a.bin', sizeBytes: MIB, chunkSizeMiB: 8, idempotencyKey: KEY }),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'capacity_insufficient',
    );
  } finally {
    close();
  }
});

test('a disconnected or needs-reauth account is never allocated', () => {
  for (const status of ['disconnected', 'needs_reauth']) {
    const { db, close, service } = setup();
    try {
      seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0, status });
      assert.throws(
        () => service.plan({ originalName: 'a.bin', sizeBytes: MIB, chunkSizeMiB: 8, idempotencyKey: KEY }),
        (err: unknown) => err instanceof UploadError && err.safeCode === 'capacity_insufficient',
      );
    } finally {
      close();
    }
  }
});

test('an empty file completes immediately with zero chunks and no object', () => {
  const { db, close, service, q } = setup();
  try {
    const plan = service.plan({ originalName: 'empty.txt', sizeBytes: 0, chunkSizeMiB: 8, idempotencyKey: KEY });
    assert.equal(plan.chunkCount, 0);
    assert.deepEqual(plan.allocations, []);
    const job = q.getJob.get(plan.jobId) as { state: string };
    assert.equal(job.state, 'completed');
    const file = q.getFile.get(plan.fileId) as { state: string; manifest_hash: string };
    assert.equal(file.state, 'completed');
    assert.equal(file.manifest_hash, manifestHash([]), 'the manifest hash is still versioned');
  } finally {
    close();
  }
});

test('the M9.f reference arithmetic works through the real plan path', () => {
  const { db, close, service } = setup();
  try {
    // each reference plan needs its own capacity: the first plan reserves its
    // whole file size, so a second account is required for the second plan
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 400_000_000_000, used: 0 });
    seedAccount(db, { id: 'acc-b', provider: 'dropbox', total: 400_000_000_000, used: 0 });
    const decimal = service.plan({
      originalName: 'x.bin', sizeBytes: 200_000_000_000, chunkSizeMiB: 64, idempotencyKey: 'k-decimal',
    });
    assert.equal(decimal.chunkCount, 2981);
    const binary = service.plan({
      originalName: 'y.bin', sizeBytes: 200 * 1024 * 1024 * 1024, chunkSizeMiB: 64, idempotencyKey: 'k-binary',
    });
    assert.equal(binary.chunkCount, 3200);
  } finally {
    close();
  }
});

test('unsafe filenames are sanitised before they are stored', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({
      originalName: 'evil\r\nname.txt', sizeBytes: MIB, chunkSizeMiB: 8, idempotencyKey: KEY,
    });
    const file = q.getFile.get(plan.fileId) as { original_name: string };
    assert.equal(file.original_name, 'evilname.txt');
  } finally {
    close();
  }
});

test('attempts are recorded before any bytes are sent', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const { attemptId, objectKey } = service.beginAttempt({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a',
    });
    assert.ok(attemptId);
    assert.ok(objectKey.startsWith('cn-'), 'the object key is CloudNest-generated');
    const attempt = q.getAttempt.get(attemptId) as { state: string; object_key: string };
    assert.equal(attempt.state, 'uploading');
    assert.equal(attempt.object_key, objectKey);
    const allocation = q.getAllocation.get(plan.jobId, 0) as { state: string; attempt_count: number };
    assert.equal(allocation.state, 'uploading');
    assert.equal(allocation.attempt_count, 1);
  } finally {
    close();
  }
});

test('committing chunks completes the file and records a versioned manifest hash', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });

    const sha0 = crypto.createHash('sha256').update('chunk-0').digest('hex');
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    const r0 = service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'remote-0', sha256: sha0, sizeBytes: 8 * MIB,
    });
    assert.equal(r0.chunksCompleted, 1);
    assert.equal(r0.fileCompleted, false);

    const sha1 = crypto.createHash('sha256').update('chunk-1').digest('hex');
    const a1 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 1, accountId: 'acc-a' });
    const r1 = service.commitChunk({
      jobId: plan.jobId, chunkIndex: 1, accountId: 'acc-a', objectKey: a1.objectKey,
      remoteObjectId: 'remote-1', sha256: sha1, sizeBytes: 2 * MIB,
    });
    assert.equal(r1.fileCompleted, true);
    assert.equal(r1.bytesCompleted, 10 * MIB);

    const job = q.getJob.get(plan.jobId) as { state: string; chunks_completed: number };
    assert.equal(job.state, 'completed');
    const file = q.getFile.get(plan.fileId) as { state: string; manifest_hash: string };
    assert.equal(file.state, 'completed');
    // the manifest hash is versioned and deterministic, not a whole-file digest
    assert.equal(file.manifest_hash, manifestHash([{ size_bytes: 8 * MIB, sha256: sha0 }, { size_bytes: 2 * MIB, sha256: sha1 }]));
    assert.match(file.manifest_hash, /^[0-9a-f]{64}$/);

    // exactly one active placement per chunk
    const chunks = q.listChunks.all(plan.fileId) as Array<{ id: string }>;
    for (const chunk of chunks) {
      const placements = q.placementsForChunk.all(chunk.id) as Array<{ is_active: number }>;
      assert.equal(placements.filter((p) => p.is_active === 1).length, 1, 'exactly one active placement per chunk');
    }
  } finally {
    close();
  }
});

test('re-uploading a chunk deactivates the previous placement instead of duplicating it', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'r1', sha256: 'a'.repeat(64), sizeBytes: 8 * MIB,
    });
    const a1 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a1.objectKey,
      remoteObjectId: 'r2', sha256: 'b'.repeat(64), sizeBytes: 8 * MIB,
    });
    const chunk = q.getChunk.get(plan.fileId, 0) as { id: string };
    const placements = q.placementsForChunk.all(chunk.id) as Array<{ is_active: number; remote_object_id: string }>;
    assert.equal(placements.filter((p) => p.is_active === 1).length, 1, 'only one active placement');
    assert.equal(placements.find((p) => p.is_active === 1)?.remote_object_id, 'r2', 'the newest placement is active');
    const chunks = q.listChunks.all(plan.fileId) as unknown[];
    assert.equal(chunks.length, 1, 'the chunk row is not duplicated');
  } finally {
    close();
  }
});

// ---- UL-1: terminal states stay terminal ----------------------------------

test('UL-1: a cancelled job cannot be resurrected by pause or resume', async () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    await service.cancel(plan.jobId);
    const afterCancel = q.getJob.get(plan.jobId) as { state: string };
    assert.ok(['cancelled', 'deletion_pending'].includes(afterCancel.state));

    assert.throws(() => service.pause(plan.jobId), /job_not_resumable/, 'pause refuses a cancelled job');
    assert.throws(() => service.resume(plan.jobId), /job_not_resumable/, 'resume refuses a cancelled job');
    const still = q.getJob.get(plan.jobId) as { state: string };
    assert.equal(still.state, afterCancel.state, 'the terminal state is unchanged');
  } finally {
    close();
  }
});

test('UL-1: a completed job cannot be retried back into running', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'r1', sha256: 'c'.repeat(64), sizeBytes: 8 * MIB,
    });
    assert.equal((q.getJob.get(plan.jobId) as { state: string }).state, 'completed');
    assert.throws(() => service.resume(plan.jobId), /job_not_resumable/, 'resume refuses a completed job');
    assert.throws(() => service.pause(plan.jobId), /job_not_resumable/, 'pause refuses a completed job');
    assert.equal((q.getJob.get(plan.jobId) as { state: string }).state, 'completed', 'stays complete');
  } finally {
    close();
  }
});

// ---- UL-3: no remote object is orphaned ----------------------------------

test('UL-3: a failure after the object exists records a cleanup obligation', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    // the object exists remotely (e.g. hash/size mismatch after upload)
    service.recordFailure({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      safeCode: 'chunk_hash_mismatch', bytesReceived: 8 * MIB, remoteObjectId: 'remote-orphan-1',
    });
    const attempt = q.getAttempt.get(a0.attemptId) as { state: string; remote_object_id: string | null };
    assert.equal(attempt.state, 'cleanup_pending', 'a live remote object becomes a durable obligation');
    assert.equal(attempt.remote_object_id, 'remote-orphan-1');
    const obligations = service.pendingCleanups() as Array<{ id: string }>;
    assert.equal(obligations.length, 1, 'the obligation is visible to the cleanup sweeper');
  } finally {
    close();
  }
});

test('UL-3: a failure before any object exists stays a plain failure', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.recordFailure({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      safeCode: 'provider_unavailable', bytesReceived: 0, remoteObjectId: null,
    });
    assert.equal((q.getAttempt.get(a0.attemptId) as { state: string }).state, 'failed');
    assert.equal((service.pendingCleanups() as unknown[]).length, 0, 'nothing to clean up');
  } finally {
    close();
  }
});

test('UL-3: cancel sweeps every attempt of a chunk, not just the newest', async () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    // attempt 1 uploads an object, then fails with a mismatch -> obligation
    const a1 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.recordFailure({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a1.objectKey,
      safeCode: 'chunk_size_mismatch', bytesReceived: 100, remoteObjectId: 'orphan-old',
    });
    // attempt 2 is the newer, live one
    const a2 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    const attemptsForChunk = (q.listAttemptsForChunk.all(plan.jobId, 0) as Array<{ id: string; state: string }>);
    assert.equal(attemptsForChunk.length, 2, 'two attempts exist for the chunk');
    // the old attempt must still be reachable as an obligation after cancel
    await service.cancel(plan.jobId);
    const states = (q.listAttemptsForChunk.all(plan.jobId, 0) as Array<{ id: string; state: string }>)
      .map((a) => a.state);
    assert.ok(!states.includes('failed'), 'no attempt is left merely failed while holding an object');
    void a2;
  } finally {
    close();
  }
});

test('resume reports only the chunks that are still missing', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 1, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 1, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'r1', sha256: 'c'.repeat(64), sizeBytes: 8 * MIB,
    });
    service.pause(plan.jobId);
    const resumed = service.resume(plan.jobId);
    assert.deepEqual(resumed.missingChunks, [0, 2], 'already-completed chunks are never re-sent');
  } finally {
    close();
  }
});

test('the resume manifest exposes geometry and hashes but no provider identifiers', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'secret-remote-id', sha256: 'd'.repeat(64), sizeBytes: 8 * MIB,
    });
    const manifest = service.getResumeManifest(plan.jobId, 0, 10);
    assert.equal(manifest.total, 1);
    assert.equal(manifest.chunks[0]!.chunkIndex, 0);
    assert.equal(manifest.chunks[0]!.sha256, 'd'.repeat(64));
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes('secret-remote-id'), 'remote object ids are never exposed');
    assert.ok(!serialized.includes('acc-a'), 'account ids are never exposed');
  } finally {
    close();
  }
});

test('restart recovery pauses running jobs and recomputes reservations', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    service.markRunning(plan.jobId);
    // simulate a stale/incorrect cache that recovery must fix from durable rows
    db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = 0 WHERE id = ?').run('acc-a');
    const result = service.recoverOnStartup();
    assert.equal(result.recovered, 1);
    const job = q.getJob.get(plan.jobId) as { state: string; last_safe_error_code: string };
    assert.equal(job.state, 'paused', 'a crashed job is never left "running"');
    assert.equal(job.last_safe_error_code, 'recovered_after_restart');
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?')
      .get('acc-a') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 10 * MIB, 'reservations are rebuilt from durable allocation rows');
  } finally {
    close();
  }
});

test('a failed upload is recorded without destroying durable history', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.recordFailure({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      safeCode: 'provider_unavailable', bytesReceived: 1234, remoteObjectId: null,
    });
    const attempt = q.getAttempt.get(a0.attemptId) as { state: string; safe_error_code: string; bytes_received: number };
    assert.equal(attempt.state, 'failed');
    assert.equal(attempt.safe_error_code, 'provider_unavailable');
    assert.equal(attempt.bytes_received, 1234);
    const job = q.getJob.get(plan.jobId) as { retry_count: number; last_safe_error_code: string };
    assert.equal(job.retry_count, 1, 'the retry counter is durable');
    assert.equal(job.last_safe_error_code, 'provider_unavailable');
    const allocation = q.getAllocation.get(plan.jobId, 0) as { state: string };
    assert.equal(allocation.state, 'released', 'the failed chunk releases its reservation');
  } finally {
    close();
  }
});

test('cancelling releases unused reservations and reports cleanup state honestly', async () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    await service.cancel(plan.jobId);
    const job = q.getJob.get(plan.jobId) as { state: string };
    // the remote object id was never confirmed, so the obligation stays recorded
    assert.ok(['cancelled', 'deletion_pending'].includes(job.state));
    const attempt = q.getAttempt.get(a0.attemptId) as { state: string };
    assert.ok(['cleanup_pending', 'cleaned', 'failed'].includes(attempt.state));
    const allocations = q.listAllocations.all(plan.jobId) as Array<{ state: string }>;
    assert.ok(!allocations.some((a) => a.state === 'uploading'), 'no allocation is left uploading after cancel');
  } finally {
    close();
  }
});

test('a chunk can be re-routed to another account, preserving the audit trail', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 10 * MIB, used: 0 });
    seedAccount(db, { id: 'acc-b', provider: 'dropbox', total: 100 * MIB, used: 0 });
    // force all chunks onto the small account by making the big one temporarily unknown
    db.prepare("UPDATE provider_accounts SET quota_status = 'unknown' WHERE id = 'acc-b'").run();
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    assert.equal(plan.allocations[0]!.accountId, 'acc-a');
    // the large account becomes usable again
    db.prepare("UPDATE provider_accounts SET quota_status = 'current' WHERE id = 'acc-b'").run();
    const rerouted = service.reassignChunk(plan.jobId, 0);
    assert.equal(rerouted?.accountId, 'acc-b');
    const allocation = q.getAllocation.get(plan.jobId, 0) as { provider_account_id: string; state: string };
    assert.equal(allocation.provider_account_id, 'acc-b');
    assert.equal(allocation.state, 'reserved', 'the re-routed chunk is reserved again, not left mid-flight');
    // there is still exactly one placement-less allocation for that chunk
    const all = q.listAllocations.all(plan.jobId) as unknown[];
    assert.equal(all.length, 1, 're-routing never creates a duplicate allocation');
  } finally {
    close();
  }
});

test('the hashing counter hashes exactly the bytes it forwards', async () => {
  const counter = new HashingCounter();
  const payload = Buffer.from('the quick brown fox');
  const received: Buffer[] = [];
  counter.on('data', (chunk: Buffer) => received.push(chunk));
  const done = new Promise<void>((resolve) => counter.on('end', () => resolve()));
  Readable.from([payload.subarray(0, 4), payload.subarray(4)]).pipe(counter);
  await done;
  const expected = crypto.createHash('sha256').update(payload).digest('hex');
  assert.equal(counter.digest(), expected, 'the hash matches the forwarded bytes');
  assert.equal(counter.bytes, payload.length);
  assert.equal(Buffer.concat(received).toString(), 'the quick brown fox', 'every byte was forwarded');
});

test('a byte-count mismatch is refused rather than accepted', () => {
  assert.throws(() => assertByteCount(100, 99), (err: unknown) => err instanceof ByteCountMismatchError);
  assert.throws(() => assertByteCount(100, 101), (err: unknown) => err instanceof ByteCountMismatchError);
  assert.doesNotThrow(() => assertByteCount(100, 100));
});

test('dashboard and file summaries expose only safe, real fields', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const summary = service.dashboardSummary();
    assert.equal(summary.accounts.length, 1);
    assert.equal(summary.totalFiles, 1);
    const file = service.publicFile(plan.fileId)!;
    assert.equal(file.originalName, 'a.bin');
    assert.deepEqual(file.storedAcross, [], 'no placement yet, so nothing is claimed as stored');
    const job = service.publicJob(plan.jobId)!;
    assert.equal(job.chunksTotal, 1);
    assert.ok(job.cancellable);
    const serialized = JSON.stringify({ summary, file, job });
    assert.ok(!serialized.includes('credential'), 'no credential material is exposed');
    // the dashboard summary deliberately shows the owner-chosen account label,
    // but the file and job summaries must not leak account identifiers at all
    assert.ok(!JSON.stringify(file).includes('@example.com'), 'file summaries carry no account identifiers');
    assert.ok(!JSON.stringify(job).includes('@example.com'), 'job summaries carry no account identifiers');
    assert.ok(JSON.stringify(summary).includes('acc-a@example.com'), 'the account label is shown where intended');
  } finally {
    close();
  }
});

// ---- M9.d: resume verification, cleanup retries, honest failure states ----

test('a reselected source that does not match is rejected as source_changed', async () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const original = Buffer.alloc(8 * MIB, 7);
    const digest = crypto.createHash('sha256').update(original).digest('hex');
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'r0', sha256: digest, sizeBytes: 8 * MIB,
    });
    // the owner reselects a DIFFERENT file of the same size
    const wrongSource = Buffer.alloc(8 * MIB, 9);
    await assert.rejects(
      service.verifyReselectedSource(plan.jobId, 8 * MIB, async () => wrongSource),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'source_changed',
    );
    // a chunk-size mismatch is also refused before any hashing work
    await assert.rejects(
      service.verifyReselectedSource(plan.jobId, 16 * MIB, async () => original),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'source_changed',
    );
  } finally {
    close();
  }
});

test('a matching reselected source resumes only the missing chunks', async () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const chunk0 = Buffer.alloc(8 * MIB, 1);
    const digest0 = crypto.createHash('sha256').update(chunk0).digest('hex');
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'r0', sha256: digest0, sizeBytes: 8 * MIB,
    });
    const result = await service.verifyReselectedSource(plan.jobId, 8 * MIB, async (offset) => {
      assert.equal(offset, 0, 'only completed slices are re-read');
      return chunk0;
    });
    assert.equal(result.verifiedChunks, 1);
    assert.deepEqual(result.missingChunks, [1, 2]);
  } finally {
    close();
  }
});

test('cleanup retries only close obligations whose remote object is known', async () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    await service.cancel(plan.jobId);
    const pending = service.pendingCleanups();
    // the remote id was never confirmed, so the obligation must NOT be dropped
    assert.ok(pending.length >= 1, 'the obligation stays recorded');
    const retry = await service.retryPendingCleanups();
    assert.equal(retry.retried, pending.length);
    assert.equal(retry.cleaned, 0, 'an unknown remote object is never assumed deleted');
    assert.ok(retry.stillPending >= 1, 'it remains pending rather than silently lost');
    void a0;
  } finally {
    close();
  }
});

test('a cancelled job is not resumable and a completed job stays complete', () => {
  const { db, close, service, q } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a' });
    service.commitChunk({
      jobId: plan.jobId, chunkIndex: 0, accountId: 'acc-a', objectKey: a0.objectKey,
      remoteObjectId: 'r0', sha256: 'e'.repeat(64), sizeBytes: 8 * MIB,
    });
    assert.throws(
      () => service.markRunning(plan.jobId),
      (err: unknown) => err instanceof UploadError && err.safeCode === 'job_not_resumable',
    );
    const job = q.getJob.get(plan.jobId) as { state: string };
    assert.equal(job.state, 'completed', 'a completed job is never reopened');
  } finally {
    close();
  }
});

test('reservation cache is corrected from durable rows, never trusted blindly', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: KEY });
    // corrupt the cache deliberately
    db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = 999999 WHERE id = ?').run('acc-a');
    service.recomputeAllReservations();
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?')
      .get('acc-a') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 16 * MIB, 'the cache is rebuilt from allocations');
    void plan;
  } finally {
    close();
  }
});
