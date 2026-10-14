import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { makeProviderQueries } from '../db/provider-queries.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import type { CredentialsStore } from '../providers/credentials-store.js';
import type { ShareService } from '../shares/share-service.js';

/**
 * Logical file deletion (M11.d).
 *
 * Rules:
 * - deletion never cascades blindly: every CloudNest-owned placement is
 *   attempted individually and its outcome recorded;
 * - a file is only marked `deleted` once all of its remote objects are gone or
 *   proven absent; anything unresolved keeps the job in `deletion_pending`;
 * - only objects CloudNest itself placed are touched; unrelated user files are
 *   never listed or removed.
 */

export class DeletionError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

interface PlacementToDelete {
  placementId: string;
  chunkId: string;
  chunkIndex: number;
  providerAccountId: string;
  remoteObjectId: string | null;
  isActive: number;
}

export class DeletionService {
  private readonly providerQ;
  constructor(
    private readonly db: Database.Database,
    private readonly store: CredentialsStore,
    private readonly shares: ShareService,
  ) {
    this.providerQ = makeProviderQueries(db);
  }

  /** Queue a durable deletion job. Returns the job id and its initial state. */
  enqueue(fileId: string): { jobId: string; state: string } {
    const file = this.db.prepare('SELECT id, state FROM files WHERE id = ?').get(fileId) as
      | { id: string; state: string }
      | undefined;
    if (!file) throw new DeletionError('file_not_found', 404);
    if (file.state === 'deleted') return { jobId: '', state: 'deleted' };

    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const txn = this.db.transaction(() => {
      // links must not outlive their files
      this.shares.revokeLinksForFile(fileId);
      this.db.prepare(
        `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
          retry_count, last_safe_error_code, created_at, updated_at)
         VALUES (?, ?, 'delete', 'queued', 0, 0, 0, 0, NULL, ?, ?)`,
      ).run(jobId, fileId, now, now);
      this.db.prepare("UPDATE files SET state = 'deletion_pending' WHERE id = ?").run(fileId);
    });
    txn();
    return { jobId, state: 'queued' };
  }

  private placementsForFile(fileId: string): PlacementToDelete[] {
    return this.db.prepare(
      `SELECT p.id AS placementId, p.chunk_id AS chunkId, c.chunk_index AS chunkIndex,
              p.provider_account_id AS providerAccountId, p.remote_object_id AS remoteObjectId,
              p.is_active AS isActive
       FROM chunk_placements p
       JOIN file_chunks c ON c.id = p.chunk_id
       WHERE c.file_id = ?
       ORDER BY c.chunk_index, p.created_at`,
    ).all(fileId) as PlacementToDelete[];
  }

  private async deleteOne(placement: PlacementToDelete): Promise<'deleted' | 'not_found' | 'failed' | 'cleanup_pending'> {
    const account = this.providerQ.getAccount.get(placement.providerAccountId) as
      | { id: string; provider: string }
      | undefined;
    if (!account) return 'cleanup_pending';
    const adapter = getAdapter(account.provider);
    if (!adapter?.deleteAppObject) return 'cleanup_pending';
    if (!placement.remoteObjectId) return 'cleanup_pending';

    const root = this.db
      .prepare('SELECT remote_root_id FROM provider_account_roots WHERE provider_account_id = ?')
      .get(account.id) as { remote_root_id: string } | undefined;
    const row = this.providerQ.getAccount.get(account.id) as Parameters<CredentialsStore['loadAccountBundle']>[0] | undefined;
    if (!row) return 'cleanup_pending';
    const bundle = this.store.loadAccountBundle(row);
    if (!bundle) return 'cleanup_pending';
    const appConfig = account.provider === 'mega' || account.provider === 'pcloud'
      ? undefined
      : this.store.getConfig(account.provider)?.config ?? undefined;
    try {
      await adapter.deleteAppObject(bundle, root?.remote_root_id ?? '', placement.remoteObjectId, appConfig);
      return 'deleted';
    } catch (err) {
      if (err instanceof ProviderError && err.safeCode === 'provider_object_missing') return 'not_found';
      return 'failed';
    }
  }

  /**
   * Process a deletion job. Each placement is attempted independently; a
   * failure never stops the others and never claims a clean finish.
   */
  async process(jobId: string): Promise<{
    state: string;
    deleted: number;
    notFound: number;
    failed: number;
    pending: number;
  }> {
    const job = this.db.prepare('SELECT * FROM transfer_jobs WHERE id = ? AND job_type = ?')
      .get(jobId, 'delete') as { id: string; file_id: string; state: string } | undefined;
    if (!job || !job.file_id) throw new DeletionError('file_not_found', 404);
    if (job.state === 'completed') {
      return { state: 'completed', deleted: 0, notFound: 0, failed: 0, pending: 0 };
    }
    const fileId = job.file_id;
    const placements = this.placementsForFile(fileId);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE transfer_jobs SET state = 'running', updated_at = ? WHERE id = ?").run(now, jobId);

    let deleted = 0;
    let notFound = 0;
    let failed = 0;
    let pending = 0;

    for (const placement of placements) {
      const attemptId = crypto.randomUUID();
      this.db.prepare(
        `INSERT INTO deletion_attempts (id, job_id, file_id, chunk_id, provider_account_id, remote_object_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(attemptId, jobId, fileId, placement.chunkId, placement.providerAccountId, placement.remoteObjectId, now, now);

      const outcome = await this.deleteOne(placement);
      const ts = new Date().toISOString();
      if (outcome === 'deleted' || outcome === 'not_found') {
        this.db.prepare('UPDATE deletion_attempts SET state = ?, updated_at = ? WHERE id = ?')
          .run(outcome === 'deleted' ? 'deleted' : 'not_found', ts, attemptId);
        // the remote object is gone: retire the placement record
        this.db.prepare(
          "UPDATE chunk_placements SET state = 'deleted', is_active = 0, updated_at = ? WHERE id = ?",
        ).run(ts, placement.placementId);
        if (outcome === 'deleted') deleted++; else notFound++;
      } else {
        this.db.prepare('UPDATE deletion_attempts SET state = ?, last_safe_error_code = ?, updated_at = ? WHERE id = ?')
          .run(outcome, outcome === 'failed' ? 'provider_unavailable' : 'cleanup_pending', ts, attemptId);
        if (outcome === 'failed') failed++; else pending++;
      }
    }

    const finished = new Date().toISOString();
    const clean = failed === 0 && pending === 0;
    const txn = this.db.transaction(() => {
      if (clean) {
        // every remote object is confirmed gone: retire the chunk map and the file
        this.db.prepare('DELETE FROM file_chunks WHERE file_id = ?').run(fileId);
        this.db.prepare("UPDATE files SET state = 'deleted' WHERE id = ?").run(fileId);
        this.db.prepare(
          "UPDATE transfer_jobs SET state = 'completed', last_safe_error_code = NULL, updated_at = ? WHERE id = ?",
        ).run(finished, jobId);
      } else {
        this.db.prepare("UPDATE files SET state = 'deletion_pending' WHERE id = ?").run(fileId);
        this.db.prepare(
          "UPDATE transfer_jobs SET state = 'deletion_pending', last_safe_error_code = 'cleanup_pending', updated_at = ? WHERE id = ?",
        ).run(finished, jobId);
      }
    });
    txn();

    return {
      state: clean ? 'completed' : 'deletion_pending',
      deleted, notFound, failed, pending,
    };
  }

  /** Retry a pending deletion; refuses a job that already finished cleanly. */
  async retry(jobId: string): Promise<ReturnType<DeletionService['process']>> {
    const job = this.db.prepare('SELECT state FROM transfer_jobs WHERE id = ? AND job_type = ?')
      .get(jobId, 'delete') as { state: string } | undefined;
    if (!job) throw new DeletionError('file_not_found', 404);
    if (job.state === 'completed') throw new DeletionError('job_already_completed', 409);
    return this.process(jobId);
  }

  /** Jobs still owing remote cleanup. */
  pendingJobs(): Array<{ jobId: string; fileId: string; state: string; safeErrorCode: string | null }> {
    return (this.db.prepare(
      "SELECT id, file_id, state, last_safe_error_code FROM transfer_jobs WHERE job_type = 'delete' AND state IN ('queued','running','deletion_pending') ORDER BY created_at",
    ).all() as Array<{ id: string; file_id: string; state: string; last_safe_error_code: string | null }>)
      .map((r) => ({ jobId: r.id, fileId: r.file_id, state: r.state, safeErrorCode: r.last_safe_error_code }));
  }

  jobStatus(jobId: string): { jobId: string; fileId: string; state: string; safeErrorCode: string | null; attempts: number } | null {
    const job = this.db.prepare('SELECT id, file_id, state, last_safe_error_code FROM transfer_jobs WHERE id = ? AND job_type = ?')
      .get(jobId, 'delete') as { id: string; file_id: string; state: string; last_safe_error_code: string | null } | undefined;
    if (!job) return null;
    const attempts = (this.db.prepare('SELECT COUNT(*) AS n FROM deletion_attempts WHERE job_id = ?').get(jobId) as { n: number }).n;
    return { jobId: job.id, fileId: job.file_id, state: job.state, safeErrorCode: job.last_safe_error_code, attempts };
  }

  /** Startup: retry queued/pending deletions so obligations are not forgotten. */
  async resumePending(): Promise<{ attempted: number; completed: number }> {
    const pending = this.pendingJobs();
    let completed = 0;
    for (const job of pending) {
      if (job.state === 'running') {
        // a crash during deletion: return it to a safe retryable state
        this.db.prepare("UPDATE transfer_jobs SET state = 'deletion_pending', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), job.jobId);
      }
      try {
        const result = await this.process(job.jobId);
        if (result.state === 'completed') completed++;
      } catch {
        // stays pending; never silently abandoned
      }
    }
    return { attempted: pending.length, completed };
  }
}
