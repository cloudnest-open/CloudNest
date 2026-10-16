import type Database from 'better-sqlite3';

/**
 * Roadmap Phase 4 — trash with a restore window. Deleting a file first moves
 * it to the trash (a trashed file keeps its chunks and placements; nothing
 * remote changes). Only a purge — explicit, per-file, empty-trash, or the
 * expired-window sweep — hands the file to the durable deletion engine, which
 * stays the single honest path that actually removes provider objects.
 */

export class TrashError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

/** The restore window; the UI copy states it in days and the sweep enforces it. */
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrashedFileRow {
  id: string;
  user_id: string;
  original_name: string;
  size_bytes: number;
  state: string;
  trashed_at: string;
}

export class TrashService {
  constructor(
    private readonly db: Database.Database,
    private readonly enqueueDeletion: (fileId: string) => { jobId: string; state: string },
    /** A trashed file's share links die at once (restore does not revive them). */
    private readonly revokeLinks: (fileId: string) => void = () => undefined,
  ) {}

  private fileFor(ownerUserId: string | null, fileId: string):
    { id: string; user_id: string; state: string; trashed_at: string | null } {
    const file = this.db.prepare(
      'SELECT id, user_id, state, trashed_at FROM files WHERE id = ?',
    ).get(fileId) as { id: string; user_id: string; state: string; trashed_at: string | null } | undefined;
    if (!file || (ownerUserId !== null && file.user_id !== ownerUserId)) {
      throw new TrashError('file_not_found', 404);
    }
    return file;
  }

  trash(ownerUserId: string | null, fileId: string): { trashedAt: string; purgeAfter: string } {
    const file = this.fileFor(ownerUserId, fileId);
    if (file.state === 'deleted') throw new TrashError('file_already_deleted', 409);
    if (file.trashed_at !== null) throw new TrashError('file_already_trashed', 409);
    const now = new Date().toISOString();
    // links must not keep serving a file its owner sent away, even restorably
    this.revokeLinks(fileId);
    this.db.prepare('UPDATE files SET trashed_at = ? WHERE id = ?').run(now, fileId);
    return { trashedAt: now, purgeAfter: new Date(Date.now() + TRASH_RETENTION_MS).toISOString() };
  }

  restore(ownerUserId: string | null, fileId: string): void {
    const file = this.fileFor(ownerUserId, fileId);
    if (file.trashed_at === null) throw new TrashError('file_not_trashed', 409);
    this.db.prepare('UPDATE files SET trashed_at = NULL WHERE id = ?').run(fileId);
  }

  /** Enqueue the REAL deletion (the durable engine takes it from here). */
  purge(ownerUserId: string | null, fileId: string): { jobId: string; state: string } {
    const file = this.fileFor(ownerUserId, fileId);
    if (file.trashed_at === null) throw new TrashError('file_not_trashed', 409);
    // a queued/running delete job already owns this file's cleanup
    if (file.state === 'deletion_pending') throw new TrashError('deletion_already_pending', 409);
    return this.enqueueDeletion(fileId);
  }

  list(ownerUserId: string | null, limit: number, offset: number): TrashedFileRow[] {
    return this.db.prepare(
      `SELECT id, user_id, original_name, size_bytes, state, trashed_at FROM files
       WHERE trashed_at IS NOT NULL AND state <> 'deleted'
         AND (? IS NULL OR user_id = ?)
       ORDER BY trashed_at DESC LIMIT ? OFFSET ?`,
    ).all(ownerUserId, ownerUserId, limit, offset) as TrashedFileRow[];
  }

  count(ownerUserId: string | null): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM files
       WHERE trashed_at IS NOT NULL AND state <> 'deleted' AND (? IS NULL OR user_id = ?)`,
    ).get(ownerUserId, ownerUserId) as { n: number }).n;
  }

  /** Empty the caller's trash: every trashed file goes to the deletion engine. */
  empty(ownerUserId: string | null): number {
    const rows = this.db.prepare(
      `SELECT id, state FROM files WHERE trashed_at IS NOT NULL AND state <> 'deleted'
         AND state <> 'deletion_pending' AND (? IS NULL OR user_id = ?)`,
    ).all(ownerUserId, ownerUserId) as Array<{ id: string; state: string }>;
    for (const row of rows) this.enqueueDeletion(row.id);
    return rows.length;
  }

  /**
   * Restore-window expiry across ALL principals (startup + hourly sweep).
   * Files past the window are enqueued for real deletion; nothing is claimed
   * removed here — the engine's own outcome tracking stays the truth.
   */
  purgeExpired(nowMs: number = Date.now()): number {
    const cutoff = new Date(nowMs - TRASH_RETENTION_MS).toISOString();
    const rows = this.db.prepare(
      `SELECT id FROM files
       WHERE trashed_at IS NOT NULL AND trashed_at < ? AND state <> 'deleted' AND state <> 'deletion_pending'`,
    ).all(cutoff) as Array<{ id: string }>;
    for (const row of rows) this.enqueueDeletion(row.id);
    return rows.length;
  }
}
