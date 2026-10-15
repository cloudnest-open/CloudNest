import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/** Prepared statements for the upload engine (M9). No ORM, no dynamic SQL. */

export interface JobRow {
  id: string;
  file_id: string | null;
  job_type: string;
  state: string;
  chunks_completed: number;
  chunks_total: number;
  bytes_completed: number;
  retry_count: number;
  last_safe_error_code: string | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface AllocationRow {
  id: string;
  job_id: string;
  chunk_index: number;
  provider_account_id: string;
  size_bytes: number;
  offset_bytes: number;
  state: string;
  attempt_count: number;
  /** Provider-observed used_bytes when this allocation's chunk committed (reconciliation evidence). */
  used_bytes_at_commit: number | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  job_id: string;
  chunk_index: number;
  provider_account_id: string;
  object_key: string;
  state: string;
  bytes_received: number;
  sha256: string | null;
  remote_object_id: string | null;
  safe_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  original_name: string;
  size_bytes: number;
  mime_type: string | null;
  chunk_size_bytes: number;
  chunk_count: number;
  whole_sha256: string | null;
  manifest_hash: string | null;
  state: string;
  created_at: string;
  completed_at: string | null;
}

export function makeUploadQueries(db: Database.Database) {
  return {
    // ---- jobs ----
    insertJob: db.prepare(
      `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
        retry_count, last_safe_error_code, idempotency_key, request_fingerprint, created_at, updated_at)
       VALUES (@id, @file_id, 'upload', @state, 0, @chunks_total, 0, 0, NULL, @idempotency_key, @request_fingerprint, @created_at, @updated_at)`,
    ),
    getJob: db.prepare('SELECT * FROM transfer_jobs WHERE id = ?'),
    getJobByIdempotencyKey: db.prepare('SELECT * FROM transfer_jobs WHERE idempotency_key = ?'),
    listJobs: db.prepare('SELECT * FROM transfer_jobs WHERE job_type = \'upload\' ORDER BY created_at DESC LIMIT ?'),
    updateJobState: db.prepare(
      'UPDATE transfer_jobs SET state = @state, last_safe_error_code = @last_safe_error_code, updated_at = @updated_at WHERE id = @id',
    ),
    updateJobProgress: db.prepare(
      `UPDATE transfer_jobs SET chunks_completed = @chunks_completed, bytes_completed = @bytes_completed,
        last_safe_error_code = @last_safe_error_code, updated_at = @updated_at WHERE id = @id`,
    ),
    bumpJobRetry: db.prepare('UPDATE transfer_jobs SET retry_count = retry_count + 1, updated_at = @updated_at WHERE id = @id'),
    runningJobs: db.prepare("SELECT * FROM transfer_jobs WHERE job_type = 'upload' AND state IN ('queued','running')"),

    // ---- files ----
    insertFile: db.prepare(
      `INSERT INTO files (id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, whole_sha256,
        manifest_hash, state, created_at, completed_at)
       VALUES (@id, @original_name, @size_bytes, @mime_type, @chunk_size_bytes, @chunk_count, NULL, NULL, @state, @created_at, NULL)`,
    ),
    getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
    listFiles: db.prepare('SELECT * FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?'),
    // FE-02: the search filter runs in SQL BEFORE pagination, so a query sees
    // the whole library instead of only the newest page of rows.
    searchFiles: db.prepare(
      "SELECT * FROM files WHERE lower(original_name) LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ),
    countSearchedFiles: db.prepare(
      "SELECT COUNT(*) AS n FROM files WHERE lower(original_name) LIKE '%' || ? || '%'",
    ),
    countFiles: db.prepare('SELECT COUNT(*) AS n FROM files'),
    completeFile: db.prepare(
      `UPDATE files SET state = 'completed', manifest_hash = @manifest_hash, completed_at = @completed_at WHERE id = @id`,
    ),
    updateFileState: db.prepare('UPDATE files SET state = @state WHERE id = @id'),

    // ---- allocations ----
    insertAllocation: db.prepare(
      `INSERT INTO upload_chunk_allocations (id, job_id, chunk_index, provider_account_id, size_bytes, offset_bytes, state, attempt_count, created_at, updated_at)
       VALUES (@id, @job_id, @chunk_index, @provider_account_id, @size_bytes, @offset_bytes, 'reserved', 0, @created_at, @updated_at)`,
    ),
    getAllocation: db.prepare('SELECT * FROM upload_chunk_allocations WHERE job_id = ? AND chunk_index = ?'),
    listAllocations: db.prepare('SELECT * FROM upload_chunk_allocations WHERE job_id = ? ORDER BY chunk_index'),
    listAllActiveAllocations: db.prepare(
      "SELECT * FROM upload_chunk_allocations WHERE state IN ('reserved','uploading','uploaded_pending_quota')",
    ),
    listAllAllocationsForJob: db.prepare('SELECT * FROM upload_chunk_allocations WHERE job_id = ?'),
    markAllocationUploading: db.prepare(
      "UPDATE upload_chunk_allocations SET state = 'uploading', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
    ),
    markAllocationUploadedPendingQuota: db.prepare(
      "UPDATE upload_chunk_allocations SET state = 'uploaded_pending_quota', updated_at = ? WHERE id = ?",
    ),
    markAllocationReleased: db.prepare(
      "UPDATE upload_chunk_allocations SET state = 'released', updated_at = ? WHERE id = ?",
    ),
    markAllocationNeedsReplan: db.prepare(
      "UPDATE upload_chunk_allocations SET state = 'needs_replan', updated_at = ? WHERE id = ?",
    ),
    reassignAllocation: db.prepare(
      "UPDATE upload_chunk_allocations SET provider_account_id = @provider_account_id, state = 'reserved', updated_at = @updated_at WHERE id = @id",
    ),
    // §6.1 reconciliation evidence: remember the provider-observed usage at the
    // moment a chunk committed, so a later CURRENT observation can prove the
    // provider has accounted for those bytes before the reservation releases.
    setAllocationCommitBaseline: db.prepare(
      'UPDATE upload_chunk_allocations SET used_bytes_at_commit = ? WHERE id = ?',
    ),
    listPendingQuotaAllocations: db.prepare(
      "SELECT * FROM upload_chunk_allocations WHERE provider_account_id = ? AND state = 'uploaded_pending_quota' ORDER BY used_bytes_at_commit ASC, created_at ASC",
    ),
    // §9 per-account concurrency: at most MAX_PER_ACCOUNT_INFLIGHT chunks of
    // one account may be in flight; the count excludes the allocation being
    // claimed (reserved -> uploading happens in the same transaction).
    countUploadingForAccount: db.prepare(
      "SELECT COUNT(*) AS n FROM upload_chunk_allocations WHERE provider_account_id = ? AND state = 'uploading' AND id <> ?",
    ),

    // ---- attempts ----
    insertAttempt: db.prepare(
      `INSERT INTO upload_attempts (id, job_id, chunk_index, provider_account_id, object_key, state, bytes_received, sha256,
        remote_object_id, safe_error_code, provider_resume_state_ciphertext, provider_resume_state_nonce,
        provider_resume_state_auth_tag, provider_resume_state_key_version, created_at, updated_at)
       VALUES (@id, @job_id, @chunk_index, @provider_account_id, @object_key, 'uploading', 0, NULL, NULL, NULL,
        @resume_ciphertext, @resume_nonce, @resume_auth_tag, @resume_key_version, @created_at, @updated_at)`,
    ),
    getAttempt: db.prepare('SELECT * FROM upload_attempts WHERE id = ?'),
    getAttemptByObjectKey: db.prepare('SELECT * FROM upload_attempts WHERE object_key = ?'),
    listAttemptsForChunk: db.prepare(
      'SELECT * FROM upload_attempts WHERE job_id = ? AND chunk_index = ? ORDER BY created_at DESC',
    ),
    markAttemptUploadedUncommitted: db.prepare(
      `UPDATE upload_attempts SET state = 'uploaded_uncommitted', bytes_received = @bytes_received, sha256 = @sha256,
        remote_object_id = @remote_object_id, safe_error_code = NULL, updated_at = @updated_at WHERE id = @id`,
    ),
    markAttemptCommitted: db.prepare(
      "UPDATE upload_attempts SET state = 'committed', provider_resume_state_ciphertext = NULL, provider_resume_state_nonce = NULL, provider_resume_state_auth_tag = NULL, provider_resume_state_key_version = NULL, updated_at = ? WHERE id = ?",
    ),
    markAttemptFailed: db.prepare(
      "UPDATE upload_attempts SET state = 'failed', safe_error_code = @safe_error_code, bytes_received = @bytes_received, updated_at = @updated_at WHERE id = @id",
    ),
    markAttemptCleanupPending: db.prepare(
      "UPDATE upload_attempts SET state = 'cleanup_pending', safe_error_code = @safe_error_code, updated_at = @updated_at WHERE id = @id",
    ),
    markAttemptCleaned: db.prepare("UPDATE upload_attempts SET state = 'cleaned', updated_at = ? WHERE id = ?"),
    cleanupPendingAttempts: db.prepare("SELECT * FROM upload_attempts WHERE state = 'cleanup_pending'"),

    // ---- chunks and placements ----
    insertChunk: db.prepare(
      `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
       VALUES (@id, @file_id, @chunk_index, @offset_bytes, @size_bytes, @sha256, 'uploaded', @created_at, @updated_at)`,
    ),
    getChunk: db.prepare('SELECT * FROM file_chunks WHERE file_id = ? AND chunk_index = ?'),
    listChunks: db.prepare('SELECT * FROM file_chunks WHERE file_id = ? ORDER BY chunk_index'),
    insertPlacement: db.prepare(
      `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, remote_object_key, state, is_active,
        provider_checksum_type, confirmed_size_bytes, last_safe_error_code, created_at, updated_at)
       VALUES (@id, @chunk_id, @provider_account_id, @remote_object_id, @remote_object_key, 'verified', 1,
        @provider_checksum_type, @confirmed_size_bytes, NULL, @created_at, @updated_at)`,
    ),
    deactivatePlacements: db.prepare(
      'UPDATE chunk_placements SET is_active = 0, updated_at = ? WHERE chunk_id = ? AND is_active = 1',
    ),
    activePlacements: db.prepare('SELECT * FROM chunk_placements WHERE is_active = 1'),
    placementsForChunk: db.prepare('SELECT * FROM chunk_placements WHERE chunk_id = ? ORDER BY created_at'),

    newId: () => crypto.randomUUID(),
  };
}

export type UploadQueries = ReturnType<typeof makeUploadQueries>;

/**
 * §6.1 reservation reconciliation. A chunk's `uploaded_pending_quota`
 * reservation releases only when a CURRENT quota observation proves the
 * provider has accounted for its bytes: observed usage must have grown by at
 * least the chunk size since the usage snapshot captured at commit. A refresh
 * that merely "succeeded" releases nothing; unknown baselines never release.
 *
 * Runs inside the caller's transaction together with the quota update, so the
 * observation and the release commit or roll back as one. Also refreshes the
 * per-account `reserved_inflight_bytes` cache from the durable rows afterwards
 * (the cache is never the source of truth).
 *
 * Returns the number of reservations released.
 */
export function reconcileUploadedPendingQuota(
  db: Database.Database,
  accountId: string,
  freshUsedBytes: number | null,
): number {
  if (freshUsedBytes === null || !Number.isFinite(freshUsedBytes) || freshUsedBytes < 0) return 0;
  const pending = db.prepare(
    `SELECT id, size_bytes, used_bytes_at_commit FROM upload_chunk_allocations
     WHERE provider_account_id = ? AND state = 'uploaded_pending_quota'`,
  ).all(accountId) as Array<{ id: string; size_bytes: number; used_bytes_at_commit: number | null }>;
  let released = 0;
  for (const row of pending) {
    if (row.used_bytes_at_commit === null) continue;
    if (freshUsedBytes >= row.used_bytes_at_commit + row.size_bytes) {
      db.prepare("UPDATE upload_chunk_allocations SET state = 'released', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      released++;
    }
  }
  if (released > 0) {
    const now = new Date().toISOString();
    const outstanding = db.prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM upload_chunk_allocations
       WHERE provider_account_id = ? AND state IN ('reserved','uploading','uploaded_pending_quota')`,
    ).get(accountId) as { n: number };
    db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = ?, updated_at = ? WHERE id = ?')
      .run(outstanding.n, now, accountId);
  }
  return released;
}
