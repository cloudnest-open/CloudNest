import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/** Prepared statements for the download engine (M10). */

export interface DownloadJobRow {
  id: string;
  file_id: string | null;
  job_type: string;
  state: string;
  chunks_completed: number;
  chunks_total: number;
  bytes_completed: number;
  retry_count: number;
  last_safe_error_code: string | null;
  requested_range_start_bytes: number | null;
  requested_range_end_bytes: number | null;
  requested_bytes: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: string;
  file_id: string;
  chunk_index: number;
  offset_bytes: number;
  size_bytes: number;
  sha256: string;
  state: string;
}

export interface PlacementRow {
  id: string;
  chunk_id: string;
  provider_account_id: string;
  remote_object_id: string | null;
  remote_object_key: string | null;
  state: string;
  is_active: number;
  confirmed_size_bytes: number | null;
  /** Roadmap Phase 5: 'primary' | 'mirror'; NULL on pre-mirror rows means primary. */
  placement_role: string | null;
}

export function makeDownloadQueries(db: Database.Database) {
  return {
    insertDownloadJob: db.prepare(
      `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
        retry_count, last_safe_error_code, requested_range_start_bytes, requested_range_end_bytes, requested_bytes,
        created_at, updated_at)
       VALUES (@id, @file_id, 'download', 'running', 0, @chunks_total, 0, 0, NULL,
        @range_start, @range_end, @requested_bytes, @created_at, @updated_at)`,
    ),
    getJob: db.prepare('SELECT * FROM transfer_jobs WHERE id = ?'),
    updateJobProgress: db.prepare(
      `UPDATE transfer_jobs SET chunks_completed = @chunks_completed, bytes_completed = @bytes_completed,
        last_safe_error_code = @last_safe_error_code, updated_at = @updated_at WHERE id = @id`,
    ),
    finishJob: db.prepare(
      'UPDATE transfer_jobs SET state = @state, last_safe_error_code = @last_safe_error_code, updated_at = @updated_at WHERE id = @id',
    ),
    listDownloadJobs: db.prepare(
      "SELECT * FROM transfer_jobs WHERE job_type = 'download' ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ),
    countDownloadJobs: db.prepare("SELECT COUNT(*) AS n FROM transfer_jobs WHERE job_type = 'download'"),
    // Phase 3: a member's download history is their own files' jobs only.
    listDownloadJobsForUser: db.prepare(
      `SELECT j.* FROM transfer_jobs j JOIN files f ON f.id = j.file_id
       WHERE j.job_type = 'download' AND f.user_id = ? ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
    ),
    countDownloadJobsForUser: db.prepare(
      `SELECT COUNT(*) AS n FROM transfer_jobs j JOIN files f ON f.id = j.file_id
       WHERE j.job_type = 'download' AND f.user_id = ?`,
    ),
    getJobOwnerUserId: db.prepare(
      'SELECT f.user_id AS user_id FROM transfer_jobs j JOIN files f ON f.id = j.file_id WHERE j.id = ?',
    ),
    runningDownloadJobs: db.prepare("SELECT * FROM transfer_jobs WHERE job_type = 'download' AND state = 'running'"),

    getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
    listChunks: db.prepare('SELECT * FROM file_chunks WHERE file_id = ? ORDER BY chunk_index'),
    getChunk: db.prepare('SELECT * FROM file_chunks WHERE file_id = ? AND chunk_index = ?'),
    activePlacements: db.prepare('SELECT * FROM chunk_placements WHERE chunk_id = ? AND is_active = 1'),

    setFileState: db.prepare('UPDATE files SET state = ? WHERE id = ?'),
    renameFile: db.prepare('UPDATE files SET original_name = ? WHERE id = ?'),

    newId: () => crypto.randomUUID(),
  };
}

export type DownloadQueries = ReturnType<typeof makeDownloadQueries>;
