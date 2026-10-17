import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import { makeUploadQueries, type AllocationRow, type FileRow } from '../db/upload-queries.js';
import { makeProviderQueries } from '../db/provider-queries.js';
import { generateObjectKey } from '../uploads/chunk-math.js';
import { assessCapacity, type AccountCapacityInput } from '../uploads/capacity.js';
import { PROVIDER_UPLOAD_READY, compareProviderChecksum } from '../uploads/upload-service.js';
import { globalDownloadBudget, type MemoryBudget } from '../downloads/memory-budget.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError, type AccountTier } from '../providers/types.js';
import type { CredentialsStore } from '../providers/credentials-store.js';
import { recordProviderCall, recordProviderBytes } from '../metrics/provider-metrics.js';

/**
 * Roadmap Phase 5 — optional chunk mirroring (§3 Phase 5, §4.5 UI).
 *
 * A mirror job copies every chunk of a COMPLETED file to a SECOND account of
 * the same tier, so losing one account no longer makes the file unusable.
 *
 * Rules:
 * - the durable engine is reused, not reimplemented: a mirror job is a real
 *   `transfer_jobs` row (job_type 'mirror'), its per-chunk reservations are
 *   real `upload_chunk_allocations` rows (so concurrent planners see the
 *   reserved bytes), and its remote objects are anchored by real
 *   `upload_attempts` rows (a crash mid-copy leaves a durable cleanup
 *   obligation, never a silent orphan);
 * - the source bytes are verified against the chunk's stored SHA-256 BEFORE
 *   they are written anywhere; the destination placement is honest —
 *   'verified' only when the provider returned a comparable matching
 *   checksum, otherwise 'uploaded' (the B6 rule, unchanged);
 * - the copy is sequential, one chunk at a time; a resumed job skips chunks
 *   that already carry an active mirror placement (idempotent);
 * - nothing here invents capacity: the target must pass the same capacity
 *   assessment the planner uses, minus accounts already holding this chunk.
 */

export class MirrorError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

interface ActivePlacementRow {
  id: string;
  provider_account_id: string;
  remote_object_id: string | null;
  state: string;
  placement_role: string | null;
}

export interface MirrorProcessResult {
  state: 'completed' | 'failed';
  mirrored: number;
  skipped: number;
  failed: number;
}

export class MirrorService {
  private readonly q;
  private readonly providerQ;
  private readonly insertMirrorPlacement;

  constructor(
    private readonly db: Database.Database,
    private readonly store: CredentialsStore,
    /** The SAME capacity inputs the upload planner uses (never a parallel math). */
    private readonly capacityInputs: (tier: AccountTier) => AccountCapacityInput[],
    /** Lazily creates the CloudNest root on a target account (uploads.ensureOrCreateRoot). */
    private readonly ensureRoot: (accountId: string) => Promise<string>,
    private readonly budget: MemoryBudget = globalDownloadBudget,
  ) {
    this.q = makeUploadQueries(db);
    this.providerQ = makeProviderQueries(db);
    // the mirror copy is born active with its role — one statement, no post-hoc UPDATE
    this.insertMirrorPlacement = db.prepare(
      `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, remote_object_key,
        state, is_active, placement_role, provider_checksum_type, confirmed_size_bytes, last_safe_error_code, created_at, updated_at)
       VALUES (@id, @chunk_id, @provider_account_id, @remote_object_id, @remote_object_key, @state, 1, 'mirror',
        @provider_checksum_type, @confirmed_size_bytes, NULL, @created_at, @updated_at)`,
    );
  }

  /**
   * Queue a mirror job for a completed file. The owner scope follows the
   * Phase 3 rule: a member naming a foreign file gets the same 404.
   */
  enqueue(ownerUserId: string | null, fileId: string): { jobId: string; state: string } {
    const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!file || (ownerUserId !== null && file.user_id !== ownerUserId)) {
      throw new MirrorError('file_not_found', 404);
    }
    if (file.state !== 'completed') throw new MirrorError('file_not_complete', 409);
    if (file.trashed_at !== null) throw new MirrorError('file_trashed', 409);
    if (file.chunk_count === 0) throw new MirrorError('nothing_to_mirror', 409);

    const existing = this.db.prepare(
      `SELECT id, state FROM transfer_jobs
       WHERE job_type = 'mirror' AND file_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(fileId) as { id: string; state: string } | undefined;
    if (existing && existing.state !== 'completed' && existing.state !== 'cancelled') {
      throw new MirrorError('mirror_job_active', 409);
    }
    if (existing && existing.state === 'completed') {
      // re-mirroring is only meaningful when some chunk lost its mirror copy
      if (this.mirroredChunkCount(fileId) >= file.chunk_count) {
        throw new MirrorError('already_mirrored', 409);
      }
    }

    // honest preflight: a mirror needs at least one OTHER connected, upload-capable
    // account in the file's own tier — the accounts already holding its chunks
    // are the sources, never targets. Per-chunk feasibility is still checked at
    // process time; this gate only refuses work that cannot even start.
    const holders = new Set(
      (this.db.prepare(
        `SELECT DISTINCT p.provider_account_id AS id FROM chunk_placements p
         JOIN file_chunks c ON c.id = p.chunk_id
         WHERE c.file_id = ? AND p.is_active = 1`,
      ).all(fileId) as Array<{ id: string }>).map((r) => r.id),
    );
    const tierAccounts = this.capacityInputs(file.tier ?? 'personal')
      .filter((a) => a.status === 'connected' && PROVIDER_UPLOAD_READY.has(a.provider) && !holders.has(a.accountId));
    if (tierAccounts.length === 0) throw new MirrorError('mirror_no_target', 409);

    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const txn = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
          retry_count, last_safe_error_code, created_at, updated_at)
         VALUES (?, ?, 'mirror', 'queued', 0, ?, 0, 0, NULL, ?, ?)`,
      ).run(jobId, fileId, file.chunk_count, now, now);
    });
    txn();
    return { jobId, state: 'queued' };
  }

  /** Latest mirror job for a file, shaped for the routes. */
  jobForFile(fileId: string): {
    jobId: string; state: string; chunksCompleted: number; chunksTotal: number; safeErrorCode: string | null;
  } | null {
    const job = this.db.prepare(
      `SELECT id, state, chunks_completed, chunks_total, last_safe_error_code FROM transfer_jobs
       WHERE job_type = 'mirror' AND file_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(fileId) as {
      id: string; state: string; chunks_completed: number; chunks_total: number; last_safe_error_code: string | null;
    } | undefined;
    if (!job) return null;
    return {
      jobId: job.id,
      state: job.state,
      chunksCompleted: job.chunks_completed,
      chunksTotal: job.chunks_total,
      safeErrorCode: job.last_safe_error_code,
    };
  }

  /** Phase 3 ownership check for a mirror job (foreign job = same 404). */
  jobFileOwner(jobId: string): string | null {
    const row = this.db.prepare(
      `SELECT f.user_id AS user_id FROM transfer_jobs j JOIN files f ON f.id = j.file_id
       WHERE j.id = ? AND j.job_type = 'mirror'`,
    ).get(jobId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /** How many chunks of a file carry a live mirror copy. */
  mirroredChunkCount(fileId: string): number {
    return (this.db.prepare(
      `SELECT COUNT(DISTINCT c.chunk_index) AS n
       FROM chunk_placements p JOIN file_chunks c ON c.id = p.chunk_id
       WHERE c.file_id = ? AND p.is_active = 1 AND p.placement_role = 'mirror'`,
    ).get(fileId) as { n: number }).n;
  }

  /** Ordered candidate sources for a chunk: primary first, verified before uploaded. */
  private sourceCandidates(chunkId: string): ActivePlacementRow[] {
    const rows = this.db.prepare(
      `SELECT id, provider_account_id, remote_object_id, state, placement_role
       FROM chunk_placements WHERE chunk_id = ? AND is_active = 1`,
    ).all(chunkId) as ActivePlacementRow[];
    const rank = (p: ActivePlacementRow): number => {
      const roleRank = p.placement_role === 'mirror' ? 1 : 0;
      const stateRank = p.state === 'verified' ? 0 : p.state === 'uploaded' ? 1 : 2;
      return roleRank * 10 + stateRank;
    };
    return rows.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }

  /**
   * Pick the mirror target for one chunk: same tier, upload-capable, connected,
   * NOT already holding an active copy of this chunk, and capacity-feasible for
   * exactly these bytes under the planner's own math. Most usable space wins.
   */
  private chooseTarget(file: FileRow, chunkId: string, sizeBytes: number): string | null {
    const holders = new Set(
      (this.db.prepare(
        'SELECT provider_account_id FROM chunk_placements WHERE chunk_id = ? AND is_active = 1',
      ).all(chunkId) as Array<{ provider_account_id: string }>).map((r) => r.provider_account_id),
    );
    const inputs = this.capacityInputs(file.tier ?? 'personal')
      .filter((a) => PROVIDER_UPLOAD_READY.has(a.provider) && !holders.has(a.accountId));
    const assessed = assessCapacity(inputs);
    const best = assessed.eligible
      .filter((a) => a.usableBytes >= sizeBytes)
      .sort((a, b) => (b.usableBytes - a.usableBytes) || a.accountId.localeCompare(b.accountId))[0];
    return best?.accountId ?? null;
  }

  /** Read one source copy fully, verifying size + SHA-256 while HOLDING the budget. */
  private async readVerifiedSource(
    source: ActivePlacementRow,
    expectedSha256: string,
    expectedBytes: number,
  ): Promise<{ bytes: Buffer; release: () => void }> {
    const account = this.providerQ.getAccount.get(source.provider_account_id) as
      | { id: string; provider: string } | undefined;
    if (!account || !source.remote_object_id) throw new MirrorError('source_unavailable', 409);
    const adapter = getAdapter(account.provider);
    if (!adapter?.downloadObjectStream) throw new MirrorError('provider_unavailable', 502);
    const bundle = this.store.loadAccountBundle(account as unknown as Parameters<CredentialsStore['loadAccountBundle']>[0]);
    if (!bundle) throw new MirrorError('account_needs_reauth', 409);
    const appConfig = account.provider === 'mega' || account.provider === 'pcloud'
      ? undefined
      : this.store.getConfig(account.provider)?.config ?? undefined;

    const release = await this.budget.acquire(expectedBytes);
    try {
      const out = await adapter.downloadObjectStream(bundle, source.remote_object_id, appConfig);
      const parts: Buffer[] = [];
      let received = 0;
      for await (const piece of out.stream) {
        const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as unknown as Uint8Array);
        received += buf.length;
        if (received > expectedBytes) throw new MirrorError('chunk_hash_mismatch', 502);
        parts.push(buf);
      }
      const payload = Buffer.concat(parts);
      if (payload.length !== expectedBytes) throw new MirrorError('chunk_hash_mismatch', 502);
      const digest = crypto.createHash('sha256').update(payload).digest('hex');
      if (digest !== expectedSha256) throw new MirrorError('chunk_hash_mismatch', 502);
      recordProviderCall(account.provider, true, null);
      recordProviderBytes(account.provider, 'down', payload.length);
      // the caller owns `release`: the bytes stay resident until the target
      // upload finishes, exactly like a download prefetch holds its reservation
      return { bytes: payload, release };
    } catch (err) {
      recordProviderCall(account.provider, false, err instanceof ProviderError ? err.safeCode : null);
      release();
      throw err;
    }
  }

  /**
   * Process a mirror job chunk by chunk. Each chunk is independent: a failure
   * records its honest code on the job and continues with the rest, and the
   * job only completes when every chunk carries an active mirror placement.
   */
  async process(jobId: string): Promise<MirrorProcessResult> {
    const job = this.db.prepare("SELECT * FROM transfer_jobs WHERE id = ? AND job_type = 'mirror'")
      .get(jobId) as { id: string; file_id: string; state: string; chunks_total: number } | undefined;
    if (!job?.file_id) throw new MirrorError('job_not_found', 404);
    if (job.state === 'completed') {
      return { state: 'completed', mirrored: 0, skipped: this.mirroredChunkCount(job.file_id), failed: 0 };
    }
    const file = this.q.getFile.get(job.file_id) as FileRow | undefined;
    if (!file) throw new MirrorError('job_not_found', 404);
    this.db.prepare("UPDATE transfer_jobs SET state = 'running', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), jobId);

    let mirrored = 0;
    let skipped = 0;
    let failed = 0;
    let firstError: string | null = null;

    for (let chunkIndex = 0; chunkIndex < job.chunks_total; chunkIndex++) {
      const chunk = this.q.getChunk.get(file.id, chunkIndex) as
        | { id: string; size_bytes: number; sha256: string; offset_bytes: number } | undefined;
      if (!chunk) {
        failed++;
        firstError ??= 'chunk_missing';
        continue;
      }
      // idempotent resume: a chunk that already has a live mirror copy is done
      if ((this.db.prepare(
        'SELECT COUNT(*) AS n FROM chunk_placements WHERE chunk_id = ? AND is_active = 1 AND placement_role = \'mirror\'',
      ).get(chunk.id) as { n: number }).n > 0) {
        skipped++;
        this.updateProgress(jobId, file.id);
        continue;
      }
      try {
        await this.mirrorOneChunk(jobId, file, chunkIndex, chunk);
        mirrored++;
      } catch (err) {
        failed++;
        const code = err instanceof MirrorError
          ? err.safeCode
          : err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
        firstError ??= code;
        this.db.prepare(
          'UPDATE transfer_jobs SET last_safe_error_code = ?, updated_at = ? WHERE id = ?',
        ).run(code, new Date().toISOString(), jobId);
      }
      this.updateProgress(jobId, file.id);
    }

    const done = new Date().toISOString();
    const state: 'completed' | 'failed' = failed === 0 ? 'completed' : 'failed';
    this.db.prepare(
      'UPDATE transfer_jobs SET state = ?, last_safe_error_code = COALESCE(last_safe_error_code, ?), updated_at = ? WHERE id = ?',
    ).run(state, firstError, done, jobId);
    // reservations the finished/cleaned-up attempts no longer hold
    this.db.prepare(
      `UPDATE provider_accounts SET reserved_inflight_bytes = COALESCE((
         SELECT COALESCE(SUM(size_bytes), 0) FROM upload_chunk_allocations
         WHERE provider_account_id = provider_accounts.id AND state IN ('reserved','uploading','uploaded_pending_quota')
       ), 0)`,
    ).run();
    return { state, mirrored, skipped, failed };
  }

  private updateProgress(jobId: string, fileId: string): void {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(fc.size_bytes), 0) AS bytes
       FROM chunk_placements p JOIN file_chunks fc ON fc.id = p.chunk_id
       WHERE fc.file_id = ? AND p.is_active = 1 AND p.placement_role = 'mirror'`,
    ).get(fileId) as { n: number; bytes: number };
    this.q.updateJobProgress.run({
      id: jobId, chunks_completed: row.n, bytes_completed: row.bytes,
      last_safe_error_code: null, updated_at: new Date().toISOString(),
    });
  }

  /** Copy one chunk: reserve on the target, verify the source, write, commit honestly. */
  private async mirrorOneChunk(
    jobId: string,
    file: FileRow,
    chunkIndex: number,
    chunk: { id: string; size_bytes: number; sha256: string; offset_bytes: number },
  ): Promise<void> {
    const sources = this.sourceCandidates(chunk.id);
    if (sources.length === 0) throw new MirrorError('source_unavailable', 409);
    const targetAccountId = this.chooseTarget(file, chunk.id, chunk.size_bytes);
    if (!targetAccountId) throw new MirrorError('mirror_no_target', 409);
    const target = this.providerQ.getAccount.get(targetAccountId) as
      | { id: string; provider: string } | undefined;
    if (!target) throw new MirrorError('mirror_no_target', 409);
    const targetAdapter = getAdapter(target.provider);
    if (!targetAdapter?.uploadObjectStream || !targetAdapter.capabilities.upload) {
      throw new MirrorError('provider_unavailable', 502);
    }

    const now = new Date().toISOString();
    // durable reservation BEFORE any byte moves — the planner's own math sees it
    const existing = this.q.getAllocation.get(jobId, chunkIndex) as AllocationRow | undefined;
    const allocationId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      this.q.insertAllocation.run({
        id: allocationId, job_id: jobId, chunk_index: chunkIndex,
        provider_account_id: targetAccountId, size_bytes: chunk.size_bytes, offset_bytes: chunk.offset_bytes,
        created_at: now, updated_at: now,
      });
    } else {
      // a resumed job's interrupted attempt: point the same durable row at the
      // new target instead of creating a second reservation
      this.q.reassignAllocation.run({ id: allocationId, provider_account_id: targetAccountId, updated_at: now });
    }

    // attempt row anchors the remote object BEFORE bytes are sent (UL-3 anchor)
    const attemptId = crypto.randomUUID();
    const objectKey = generateObjectKey(file.id, chunkIndex, attemptId);
    const attemptTxn = this.db.transaction(() => {
      this.q.insertAttempt.run({
        id: attemptId, job_id: jobId, chunk_index: chunkIndex,
        provider_account_id: targetAccountId, object_key: objectKey,
        resume_ciphertext: null, resume_nonce: null, resume_auth_tag: null, resume_key_version: null,
        created_at: now, updated_at: now,
      });
      this.q.markAllocationUploading.run(now, allocationId);
    });
    attemptTxn();

    let releaseBudget: (() => void) | null = null;
    try {
      const rootId = await this.ensureRoot(targetAccountId);
      const targetBundle = this.store.loadAccountBundle(target as unknown as Parameters<CredentialsStore['loadAccountBundle']>[0]);
      if (!targetBundle) throw new MirrorError('account_needs_reauth', 409);
      const targetAppConfig = target.provider === 'mega' || target.provider === 'pcloud'
        ? undefined
        : this.store.getConfig(target.provider)?.config ?? undefined;

      // verified bytes: try each source copy in order until one verifies
      let bytes: Buffer | null = null;
      let lastError: unknown = null;
      for (const source of sources) {
        try {
          const read = await this.readVerifiedSource(source, chunk.sha256, chunk.size_bytes);
          bytes = read.bytes;
          releaseBudget = read.release;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!bytes) {
        throw lastError instanceof Error ? lastError : new MirrorError('source_unavailable', 409);
      }

      const ref = await targetAdapter.uploadObjectStream(targetBundle, {
        rootId,
        objectKey,
        name: objectKey,
        readable: Readable.from(bytes),
        sizeBytes: chunk.size_bytes,
      });
      recordProviderCall(target.provider, true, null);
      recordProviderBytes(target.provider, 'up', bytes.length);

      const commitTxn = this.db.transaction(() => {
        this.q.markAttemptCommitted.run(new Date().toISOString(), attemptId);
        // B6 honesty, unchanged: a comparable checksum that MATCHES earns
        // 'verified'; anything else stays 'uploaded'
        this.insertMirrorPlacement.run({
          id: crypto.randomUUID(), chunk_id: chunk.id, provider_account_id: targetAccountId,
          remote_object_id: ref.remoteObjectId, remote_object_key: objectKey,
          state: compareProviderChecksum(ref.providerChecksum, chunk.sha256) === 'match'
            ? 'verified'
            : 'uploaded',
          provider_checksum_type: ref.providerChecksum?.type ?? null,
          confirmed_size_bytes: ref.sizeBytes ?? chunk.size_bytes,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        this.q.markAllocationUploadedPendingQuota.run(new Date().toISOString(), allocationId);
        const accountAtCommit = this.providerQ.getAccount.get(targetAccountId) as { used_bytes: number | null } | undefined;
        this.q.setAllocationCommitBaseline.run(accountAtCommit?.used_bytes ?? null, allocationId);
      });
      commitTxn();
    } catch (err) {
      const code = err instanceof MirrorError
        ? err.safeCode
        : err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      if (err instanceof ProviderError) recordProviderCall(target.provider, false, err.safeCode);
      const ts = new Date().toISOString();
      const attempt = this.q.getAttempt.get(attemptId) as { remote_object_id: string | null } | undefined;
      const failTxn = this.db.transaction(() => {
        if (attempt?.remote_object_id) {
          // a live remote object may exist: the obligation is recorded before
          // anything else so no path can forget it (UL-3, unchanged)
          this.q.markAttemptCleanupPending.run({ id: attemptId, safe_error_code: code, updated_at: ts });
        } else {
          this.q.markAttemptFailed.run({ id: attemptId, safe_error_code: code, bytes_received: 0, updated_at: ts });
        }
        this.q.markAllocationReleased.run(ts, allocationId);
      });
      failTxn();
      throw err instanceof Error ? err : new MirrorError(code, 502);
    } finally {
      releaseBudget?.();
    }
  }

  /** Retry a mirror job; refuses one that already finished cleanly. */
  async retry(jobId: string): Promise<MirrorProcessResult> {
    const job = this.db.prepare("SELECT state FROM transfer_jobs WHERE id = ? AND job_type = 'mirror'")
      .get(jobId) as { state: string } | undefined;
    if (!job) throw new MirrorError('job_not_found', 404);
    if (job.state === 'completed') throw new MirrorError('job_already_completed', 409);
    return this.process(jobId);
  }

  /** Startup + scheduler: queued, interrupted (running) and failed jobs continue. */
  async resumePending(): Promise<{ attempted: number; completed: number }> {
    const jobs = this.db.prepare(
      `SELECT id FROM transfer_jobs WHERE job_type = 'mirror' AND state IN ('queued','running','failed')
       ORDER BY created_at`,
    ).all() as Array<{ id: string }>;
    let completed = 0;
    for (const job of jobs) {
      try {
        const result = await this.process(job.id);
        if (result.state === 'completed') completed++;
      } catch {
        // stays recorded; the next sweep or an explicit retry drives it again
      }
    }
    return { attempted: jobs.length, completed };
  }
}
