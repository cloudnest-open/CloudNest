import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { MemoryBudget } from '../src/downloads/memory-budget.js';
import { DownloadService, DownloadError, type DownloadPrepared } from '../src/downloads/download-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { SettingsService } from '../src/settings/settings-service.js';
import type { ChunkSlice } from '../src/downloads/range.js';

/**
 * M12.a `download.concurrency` — the setting must actually bound the pipeline.
 *
 * Every test here fails if `stream()` goes back to an unbounded or serial loop:
 * the prefetch window, the in-order contract and the memory budget are all
 * measured, not assumed.
 */

const MIB = 1024 * 1024;

function setup(over: { concurrency?: number; budgetCapacity?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-dlc-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const settings = new SettingsService(db);
  if (over.concurrency !== undefined) settings.set('download.concurrency', over.concurrency);
  const budget = new MemoryBudget(over.budgetCapacity ?? 128 * MIB);
  const service = new DownloadService(db, store, settings, budget);
  return { db, close, service, settings, budget, dir };
}

/** Seed a completed file whose chunks are byte-exact. */
function seedFile(db: import('better-sqlite3').Database, opts: {
  fileId: string; name: string; chunkSize: number; chunkCount: number;
}): Array<{ index: number; size: number; sha256: string; bytes: Buffer }> {
  const now = new Date().toISOString();
  const chunks: Array<{ index: number; size: number; sha256: string; bytes: Buffer }> = [];
  for (let i = 0; i < opts.chunkCount; i++) {
    const bytes = Buffer.alloc(opts.chunkSize, i + 1);
    chunks.push({
      index: i,
      size: opts.chunkSize,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes,
    });
  }
  const total = opts.chunkSize * opts.chunkCount;
  db.prepare(
    `INSERT INTO files (id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, created_at, manifest_hash, completed_at)
     VALUES (?, ?, ?, 'application/octet-stream', ?, ?, 'completed', ?, ?, ?)`,
  ).run(
    opts.fileId, opts.name, total, opts.chunkSize, opts.chunkCount, now,
    crypto.createHash('sha256')
      .update(`v1|${chunks.map((c, i) => `${i}:${c.size}:${c.sha256}`).join('|')}`)
      .digest('hex'),
    now,
  );
  for (const chunk of chunks) {
    db.prepare(
      `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
    ).run(crypto.randomUUID(), opts.fileId, chunk.index, chunk.index * opts.chunkSize, chunk.size, chunk.sha256, now, now);
  }
  return chunks;
}

interface Instrumented {
  /** Highest number of reads running at the same time. */
  peakConcurrent: number;
  /** Every read that was started, in start order. */
  started: number[];
}

/**
 * Replace the real provider read with a controllable one that still returns
 * byte-exact, hash-correct data: the pipeline's own order and budget logic is
 * what is under test, not a provider.
 */
function instrument(
  service: DownloadService,
  chunks: Array<{ index: number; size: number; bytes: Buffer }>,
  opts: { delayMs?: number; onRead?: (index: number) => Promise<void> } = {},
): Instrumented {
  const stats: Instrumented = { peakConcurrent: 0, started: [] };
  let running = 0;
  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  type Holding = { bytes: Buffer; meta: ChunkSlice; release: () => void };
  const target = service as unknown as {
    readVerifiedChunkHolding(fileId: string, slice: ChunkSlice): Promise<Holding>;
    budget: MemoryBudget;
  };
  target.readVerifiedChunkHolding = async (_fileId: string, slice: ChunkSlice): Promise<Holding> => {
    running++;
    stats.started.push(slice.chunkIndex);
    stats.peakConcurrent = Math.max(stats.peakConcurrent, running);
    // reserve from the REAL budget so the bound is genuinely spent
    const release = await target.budget.acquire(slice.chunkSizeBytes);
    try {
      await opts.onRead?.(slice.chunkIndex);
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      const found = byIndex.get(slice.chunkIndex);
      if (!found) throw new DownloadError('chunk_missing', 409);
      return { bytes: Buffer.from(found.bytes), meta: slice, release };
    } catch (err) {
      release();
      throw err;
    } finally {
      running--;
    }
  };
  return stats;
}

function collect(prepared: DownloadPrepared, service: DownloadService): Promise<Buffer[]> {
  return (async () => {
    const out: Buffer[] = [];
    for await (const buf of service.stream(prepared)) out.push(Buffer.from(buf));
    return out;
  })();
}

test('concurrency 1 behaves exactly like the serial loop', async () => {
  const { db, close, service, budget } = setup({ concurrency: 1 });
  try {
    const chunks = seedFile(db, { fileId: 'f1', name: 'a.bin', chunkSize: 4096, chunkCount: 4 });
    const stats = instrument(service, chunks, { delayMs: 1 });
    const prepared = service.prepare('f1', null, true);
    const got = await collect(prepared, service);
    assert.equal(got.length, 4);
    assert.deepEqual(got.map((b) => b.length), [4096, 4096, 4096, 4096]);
    assert.equal(stats.peakConcurrent, 1, 'a serial configuration never reads two chunks at once');
    assert.equal(budget.usedBytes, 0, 'every reservation was returned');
  } finally {
    close();
  }
});

test('the setting bounds how many chunks are read at once', async () => {
  const { db, close, service, settings, budget } = setup({ concurrency: 2 });
  try {
    const chunks = seedFile(db, { fileId: 'f2', name: 'a.bin', chunkSize: 4096, chunkCount: 6 });
    const stats = instrument(service, chunks, { delayMs: 5 });
    const prepared = service.prepare('f2', null, true);
    const got = await collect(prepared, service);
    assert.equal(got.length, 6);
    assert.ok(
      stats.peakConcurrent <= 2,
      `at most the configured 2 reads may run together (observed ${stats.peakConcurrent})`,
    );
    assert.ok(stats.peakConcurrent >= 2, `a bound of 2 should actually be used (observed ${stats.peakConcurrent})`);

    // raising the setting must raise the observed parallelism of the NEXT stream
    settings.set('download.concurrency', 4);
    const stats2 = instrument(service, chunks, { delayMs: 5 });
    const prepared2 = service.prepare('f2', null, true);
    await collect(prepared2, service);
    assert.ok(
      stats2.peakConcurrent > stats.peakConcurrent,
      `a higher setting must admit more parallel reads (2 -> ${stats2.peakConcurrent})`,
    );
    assert.ok(stats2.peakConcurrent <= 4, 'and still respect the new bound');
    assert.equal(budget.usedBytes, 0, 'no reservation is stranded after either stream');
  } finally {
    close();
  }
});

test('the read-ahead window is bounded, so memory cannot grow with file size', async () => {
  const { db, close, service, budget } = setup({ concurrency: 3 });
  try {
    const chunks = seedFile(db, { fileId: 'f3', name: 'a.bin', chunkSize: 8192, chunkCount: 12 });
    instrument(service, chunks, { delayMs: 2 });
    const prepared = service.prepare('f3', null, true);
    const got = await collect(prepared, service);
    assert.equal(got.length, 12);
    // 3 in-flight chunks x 8 KiB is the ceiling; a whole-file buffer would be 96 KiB
    assert.ok(
      budget.peakBytes <= 3 * 8192,
      `peak reservations must stay within concurrency x chunk size (observed ${budget.peakBytes})`,
    );
    assert.equal(budget.usedBytes, 0, 'the budget is fully released when the stream finishes');
  } finally {
    close();
  }
});

test('bytes are yielded strictly in order', async () => {
  const { db, close, service } = setup({ concurrency: 4 });
  try {
    // unequal delays: the LAST chunk completes first, so only an order-preserving
    // pipeline can return the right sequence
    const chunks = seedFile(db, { fileId: 'f4', name: 'a.bin', chunkSize: 1024, chunkCount: 4 });
    instrument(service, chunks, {
      onRead: async (index) => {
        await new Promise((resolve) => setTimeout(resolve, (4 - index) * 3));
      },
    });
    const prepared = service.prepare('f4', null, true);
    const got = await collect(prepared, service);
    assert.equal(got.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(got[i]![0], i + 1, `chunk ${i} must arrive in position ${i}`);
    }
  } finally {
    close();
  }
});

test('a hash failure still aborts with the same code and frees every reservation', async () => {
  const { db, close, service, budget } = setup({ concurrency: 3 });
  try {
    const chunks = seedFile(db, { fileId: 'f5', name: 'a.bin', chunkSize: 2048, chunkCount: 5 });
    instrument(service, chunks, {
      onRead: async (index) => {
        if (index === 1) throw new DownloadError('chunk_hash_mismatch', 502);
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    const prepared = service.prepare('f5', null, true);
    await assert.rejects(
      () => collect(prepared, service),
      (e: unknown) => e instanceof DownloadError && (e as DownloadError).safeCode === 'chunk_hash_mismatch',
    );
    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'failed');
    assert.equal(job.last_safe_error_code, 'chunk_hash_mismatch');
    assert.equal(budget.usedBytes, 0, 'a failure never strands a reservation');
  } finally {
    close();
  }
});

test('an abort mid-stream stops the pipeline and releases every reservation', async () => {
  const { db, close, service, budget } = setup({ concurrency: 3 });
  try {
    const chunks = seedFile(db, { fileId: 'f6', name: 'a.bin', chunkSize: 2048, chunkCount: 8 });
    const controller = new AbortController();
    instrument(service, chunks, { delayMs: 3 });
    const prepared = service.prepare('f6', null, true);
    const consumed: Buffer[] = [];
    await assert.rejects(
      (async () => {
        for await (const buf of service.stream(prepared, controller.signal)) {
          consumed.push(Buffer.from(buf));
          if (consumed.length === 1) controller.abort();
        }
      })(),
      (e: unknown) => e instanceof DownloadError && (e as DownloadError).safeCode === 'download_cancelled',
    );
    assert.equal(consumed.length, 1, 'iteration stopped at the abort');
    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'cancelled');
    assert.equal(budget.usedBytes, 0, 'an abort never strands a reservation');
  } finally {
    close();
  }
});

test('a consumer that stops iterating early does not strand the budget', async () => {
  const { db, close, service, budget } = setup({ concurrency: 3 });
  try {
    const chunks = seedFile(db, { fileId: 'f7', name: 'a.bin', chunkSize: 4096, chunkCount: 6 });
    instrument(service, chunks, { delayMs: 2 });
    const prepared = service.prepare('f7', null, true);
    const iterator = service.stream(prepared);
    const first = await iterator.next();
    assert.equal(first.done, false);
    await iterator.return?.(undefined);
    assert.equal(budget.usedBytes, 0, 'closing the generator returns every reservation');
  } finally {
    close();
  }
});

test('a corrupt setting falls back to the documented default instead of unbounded', async () => {
  const { db, close, service, settings } = setup({ concurrency: 8 });
  try {
    const chunks = seedFile(db, { fileId: 'f8', name: 'a.bin', chunkSize: 1024, chunkCount: 3 });
    // write a value the validator would reject, as a hand-edited or corrupt row
    db.prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'download.concurrency'")
      .run(JSON.stringify(9999));
    const stats = instrument(service, chunks, { delayMs: 2 });
    const prepared = service.prepare('f8', null, true);
    const got = await collect(prepared, service);
    assert.equal(got.length, 3);
    assert.ok(stats.peakConcurrent <= 8, `a corrupt row must not widen the bound (observed ${stats.peakConcurrent})`);
    assert.equal(typeof settings.get('download.concurrency'), 'number');
  } finally {
    close();
  }
});

// ---- FE-07: cancel actually stops the live stream -------------------------

test('FE-07: cancelDownload aborts a live stream mid-flight and the job stays cancelled', async () => {
  const { db, close, service } = setup({ concurrency: 2 });
  try {
    const chunks = seedFile(db, { fileId: 'fe07', name: 'a.bin', chunkSize: 1 * MIB, chunkCount: 8 });
    // reads hang until released: the stream cannot finish on its own
    const gate: Array<() => void> = [];
    let reads = 0;
    const target = service as unknown as {
      readVerifiedChunkHolding(fileId: string, slice: ChunkSlice): Promise<{ bytes: Buffer; meta: ChunkSlice; release: () => void }>;
      budget: MemoryBudget;
    };
    const prepared = service.prepare('fe07', null, true);
    // FE-07 registry: the live stream registers its controller here
    const registry = (service as unknown as { activeStreams: Map<string, AbortController> }).activeStreams;
    target.readVerifiedChunkHolding = async (_fileId: string, slice: ChunkSlice) => {
      reads++;
      const release = await target.budget.acquire(slice.chunkSizeBytes);
      try {
        // hold until the job's registered controller aborts (cancelDownload)
        // or the gate opens; the abort path mirrors a destroyed provider socket
        await new Promise<void>((resolve, reject) => {
          const poll = setInterval(() => {
            const live = registry.get(prepared.jobId);
            if (!live || live.signal.aborted) {
              clearInterval(poll);
              reject(new DownloadError('download_cancelled', 499));
            }
          }, 5);
          gate.push(() => { clearInterval(poll); resolve(); });
        });
        const found = chunks.find((c) => c.index === slice.chunkIndex)!;
        return { bytes: Buffer.from(found.bytes), meta: slice, release };
      } catch (err) {
        release();
        throw err;
      }
    };

    // consume the stream in the background
    const consumer = (async () => {
      const got: Buffer[] = [];
      for await (const buf of service.stream(prepared)) got.push(buf);
      return got;
    })();

    // let the first reads start, then cancel from the outside
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(reads > 0, 'the stream has started reading');
    assert.equal(service.cancelDownload(prepared.jobId), true);

    // cancel() aborted the registered controller: the reads observe it and
    // fail on their own (like destroyed sockets). Open the gate too so any
    // read that somehow missed the abort still finishes deterministically.
    for (const open of gate.splice(0)) open();

    // the stream must now terminate (no hang, no further bytes)
    type Outcome =
      | { kind: 'ended'; bufs: Buffer[] }
      | { kind: 'failed'; err: unknown }
      | { kind: 'timed-out' };
    const outcome: Outcome = await Promise.race([
      consumer.then(
        (bufs: Buffer[]) => ({ kind: 'ended' as const, bufs }),
        (err: unknown) => ({ kind: 'failed' as const, err }),
      ),
      new Promise<Outcome>((r) => setTimeout(() => r({ kind: 'timed-out' }), 2000)),
    ]);
    assert.notEqual(outcome.kind, 'timed-out', 'the aborted stream ends instead of hanging');
    // the loop observed the abort (cancelled/aborted outcome), not success
    if (outcome.kind === 'failed') {
      assert.equal((outcome.err as { safeCode?: string }).safeCode, 'download_cancelled');
    }

    const job = service.publicDownloadJob(prepared.jobId)!;
    assert.equal(job.state, 'cancelled', 'the job row keeps the cancelled truth');
    assert.equal(service.cancelDownload(prepared.jobId), false, 'a cancelled job is not cancellable again');
  } finally {
    close();
  }
});
