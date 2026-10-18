import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { sanitizeDisplayName } from '../uploads/chunk-math.js';

/**
 * Roadmap Phase 4 — the folder tree. Every principal owns a separate tree:
 * a file attaches through files.parent_id (NULL = that owner's root), and a
 * folder nests through folders.parent_id. Ownership follows the established
 * Phase 3 pattern — a member's foreign id answers the SAME 404 as a missing
 * one (no existence leak); the admin (owner null) can READ every tree but
 * mutates only their own attribution tree.
 */

export class FolderError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

export interface FolderRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  /** M0018 (mode = complete context): which storage tier this folder belongs
   * to. Pre-existing rows are 'personal'; new folders inherit the creating
   * session's mode. A file may only sit in a folder of its own tier. */
  tier: string;
  created_at: string;
  updated_at: string;
}

/** Breadcrumb chains are bounded: FKs prevent cycles on insert, this guards depth. */
const MAX_TREE_DEPTH = 128;

export class FolderService {
  constructor(private readonly db: Database.Database) {}

  get(id: string): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
  }

  /** Read-scope guard: admin (null owner) sees every tree; a member only theirs. */
  scopedGet(id: string, ownerUserId: string | null): FolderRow {
    const row = this.get(id);
    if (!row || (ownerUserId !== null && row.user_id !== ownerUserId)) {
      throw new FolderError('folder_not_found', 404);
    }
    return row;
  }

  create(userId: string, parentId: string | null, rawName: string, tier: string = 'personal'): FolderRow {
    if (parentId !== null) {
      // nesting inside a foreign tree answers the same 404 as a missing parent
      const parent = this.get(parentId);
      if (!parent || parent.user_id !== userId) throw new FolderError('folder_not_found', 404);
      // mode = complete context: a child folder always lives in its parent's
      // tier — a business subfolder inside the personal tree would leak both ways
      if (parent.tier !== tier) throw new FolderError('folder_tier_mismatch', 400);
    }
    const name = sanitizeDisplayName(rawName);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `INSERT INTO folders (id, user_id, parent_id, name, tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, parentId, name, tier, now, now);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        throw new FolderError('folder_name_exists', 409);
      }
      throw err;
    }
    return this.get(id)!;
  }

  children(ownerUserId: string | null, parentId: string | null, tier: string | null = null): FolderRow[] {
    return this.db.prepare(
      `SELECT * FROM folders WHERE
        ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
        AND (? IS NULL OR user_id = ?)
        AND (? IS NULL OR tier = ?)
       ORDER BY name COLLATE NOCASE, id`,
    ).all(parentId, parentId, ownerUserId, ownerUserId, tier, tier) as FolderRow[];
  }

  /** Root-first ancestor chain of the folder (the Files page breadcrumb). */
  breadcrumb(folderId: string): Array<{ id: string; name: string }> {
    const chain: Array<{ id: string; name: string }> = [];
    let current: FolderRow | undefined = this.get(folderId);
    let depth = 0;
    while (current && depth < MAX_TREE_DEPTH) {
      chain.unshift({ id: current.id, name: current.name });
      current = current.parent_id === null ? undefined : this.get(current.parent_id);
      depth++;
    }
    return chain;
  }

  rename(userId: string, folderId: string, rawName: string): FolderRow {
    const row = this.get(folderId);
    // only the owning principal renames; a foreign folder is "missing"
    if (!row || row.user_id !== userId) throw new FolderError('folder_not_found', 404);
    const name = sanitizeDisplayName(rawName);
    try {
      this.db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, new Date().toISOString(), folderId);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        throw new FolderError('folder_name_exists', 409);
      }
      throw err;
    }
    return this.get(folderId)!;
  }

  /** Empty-only delete: a folder with any child folder or ANY file (trashed
   *  included) cannot go away — the trashed file's restore path keeps meaning. */
  delete(userId: string, folderId: string): void {
    const row = this.get(folderId);
    if (!row || row.user_id !== userId) throw new FolderError('folder_not_found', 404);
    const childFolders = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?',
    ).get(folderId) as { n: number }).n;
    const childFiles = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM files WHERE parent_id = ?',
    ).get(folderId) as { n: number }).n;
    if (childFolders > 0 || childFiles > 0) throw new FolderError('folder_not_empty', 409);
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  }

  /**
   * Move files into a folder (or back to their owner's root with null). Each
   * file is validated independently; per-file failures are reported, not thrown,
   * so a bulk move is honest about what moved. Tree purity is enforced: a file
   * may only move into a folder owned by the SAME user, including for the admin
   * (otherwise a member file could disappear into a tree the member cannot see).
   */
  moveFiles(
    ownerUserId: string | null,
    fileIds: string[],
    targetFolderId: string | null,
  ): { moved: number; failed: Array<{ id: string; code: string }> } {
    let moved = 0;
    const failed: Array<{ id: string; code: string }> = [];
    const target = targetFolderId === null ? null : this.get(targetFolderId) ?? null;
    if (targetFolderId !== null && !target) throw new FolderError('folder_not_found', 404);
    for (const fileId of fileIds) {
      const file = this.db.prepare(
        'SELECT user_id, state, trashed_at, tier FROM files WHERE id = ?',
      ).get(fileId) as { user_id: string; state: string; trashed_at: string | null; tier: string } | undefined;
      if (!file || (ownerUserId !== null && file.user_id !== ownerUserId)) {
        failed.push({ id: fileId, code: 'file_not_found' });
        continue;
      }
      if (target && target.user_id !== file.user_id) {
        failed.push({ id: fileId, code: 'folder_owner_mismatch' });
        continue;
      }
      // mode = complete context: files never cross tiers through a move
      if (target && target.tier !== file.tier) {
        failed.push({ id: fileId, code: 'folder_tier_mismatch' });
        continue;
      }
      if (file.trashed_at !== null) {
        failed.push({ id: fileId, code: 'file_trashed' });
        continue;
      }
      if (file.state === 'deleted') {
        failed.push({ id: fileId, code: 'file_not_found' });
        continue;
      }
      this.db.prepare('UPDATE files SET parent_id = ? WHERE id = ?')
        .run(targetFolderId, fileId);
      moved++;
    }
    return { moved, failed };
  }

  /**
   * Child counts for a batch of folders in two grouped queries. The children
   * listing used to run a COUNT pair per folder (N+1); this answers the whole
   * page in one round trip per table. Chunked IN-lists stay far under SQLite's
   * bound-variable ceiling.
   */
  countsForParents(parentIds: string[], tier: string | null = null): Map<string, { folders: number; files: number }> {
    const result = new Map<string, { folders: number; files: number }>();
    for (const id of parentIds) result.set(id, { folders: 0, files: 0 });
    const CHUNK = 500;
    const tierGuard = tier === null ? '' : ' AND tier = ?';
    const tierArgs = tier === null ? ([] as string[]) : [tier];
    for (let i = 0; i < parentIds.length; i += CHUNK) {
      const batch = parentIds.slice(i, i + CHUNK);
      const marks = batch.map(() => '?').join(', ');
      for (const table of ['folders', 'files'] as const) {
        const rows = this.db.prepare(
          `SELECT parent_id, COUNT(*) AS n FROM ${table} WHERE parent_id IN (${marks})${tierGuard} GROUP BY parent_id`,
        ).all(...batch, ...tierArgs) as Array<{ parent_id: string; n: number }>;
        for (const row of rows) {
          const entry = result.get(row.parent_id);
          if (entry) entry[table] = row.n;
        }
      }
    }
    return result;
  }
}
