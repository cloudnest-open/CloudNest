import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { MemoryBudget, GLOBAL_BUDGET_BYTES } from '../src/downloads/memory-budget.js';
import { DownloadService, DownloadError } from '../src/downloads/download-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { SettingsService } from '../src/settings/settings-service.js';

const MIB = 1024 * 1024;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-dl-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  // M12.a: the download service reads `download.concurrency` from real settings
  const service = new DownloadService(db, store, new SettingsService(db));
  return { db, close, store, service, dir };
}

function seedFile(db: import('better-sqlite3').Database, opts: {
  fileId: string; name: string; size: number; chunkSize: number; state?: string;
  chunks: Array<{ index: number; offset: number; size: number; sha256: string }>;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO files (id, user_id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, created_at, manifest_hash, completed_at)
     VALUES (?, 'usr_admin', ?, ?, 'application/octet-stream', ?, ?, ?, ?, ?, ?)`,
  ).run(opts.fileId, opts.name, opts.size, opts.chunkSize, opts.chunks.length, opts.state ?? 'completed', now,
    crypto.createHash('sha256').update(`v1|${opts.chunks.map((c, i) => `${i}:${c.size}:${c.sha256}`).join('|')}`).digest('hex'), now);
  for (const chunk of opts.chunks) {
    db.prepare(
      `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
    ).run(crypto.randomUUID(), opts.fileId, chunk.index, chunk.offset, chunk.size, chunk.sha256, now, now);
  }
}

test('a missing file is a safe 404 and an incomplete file is refused', () => {
  const { db, close, service } = setup();
  try {
    assert.throws(() => service.prepare('nope', null, false), (e: unknown) => e instanceof DownloadError && e.safeCode === 'file_not_found');
    seedFile(db, { fileId: 'f1', name: 'a.bin', size: 100, chunkSize: 50, state: 'uploading', chunks: [{ index: 0, offset: 0, size: 50, sha256: 'a'.repeat(64) }] });
    assert.throws(() => service.prepare('f1', null, false), (e: unknown) => e instanceof DownloadError && e.safeCode === 'file_not_complete');
  } finally {
    close();
  }
});

test('a file marked for deletion refuses download', () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f2', name: 'a.bin', size: 0, chunkSize: 50, state: 'deletion_pending', chunks: [] });
    assert.throws(() => service.prepare('f2', null, false), (e: unknown) => e instanceof DownloadError && e.safeCode === 'deletion_pending');
  } finally {
    close();
  }
});

test('prepare creates a download job with the exact requested range', () => {
  const { db, close, service } = setup();
  try {
    const sha = crypto.createHash('sha256').update('x').digest('hex');
    seedFile(db, { fileId: 'f3', name: 'a.bin', size: 1000, chunkSize: 1000, chunks: [{ index: 0, offset: 0, size: 1000, sha256: sha }] });
    const full = service.prepare('f3', null, true);
    const job = service.publicDownloadJob(full.jobId)!;
    assert.equal(job.requested_bytes, 1000);
    assert.equal(job.requested_range_start_bytes, 0);
    assert.equal(job.requested_range_end_bytes, 999);

    const ranged = service.prepare('f3', { start: 100, end: 199, length: 100 }, true);
    const rjob = service.publicDownloadJob(ranged.jobId)!;
    assert.equal(rjob.requested_bytes, 100);
    assert.equal(rjob.requested_range_start_bytes, 100);
    assert.equal(rjob.requested_range_end_bytes, 199);
    assert.equal(rjob.chunks_total, 1, 'only the overlapping chunk is planned');
  } finally {
    close();
  }
});

test('HEAD preparation creates no job at all', () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f4', name: 'a.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: 'a'.repeat(64) }] });
    const before = service.countDownloadJobs();
    const prepared = service.prepare('f4', null, false);
    assert.equal(prepared.jobId, '', 'no job id is issued for a metadata-only request');
    assert.equal(service.countDownloadJobs(), before, 'no job row is written');
  } finally {
    close();
  }
});

test('an empty file downloads as zero bytes with no chunk reads', async () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f5', name: 'empty.txt', size: 0, chunkSize: 100, chunks: [] });
    const prepared = service.prepare('f5', null, true);
    assert.equal(prepared.chunksTotal, 0);
    const got: Buffer[] = [];
    for await (const buf of service.stream(prepared)) got.push(buf);
    assert.equal(got.length, 0, 'no bytes are produced for an empty file');
    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'completed');
    assert.equal(job.requested_bytes, 0);
    assert.equal(job.requested_range_start_bytes, null, 'an empty file has no byte interval');
  } finally {
    close();
  }
});

test('a manifest that no longer matches the stored chunks is refused', async () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f6', name: 'a.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: 'a'.repeat(64) }] });
    // tamper with the stored manifest hash so it no longer describes the chunks
    db.prepare("UPDATE files SET manifest_hash = ? WHERE id = 'f6'").run('f'.repeat(64));
    const prepared = service.prepare('f6', null, true);
    await assert.rejects(
      (async () => { for await (const _ of service.stream(prepared)) void _; })(),
      (e: unknown) => e instanceof DownloadError && e.safeCode === 'chunk_hash_mismatch',
    );
    const file = service.getFile('f6')!;
    assert.equal(file.state, 'needs_repair', 'the file is honestly marked as needing repair');
  } finally {
    close();
  }
});

test('a chunk with no active placement is reported as missing, not as success', async () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f7', name: 'a.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: 'a'.repeat(64) }] });
    const prepared = service.prepare('f7', null, true);
    await assert.rejects(
      (async () => { for await (const _ of service.stream(prepared)) void _; })(),
      (e: unknown) => e instanceof DownloadError && e.safeCode === 'chunk_missing',
    );
    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'failed');
    assert.equal(job.last_safe_error_code, 'chunk_missing');
  } finally {
    close();
  }
});

test('cancelling a running download marks it cancelled, and it is not cancellable twice', () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f8', name: 'a.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: 'a'.repeat(64) }] });
    const prepared = service.prepare('f8', null, true);
    assert.equal(service.cancelDownload(prepared.jobId), true);
    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'cancelled');
    assert.equal(job.last_safe_error_code, 'download_cancelled');
    assert.equal(service.cancelDownload(prepared.jobId), false, 'an already-finished job is not cancellable');
  } finally {
    close();
  }
});

test('rename changes only metadata and never touches provider objects', () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f9', name: 'old.bin', size: 10, chunkSize: 10, chunks: [{ index: 0, offset: 0, size: 10, sha256: 'a'.repeat(64) }] });
    const result = service.renameFile('f9', 'new-name.bin');
    assert.equal(result.originalName, 'new-name.bin');
    assert.equal(service.getFile('f9')!.original_name, 'new-name.bin');
    // the chunk map is untouched
    assert.equal(service.listChunks('f9').length, 1);
    assert.throws(() => service.renameFile('nope', 'x'), (e: unknown) => e instanceof DownloadError);
  } finally {
    close();
  }
});

test('a restart reports interrupted downloads truthfully instead of completed', () => {
  const { db, close, service } = setup();
  try {
    seedFile(db, { fileId: 'f10', name: 'a.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: 'a'.repeat(64) }] });
    const prepared = service.prepare('f10', null, true);
    const recovered = service.recoverDownloadsOnStartup();
    assert.equal(recovered, 1);
    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'failed', 'an interrupted stream is never reported as complete');
    assert.equal(job.last_safe_error_code, 'download_interrupted');
  } finally {
    close();
  }
});

// ---- memory budget ----

test('the global budget never exceeds its capacity', async () => {
  const budget = new MemoryBudget(100);
  const r1 = await budget.acquire(60);
  assert.equal(budget.usedBytes, 60);
  let secondGranted = false;
  const pending = budget.acquire(60).then((release) => {
    secondGranted = true;
    return release;
  });
  // the second request must wait: 60 + 60 > 100
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(secondGranted, false, 'the budget blocks an over-capacity request');
  r1();
  const r2 = await pending;
  assert.equal(secondGranted, true);
  assert.equal(budget.usedBytes, 60);
  r2();
  assert.equal(budget.usedBytes, 0, 'permits are returned');
});

test('the default budget is 128 MiB as the plan specifies', () => {
  assert.equal(GLOBAL_BUDGET_BYTES, 128 * 1024 * 1024);
});

// DL-1 regression: one drain pass must not grant two waiters that only fit
// jointly. Pre-fix, both 64-byte waiters below resolved against the stale
// total and the peak reached 168 instead of the true bound of 104.
test('multiple queued waiters can never jointly exceed the capacity (DL-1)', async () => {
  const budget = new MemoryBudget(100);
  const r1 = await budget.acquire(40);
  const r2 = await budget.acquire(40);
  assert.equal(budget.usedBytes, 80);

  const grants: number[] = [];
  const w1 = budget.acquire(64).then((release) => { grants.push(1); return release; });
  const w2 = budget.acquire(64).then((release) => { grants.push(2); return release; });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(grants, [], 'neither over-capacity waiter is granted yet');

  r1(); // frees 40; inUse = 40 while r2 still holds its 40
  await new Promise((r) => setTimeout(r, 10));
  // 40 + 64 = 104 > 100, so even the first waiter must STILL wait;
  // nothing may be granted until the true total fits.
  assert.deepEqual(grants, [], 'a grant is issued only when the true total fits');
  assert.ok(budget.usedBytes <= 100, 'the committed total never exceeds capacity');

  r2(); // frees the remaining 40; now one 64-byte waiter fits (64 <= 100)
  const rel1 = await w1;
  assert.deepEqual(grants, [1], 'exactly one waiter is granted');
  assert.ok(budget.usedBytes <= 100);
  assert.ok(budget.peakBytes <= 100, 'the observed peak never exceeds the capacity');

  rel1();
  const rel2 = await w2;
  assert.deepEqual(grants, [1, 2], 'the second waiter follows once capacity frees');
  assert.ok(budget.peakBytes <= 100);
  rel2();
  assert.equal(budget.usedBytes, 0, 'all permits are returned');
});

test('a single drain pass cannot over-commit two jointly-fitting waiters (DL-1)', async () => {
  const budget = new MemoryBudget(128);
  const hold = await budget.acquire(80);
  const a = budget.acquire(64);
  const b = budget.acquire(64);
  hold(); // frees 80; 64+64=128 fits ONLY jointly with nothing else held
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(budget.usedBytes, 128, 'both grants are accounted: exactly the capacity');
  assert.ok(budget.peakBytes <= 128, 'the peak stays within the capacity');
  ra(); rb();
  assert.equal(budget.usedBytes, 0);
});

test('releasing a permit twice cannot corrupt the accounting', async () => {
  const budget = new MemoryBudget(100);
  const release = await budget.acquire(50);
  release();
  release(); // a double release must be harmless
  assert.equal(budget.usedBytes, 0);
});

test('a request larger than the whole budget is clamped so it cannot deadlock', async () => {
  const budget = new MemoryBudget(100);
  const release = await budget.acquire(500);
  assert.ok(budget.usedBytes <= 100, 'usage never exceeds capacity');
  release();
  assert.equal(budget.usedBytes, 0);
});

test('concurrent downloads do not share mutable service state', () => {
  const { db, close, service } = setup();
  try {
    const shaA = crypto.createHash('sha256').update('a').digest('hex');
    const shaB = crypto.createHash('sha256').update('b').digest('hex');
    seedFile(db, { fileId: 'fa', name: 'a.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: shaA }] });
    seedFile(db, { fileId: 'fb', name: 'b.bin', size: 100, chunkSize: 100, chunks: [{ index: 0, offset: 0, size: 100, sha256: shaB }] });
    const pa = service.prepare('fa', null, true);
    const pb = service.prepare('fb', null, true);
    // both preparations are independent: each keeps its own file and job
    assert.notEqual(pa.fileId, pb.fileId);
    assert.equal(pa.slices[0]!.chunkIndex, 0);
    assert.equal(pb.slices[0]!.chunkIndex, 0);
    // the service exposes no per-download instance state that could be crossed
    assert.equal(Object.keys(service).some((k) => k.toLowerCase().includes('currentfile')), false);
  } finally {
    close();
  }
});
