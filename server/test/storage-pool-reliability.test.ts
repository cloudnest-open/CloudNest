import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { makeUploadQueries, reconcileUploadedPendingQuota } from '../src/db/upload-queries.js';
import { makeProviderQueries } from '../src/db/provider-queries.js';
import { UploadService, CapacityInsufficientError } from '../src/uploads/upload-service.js';
import { ProviderAccountService } from '../src/services/provider-account-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import {
  preflight, allocateChunks, suggestSmallerChunkSizeMiB, assessCapacity,
  type AccountCapacityInput,
} from '../src/uploads/capacity.js';
import { planChunks, chunkBounds } from '../src/uploads/chunk-math.js';

/**
 * Multi-account storage-pool reliability task (§13.B capacity/shared quota,
 * §13.C reservations/idempotency, §13.E restart, §13.F large-plan stress).
 * No network, no real credentials: temp SQLite + plain SQL seeds.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** Decimal GB — the task spec's examples (200 GB, 5,000 GB) are decimal. */
const GB = 1_000_000_000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-pool-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const service = new UploadService(db, store);
  const accountService = new ProviderAccountService(db, makeProviderQueries(db), store);
  return { db, close, store, service, accountService, q: makeUploadQueries(db) };
}

function seedAccount(db: import('better-sqlite3').Database, opts: {
  id: string; provider?: string; total: number | null; used: number | null;
  quotaStatus?: string; status?: string; reserve?: number;
  unlimited?: boolean; scope?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, quota_unlimited, quota_scope,
      reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.id, opts.provider ?? 'google_drive', `${opts.id}@example.com`, `ident-${opts.id}`,
    opts.status ?? 'connected', opts.total, opts.used,
    opts.quotaStatus ?? 'current', opts.unlimited === true ? 1 : 0, opts.scope ?? null,
    opts.reserve ?? 0, now, now,
  );
}

function input(overrides: Partial<AccountCapacityInput> & { accountId: string }): AccountCapacityInput {
  return {
    provider: 'google_drive',
    displayLabel: overrides.accountId,
    status: 'connected',
    quotaStatus: 'current',
    quotaTotalBytes: null,
    quotaUsedBytes: null,
    reserveBytes: 0,
    outstandingReservationBytes: 0,
    ...overrides,
  };
}

function descriptors(fileSizeBytes: number, chunkSizeMiB: number) {
  const plan = planChunks(fileSizeBytes, chunkSizeMiB * MIB);
  const out: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }> = [];
  for (let i = 0; i < plan.chunkCount; i++) {
    const b = chunkBounds(plan, i);
    out.push({ chunkIndex: b.chunkIndex, offsetBytes: b.offsetBytes, sizeBytes: b.sizeBytes });
  }
  return out;
}

// ---- §13.B: capacity arithmetic and shared quota ----

test('uneven capacity yields a non-equal plan that never exceeds any account', () => {
  // 30/20/60/50/50 GB (decimal) eligible; 200 GB file @ 64 MiB chunks
  const sizes = [30, 20, 60, 50, 50];
  const inputs = sizes.map((gb, i) => input({
    accountId: `acc-${i}`,
    quotaTotalBytes: gb * GB + 5 * GB,
    quotaUsedBytes: 5 * GB,
  }));
  const assessment = assessCapacity(inputs);
  const assigned = allocateChunks(descriptors(200 * GB, 64), assessment.eligible);
  assert.ok(assigned, 'a 200 GB file fits a 210 GB uneven pool');
  const perAccount = new Map<string, number>();
  for (const a of assigned!) perAccount.set(a.accountId, (perAccount.get(a.accountId) ?? 0) + a.sizeBytes);
  for (const [accountId, bytes] of perAccount) {
    const account = assessment.eligible.find((u) => u.accountId === accountId)!;
    assert.ok(bytes <= account.usableBytes, `${accountId} stays within its own usable bytes`);
  }
  const total = [...perAccount.values()].reduce((s, n) => s + n, 0);
  assert.equal(total, 200 * GB);
  const values = [...perAccount.values()];
  assert.ok(!values.every((v) => v === values[0]), 'the plan is not an equal split');
});

test('fragmentation: 80 MiB across two 40 MiB accounts rejects 64/32/16 MiB and suggests 8 MiB', () => {
  const inputs = [
    input({ accountId: 'a', quotaTotalBytes: 40 * MIB, quotaUsedBytes: 0 }),
    input({ accountId: 'b', quotaTotalBytes: 40 * MIB, quotaUsedBytes: 0 }),
  ];
  const assessment = assessCapacity(inputs);
  assert.equal(assessment.totalUsableBytes, 80 * MIB, 'the SUM alone looks sufficient');
  for (const size of [64, 32, 16] as const) {
    const assigned = allocateChunks(descriptors(80 * MIB, size), assessment.eligible);
    assert.equal(assigned, null, `${size} MiB chunks cannot be packed into 2×40 MiB`);
  }
  assert.ok(allocateChunks(descriptors(80 * MIB, 8), assessment.eligible), '8 MiB packs');
  assert.equal(suggestSmallerChunkSizeMiB(80 * MIB, 64, inputs), 8,
    'the suggestion is the largest FEASIBLE size, not merely smaller');
});

test('a 199 GB pool refuses a 200 GB file with a truthful shortfall; 10,000 GB accepts 5,000 GB', () => {
  const small = [input({ accountId: 'a', quotaTotalBytes: 199 * GB, quotaUsedBytes: 0 })];
  const refused = preflight(small, 200 * GB);
  assert.equal(refused.canProceed, false);
  assert.equal(refused.shortfallBytes, 1 * GB);

  const big = Array.from({ length: 5 }, (_, i) => input({
    accountId: `acc-${i}`, quotaTotalBytes: 2_000 * GB, quotaUsedBytes: 0,
  }));
  const accepted = preflight(big, 5_000 * GB);
  assert.equal(accepted.canProceed, true, 'no hard-coded 200 GB / 5,000 GB product cap');
  const assigned = allocateChunks(descriptors(5_000 * GB, 64), accepted.assessment.eligible);
  assert.ok(assigned, 'the full 5,000 GB plan is placeable');
  assert.equal(assigned!.length, Math.ceil(5_000 * GB / (64 * MIB)));
});

test('a shared quota scope is counted and reserved ONCE, not once per login', () => {
  // three logins report the same 1 TB organization pool
  const pool = ['a', 'b', 'c'].map((id) => input({
    accountId: id, quotaTotalBytes: 1_000 * GB, quotaUsedBytes: 100 * GB, quotaScopeKey: 'org-pool',
  }));
  const assessment = assessCapacity(pool);
  assert.equal(assessment.totalUsableBytes, 900 * GB, '1 TB pool minus usage, counted once — not 2.7 TB');
  for (const member of assessment.eligible) {
    assert.equal(member.usableBytes, 900 * GB, 'each member draws from the same budget');
  }
  // scope-level reserve is applied once (max across members), not 3×
  const withReserve = pool.map((p) => ({ ...p, reserveBytes: 50 * GB }));
  assert.equal(assessCapacity(withReserve).totalUsableBytes, 850 * GB);

  // outstanding reservations of ANY member reduce the shared budget
  const withOutstanding = pool.map((p, i) => ({
    ...p, outstandingReservationBytes: i === 1 ? 100 * GB : 0,
  }));
  assert.equal(assessCapacity(withOutstanding).totalUsableBytes, 800 * GB);
});

test('shared-scope placements draw down one budget across members', () => {
  const pool = ['a', 'b'].map((id) => input({
    accountId: id, quotaTotalBytes: 100 * MIB, quotaUsedBytes: 0, quotaScopeKey: 'pool-x',
  }));
  const assessment = assessCapacity(pool);
  // 96 MiB is placed inside the ONE 100 MiB shared budget; 144 MiB cannot be
  assert.equal(allocateChunks(descriptors(144 * MIB, 32), assessment.eligible), null,
    'the shared pool cannot be overbooked by splitting across members');
  const fits = allocateChunks(descriptors(96 * MIB, 32), assessment.eligible);
  assert.ok(fits, '96 MiB fits the single 100 MiB shared budget');
  assert.equal(fits!.reduce((s, a) => s + a.sizeBytes, 0), 96 * MIB);
});

test('unlimited quota: eligible for plans, never a numeric total; unknown quota stays out', () => {
  const unlimited = input({ accountId: 'u', quotaTotalBytes: null, quotaUsedBytes: 5 * GIB, quotaUnlimited: true });
  const assessment = assessCapacity([unlimited]);
  assert.equal(assessment.eligible.length, 1, 'a provider-confirmed unlimited quota is real evidence');
  assert.ok(allocateChunks(descriptors(4_096 * GIB, 64), assessment.eligible),
    'an unlimited scope may satisfy a plan up to the requested bytes');

  const unknown = input({ accountId: 'k', quotaTotalBytes: null, quotaUsedBytes: null });
  assert.equal(assessCapacity([unknown]).eligible.length, 0, 'absent evidence is NOT unlimited');
  assert.equal(assessCapacity([input({ accountId: 's', quotaTotalBytes: 10 * GIB, quotaUsedBytes: 1 * GIB, quotaStatus: 'stale' })]).eligible.length, 0,
    'stale quota is not guaranteed capacity');
});

// ---- §13.C: atomic reservations, reconciliation, contention ----

test('a committed chunk keeps a reconciliation reservation with its commit-time evidence', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc', total: 100 * MIB, used: 10 * MIB });
    const plan = service.plan({ originalName: 'f.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k1' });
    const { objectKey } = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc' });
    service.commitChunk({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc', objectKey, remoteObjectId: 'r1', sha256: 'x', sizeBytes: 8 * MIB });
    const row = db.prepare('SELECT state, used_bytes_at_commit FROM upload_chunk_allocations WHERE job_id = ?')
      .get(plan.jobId) as { state: string; used_bytes_at_commit: number | null };
    assert.equal(row.state, 'uploaded_pending_quota');
    assert.equal(row.used_bytes_at_commit, 10 * MIB, 'usage snapshot captured at commit');
    const account = db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?').get('acc') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 8 * MIB, 'committed-but-unreconciled bytes stay reserved');
  } finally {
    close();
  }
});

test('a quota refresh releases committed reservations exactly once — only after usage proves propagation', () => {
  const { db, close, service, accountService } = setup();
  try {
    seedAccount(db, { id: 'acc', total: 100 * MIB, used: 10 * MIB });
    const plan = service.plan({ originalName: 'f.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k1' });
    const { objectKey } = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc' });
    service.commitChunk({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc', objectKey, remoteObjectId: 'r1', sha256: 'x', sizeBytes: 8 * MIB });

    // refresh BEFORE propagation: usage unchanged — the reservation must stay
    accountService.applyQuotaResult('acc', { totalBytes: 100 * MIB, usedBytes: 10 * MIB, status: 'current' });
    let state = (db.prepare('SELECT state FROM upload_chunk_allocations WHERE job_id = ?').get(plan.jobId) as { state: string }).state;
    assert.equal(state, 'uploaded_pending_quota', 'a successful refresh alone releases nothing');

    // usage grew, but by less than the committed bytes: retention is correct
    accountService.applyQuotaResult('acc', { totalBytes: 100 * MIB, usedBytes: 10 * MIB + 8 * MIB - 1, status: 'current' });
    state = (db.prepare('SELECT state FROM upload_chunk_allocations WHERE job_id = ?').get(plan.jobId) as { state: string }).state;
    assert.equal(state, 'uploaded_pending_quota', 'usage must grow by at least the committed bytes');

    // now usage proves the provider accounted for the chunk (baseline 10 + size 8 = 18)
    accountService.applyQuotaResult('acc', { totalBytes: 100 * MIB, usedBytes: 18 * MIB, status: 'current' });
    state = (db.prepare('SELECT state FROM upload_chunk_allocations WHERE job_id = ?').get(plan.jobId) as { state: string }).state;
    assert.equal(state, 'released', 'released exactly when evidence exists');
    const cache = (db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?').get('acc') as { reserved_inflight_bytes: number }).reserved_inflight_bytes;
    assert.equal(cache, 0, 'the cache follows the durable rows');

    // a later refresh cannot double-release or resurrect anything
    accountService.applyQuotaResult('acc', { totalBytes: 100 * MIB, usedBytes: 50 * MIB, status: 'current' });
    state = (db.prepare('SELECT state FROM upload_chunk_allocations WHERE job_id = ?').get(plan.jobId) as { state: string }).state;
    assert.equal(state, 'released');
    // the reconciled pool accepts new work again: 100 - 50 used = 50 MiB usable
    const again = service.plan({ originalName: 'g.bin', sizeBytes: 32 * MIB, chunkSizeMiB: 32, idempotencyKey: 'k2' });
    assert.equal(again.chunkCount, 1, 'the reconciled pool accepts new work');
  } finally {
    close();
  }
});

test('unknown commit baseline never auto-releases; stale observations never release', () => {
  const { db, close, service, accountService } = setup();
  try {
    // a stale observation is not trustworthy evidence even with a baseline
    seedAccount(db, { id: 'acc2', total: 100 * MIB, used: 10 * MIB });
    const plan2 = service.plan({ originalName: 'h.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k2' });
    const { objectKey: key2 } = service.beginAttempt({ jobId: plan2.jobId, chunkIndex: 0, accountId: 'acc2' });
    service.commitChunk({ jobId: plan2.jobId, chunkIndex: 0, accountId: 'acc2', objectKey: key2, remoteObjectId: 'r2', sha256: 'y', sizeBytes: 8 * MIB });
    accountService.applyQuotaResult('acc2', { totalBytes: 100 * MIB, usedBytes: 90 * MIB, status: 'stale' });
    let state = (db.prepare('SELECT state FROM upload_chunk_allocations WHERE job_id = ?').get(plan2.jobId) as { state: string }).state;
    assert.equal(state, 'uploaded_pending_quota', 'stale usage is not propagation proof');

    // a NULL commit baseline (e.g. usage was unobservable at commit) has no
    // evidence at all: even a fresh CURRENT observation releases nothing
    seedAccount(db, { id: 'acc3', total: 100 * MIB, used: 10 * MIB });
    const plan3 = service.plan({ originalName: 'n.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k3' });
    const { objectKey: key3 } = service.beginAttempt({ jobId: plan3.jobId, chunkIndex: 0, accountId: 'acc3' });
    service.commitChunk({ jobId: plan3.jobId, chunkIndex: 0, accountId: 'acc3', objectKey: key3, remoteObjectId: 'r3', sha256: 'z', sizeBytes: 8 * MIB });
    db.prepare('UPDATE upload_chunk_allocations SET used_bytes_at_commit = NULL WHERE job_id = ?').run(plan3.jobId);
    const released = reconcileUploadedPendingQuota(db, 'acc3', 90 * MIB);
    assert.equal(released, 0, 'no baseline, no release');
    state = (db.prepare('SELECT state FROM upload_chunk_allocations WHERE job_id = ?').get(plan3.jobId) as { state: string }).state;
    assert.equal(state, 'uploaded_pending_quota', 'the reservation survives until evidence exists');
  } finally {
    close();
  }
});

test('race: a 100 MiB account cannot serve two 64 MiB plans', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc', total: 100 * MIB, used: 0 });
    service.plan({ originalName: 'one.bin', sizeBytes: 64 * MIB, chunkSizeMiB: 64, idempotencyKey: 'p1' });
    assert.throws(
      () => service.plan({ originalName: 'two.bin', sizeBytes: 64 * MIB, chunkSizeMiB: 64, idempotencyKey: 'p2' }),
      (err: unknown) => err instanceof CapacityInsufficientError,
      'the second plan must be refused, not overbooked',
    );
    // and a plan that fits the remaining 36 MiB is still accepted
    const ok = service.plan({ originalName: 'three.bin', sizeBytes: 32 * MIB, chunkSizeMiB: 32, idempotencyKey: 'p3' });
    assert.equal(ok.chunkCount, 1);
  } finally {
    close();
  }
});

test('shared scope: two members cannot jointly overbook one pool through the service', () => {
  const { db, close, service } = setup();
  try {
    // both members report the SAME 100 MiB organizational pool
    seedAccount(db, { id: 'a', total: 100 * MIB, used: 0, scope: 'pool-x' });
    seedAccount(db, { id: 'b', total: 100 * MIB, used: 0, scope: 'pool-x' });
    service.plan({ originalName: 'one.bin', sizeBytes: 64 * MIB, chunkSizeMiB: 64, idempotencyKey: 'p1' });
    assert.throws(
      () => service.plan({ originalName: 'two.bin', sizeBytes: 64 * MIB, chunkSizeMiB: 64, idempotencyKey: 'p2' }),
      (err: unknown) => err instanceof CapacityInsufficientError,
      'only 36 MiB of the single shared pool remains: 64 MiB cannot be placed on either member',
    );
  } finally {
    close();
  }
});

// ---- per-account concurrency gate (§9) ----

test('a third concurrent chunk on one account is refused with account_busy', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc', total: 1_000 * MIB, used: 0 });
    const plan = service.plan({ originalName: 'f.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k1' });
    // two allocations already in flight on this account
    const rows = db.prepare("SELECT id FROM upload_chunk_allocations WHERE job_id = ? ORDER BY chunk_index LIMIT 2").all(plan.jobId) as Array<{ id: string }>;
    for (const r of rows) {
      db.prepare("UPDATE upload_chunk_allocations SET state = 'uploading' WHERE id = ?").run(r.id);
    }
    assert.throws(
      () => service.beginAttempt({ jobId: plan.jobId, chunkIndex: 2, accountId: 'acc' }),
      (err: unknown) => err instanceof Error && (err as { safeCode?: string }).safeCode === 'account_busy',
      'per-account in-flight cap is 2',
    );
    // retrying the SAME chunk that is already uploading is still allowed
    const own = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc' });
    assert.ok(own.objectKey, 'self-retry is not blocked by its own in-flight row');
  } finally {
    close();
  }
});

test('plan refusal detail explains the shortfall and the fragmentation suggestion', () => {
  const { db, close, service } = setup();
  try {
    // fragmentation: 80 MiB file, two 40 MiB accounts — total fits, chunks do not
    seedAccount(db, { id: 'a', total: 40 * MIB, used: 0 });
    seedAccount(db, { id: 'b', total: 40 * MIB, used: 0 });
    try {
      service.plan({ originalName: 'frag.bin', sizeBytes: 80 * MIB, chunkSizeMiB: 64, idempotencyKey: 'f1' });
      assert.fail('expected refusal');
    } catch (err) {
      assert.ok(err instanceof CapacityInsufficientError);
      const detail = (err as CapacityInsufficientError).detail;
      assert.equal(detail.shortfallBytes, 0, 'the pool total is sufficient — this is placement fragmentation');
      assert.equal(detail.suggestedChunkSizeMiB, 8, 'the largest feasible smaller size is offered');
    }
    // shortfall: 199 GB (decimal) pool vs 200 GB file — the two 40 MiB
    // accounts from the fragmentation case still contribute their bytes, so
    // the exact shortfall is 1 GB minus their 80 MiB
    seedAccount(db, { id: 'c', total: 199 * GB, used: 0 });
    try {
      service.plan({ originalName: 'big.bin', sizeBytes: 200 * GB, chunkSizeMiB: 64, idempotencyKey: 'f2' });
      assert.fail('expected refusal');
    } catch (err) {
      assert.ok(err instanceof CapacityInsufficientError);
      const detail = (err as CapacityInsufficientError).detail;
      assert.equal(detail.shortfallBytes, 1 * GB - 80 * MIB);
      assert.equal(detail.suggestedChunkSizeMiB, null, 'smaller chunks cannot fix a real shortfall');
      assert.ok(detail.accounts.every((a) => typeof a.reasonCode === 'string' || a.reasonCode === null));
    }
  } finally {
    close();
  }
});

// ---- provider_no_space marks quota stale (§7.3) ----

test('provider_no_space marks the account quota stale', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc', total: 10 * MIB, used: 0 });
    service.markQuotaStale('acc', 'provider_no_space');
    const row = db.prepare('SELECT quota_status, last_quota_error_code FROM provider_accounts WHERE id = ?').get('acc') as { quota_status: string; last_quota_error_code: string };
    assert.equal(row.quota_status, 'stale');
    assert.equal(row.last_quota_error_code, 'provider_no_space');
  } finally {
    close();
  }
});

// ---- §10/§13.E: restart reconciliation ----

test('restart reconciles in-flight attempts without losing cleanup obligations', () => {
  const { db, close, service } = setup();
  try {
    seedAccount(db, { id: 'acc', total: 1_000 * MIB, used: 0 });
    // 24 MiB sits above the 20 MiB single-object threshold: three real chunks,
    // so chunk indexes 0 and 1 below are both valid multi-chunk attempts
    const plan = service.plan({ originalName: 'f.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, idempotencyKey: 'k1' });
    const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'acc' });
    const a1 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 1, accountId: 'acc' });
    // chunk 1's response was lost: the provider may hold the object
    db.prepare("UPDATE upload_attempts SET remote_object_id = 'remote-1' WHERE object_key = ?").run(a1.objectKey);

    const report = service.recoverOnStartup();
    assert.equal(report.recovered, 1, 'the running job is paused');
    const job = db.prepare('SELECT state FROM transfer_jobs WHERE id = ?').get(plan.jobId) as { state: string };
    assert.equal(job.state, 'paused');
    const states = db.prepare('SELECT object_key, state FROM upload_attempts WHERE job_id = ?').all(plan.jobId) as Array<{ object_key: string; state: string }>;
    assert.equal(states.find((s) => s.object_key === a0.objectKey)!.state, 'failed', 'no remote object known -> plain failure');
    assert.equal(states.find((s) => s.object_key === a1.objectKey)!.state, 'cleanup_pending', 'possible live object -> durable cleanup obligation');
    assert.equal(service.pendingCleanups().length, 1, 'the obligation survives for retryPendingCleanups');
    // allocations of a paused job keep their reservations (the chunks are still owed)
    const reserved = db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM upload_chunk_allocations WHERE job_id = ? AND state IN ('reserved','uploading')").get(plan.jobId) as { n: number };
    assert.equal(reserved.n, 24 * MIB);
  } finally {
    close();
  }
});

// ---- owner-confirmed shared-pool grouping (§6.2) ----

test('quota scope grouping is explicit, per provider, and clearable', () => {
  const { db, close, accountService } = setup();
  try {
    seedAccount(db, { id: 'g1', provider: 'google_drive', total: 100 * MIB, used: 0 });
    seedAccount(db, { id: 'g2', provider: 'google_drive', total: 100 * MIB, used: 0 });
    seedAccount(db, { id: 'g3', provider: 'google_drive', total: 100 * MIB, used: 0 });
    seedAccount(db, { id: 'd1', provider: 'dropbox', total: 100 * MIB, used: 0 });
    assert.throws(
      () => accountService.setQuotaScope('google_drive', ['g1']),
      (err: unknown) => err instanceof Error && /shared pool needs at least two/.test(err.message),
      'a pool needs at least two accounts',
    );
    assert.throws(
      () => accountService.setQuotaScope('google_drive', ['g1', 'd1']),
      (err: unknown) => err instanceof Error && /does not belong/.test(err.message),
      'cross-provider grouping is refused',
    );
    const grouped = accountService.setQuotaScope('google_drive', ['g1', 'g2']);
    const scoped = grouped.filter((r) => r.quota_scope !== null);
    assert.equal(scoped.length, 2, 'exactly the listed members share one key');
    assert.equal(new Set(scoped.map((r) => r.quota_scope)).size, 1, 'one shared key');
    assert.equal(grouped.find((r) => r.id === 'g3')!.quota_scope, null, 'unlisted accounts are untouched');
    const cleared = accountService.setQuotaScope('google_drive', null);
    assert.ok(cleared.every((r) => r.quota_scope === null), 'clear restores independent quotas');
  } finally {
    close();
  }
});

// ---- §13.F: large-plan stress without a large payload ----

test('metadata stress: 5,000 GB at 64 MiB plans and places 74,506 chunks in bounded time/memory', () => {
  const inputs = Array.from({ length: 5 }, (_, i) => input({
    accountId: `acc-${i}`, quotaTotalBytes: 2_100 * GB, quotaUsedBytes: 0,
  }));
  const t0 = process.hrtime.bigint();
  const plan = planChunks(5_000 * GB, 64 * MIB);
  assert.equal(plan.chunkCount, 74_506, 'exact decimal-GB chunk count');
  const desc = descriptors(5_000 * GB, 64);
  const assessment = assessCapacity(inputs);
  const assigned = allocateChunks(desc, assessment.eligible);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(assigned, 'the full plan is placeable');
  assert.equal(assigned!.length, 74_506);
  // no account may exceed its usable bytes
  const perAccount = new Map<string, number>();
  for (const a of assigned!) perAccount.set(a.accountId, (perAccount.get(a.accountId) ?? 0) + a.sizeBytes);
  for (const [accountId, bytes] of perAccount) {
    assert.ok(bytes <= assessment.eligible.find((e) => e.accountId === accountId)!.usableBytes);
  }
  assert.ok(elapsedMs < 10_000, `metadata planning stayed bounded (took ${elapsedMs.toFixed(0)}ms)`);
  console.log(`  [stress] 74,506-chunk metadata plan: ${elapsedMs.toFixed(0)}ms, RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)}MiB`);
});

test('metadata stress: a full DB plan() persists 74,506 durable reservations without materializing the file', () => {
  const { db, close, service } = setup();
  try {
    for (let i = 0; i < 5; i++) {
      seedAccount(db, { id: `acc-${i}`, total: 2_100 * GIB, used: 0 });
    }
    const t0 = process.hrtime.bigint();
    const plan = service.plan({
      originalName: 'huge.bin', sizeBytes: 5_000 * GB, chunkSizeMiB: 64, idempotencyKey: 'stress-1',
    });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(plan.allocations.length, 74_506);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM upload_chunk_allocations WHERE job_id = ?').get(plan.jobId) as { n: number }).n;
    assert.equal(rows, 74_506, 'every chunk has a durable reservation row');
    const reserved = (db.prepare('SELECT SUM(reserved_inflight_bytes) AS n FROM provider_accounts').get() as { n: number }).n;
    assert.equal(reserved, 5_000 * GB, 'the whole file is reserved');
    assert.ok(elapsedMs < 30_000, `transactional insert stayed bounded (took ${elapsedMs.toFixed(0)}ms)`);
    console.log(`  [stress] 74,506-row durable plan: ${elapsedMs.toFixed(0)}ms`);
    // idempotent replay of the same key does not duplicate rows
    const replay = service.plan({ originalName: 'huge.bin', sizeBytes: 5_000 * GB, chunkSizeMiB: 64, idempotencyKey: 'stress-1' });
    assert.equal(replay.jobId, plan.jobId);
    assert.equal(replay.reused, true);
    const rowsAfter = (db.prepare('SELECT COUNT(*) AS n FROM upload_chunk_allocations WHERE job_id = ?').get(plan.jobId) as { n: number }).n;
    assert.equal(rowsAfter, 74_506, 'no duplicate reservations on replay');
  } finally {
    close();
  }
});
