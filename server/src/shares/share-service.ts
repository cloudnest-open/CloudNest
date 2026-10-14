import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../auth/password.js';

/**
 * Share links (M11.a/b).
 *
 * Security rules:
 * - the raw token is generated with crypto randomness and only its SHA-256 hash
 *   is ever persisted; the raw URL is returned exactly once, at creation;
 * - download counting is race-safe: a conditional UPDATE decrements/consumes in
 *   one statement so concurrent requests cannot exceed a link's limit;
 * - password-protected links reveal nothing (not even file names) before unlock.
 */

const TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 15 * 60 * 1000;

export class ShareError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface ShareLinkRow {
  id: string;
  token_hash: string;
  password_hash: string | null;
  expires_at: string | null;
  download_limit: number | null;
  download_count: number;
  state: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ShareService {
  constructor(private readonly db: Database.Database) {}

  /** Create a link for one or more complete files; returns the raw URL once. */
  create(input: {
    fileIds: string[];
    password?: string | null;
    expiresAt?: string | null;
    downloadLimit?: number | null;
    baseUrl: string;
  }): { id: string; url: string; fileIds: string[] } {
    if (input.fileIds.length === 0) throw new ShareError('invalid_share_metadata', 400);
    const unique = [...new Set(input.fileIds)];
    for (const fileId of unique) {
      const file = this.db.prepare('SELECT id, state, chunk_count FROM files WHERE id = ?').get(fileId) as
        | { id: string; state: string; chunk_count: number }
        | undefined;
      if (!file) throw new ShareError('file_not_found', 404);
      // only a fully stored file can be shared
      if (file.state !== 'completed') throw new ShareError('file_not_complete', 409);
    }
    // Password hashing is intentionally asynchronous. Rather than silently
    // creating an unprotected link, refuse and direct the caller to
    // createWithPassword(), which awaits the hash.
    if (input.password !== undefined && input.password !== null && input.password !== '') {
      throw new ShareError('password_requires_async_creation', 400);
    }
    if (input.downloadLimit !== null && input.downloadLimit !== undefined) {
      if (!Number.isInteger(input.downloadLimit) || input.downloadLimit <= 0) {
        throw new ShareError('invalid_share_metadata', 400);
      }
    }
    if (input.expiresAt) {
      const when = Date.parse(input.expiresAt);
      if (!Number.isFinite(when)) throw new ShareError('invalid_share_metadata', 400);
    }
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO share_links (id, token_hash, password_hash, expires_at, download_limit, download_count, state, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 0, 'active', ?, ?)`,
      ).run(id, sha256(rawToken), input.expiresAt ?? null, input.downloadLimit ?? null, now, now);
      for (const fileId of unique) {
        this.db.prepare('INSERT INTO share_link_items (share_link_id, file_id) VALUES (?, ?)').run(id, fileId);
      }
    });
    txn();
    return { id, url: `${input.baseUrl.replace(/\/$/, '')}/s/${rawToken}`, fileIds: unique };
  }

  /** Password hashing is async, so link creation with a password uses this. */
  async createWithPassword(input: {
    fileIds: string[];
    password: string;
    expiresAt?: string | null;
    downloadLimit?: number | null;
    baseUrl: string;
  }): Promise<{ id: string; url: string; fileIds: string[] }> {
    const policy = validatePasswordPolicy(input.password);
    if (!policy.ok) throw new ShareError('invalid_share_metadata', 400);
    const passwordHash = await hashPassword(input.password);
    const unique = [...new Set(input.fileIds)];
    for (const fileId of unique) {
      const file = this.db.prepare('SELECT id, state FROM files WHERE id = ?').get(fileId) as
        | { id: string; state: string }
        | undefined;
      if (!file) throw new ShareError('file_not_found', 404);
      if (file.state !== 'completed') throw new ShareError('file_not_complete', 409);
    }
    if (input.downloadLimit !== null && input.downloadLimit !== undefined) {
      if (!Number.isInteger(input.downloadLimit) || input.downloadLimit <= 0) {
        throw new ShareError('invalid_share_metadata', 400);
      }
    }
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO share_links (id, token_hash, password_hash, expires_at, download_limit, download_count, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
      ).run(id, sha256(rawToken), passwordHash, input.expiresAt ?? null, input.downloadLimit ?? null, now, now);
      for (const fileId of unique) {
        this.db.prepare('INSERT INTO share_link_items (share_link_id, file_id) VALUES (?, ?)').run(id, fileId);
      }
    });
    txn();
    return { id, url: `${input.baseUrl.replace(/\/$/, '')}/s/${rawToken}`, fileIds: unique };
  }

  private findByToken(rawToken: string): ShareLinkRow | undefined {
    return this.db.prepare('SELECT * FROM share_links WHERE token_hash = ?').get(sha256(rawToken)) as ShareLinkRow | undefined;
  }

  /** Resolve a token to its link, applying expiry lazily. Never leaks the raw token. */
  resolve(rawToken: string): ShareLinkRow {
    const link = this.findByToken(rawToken);
    if (!link) throw new ShareError('share_not_found', 404);
    if (link.state === 'revoked') throw new ShareError('share_revoked', 410);
    if (link.state === 'deleted') throw new ShareError('share_not_found', 404);
    if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
      this.db.prepare("UPDATE share_links SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'active'")
        .run(new Date().toISOString(), link.id);
      throw new ShareError('share_expired', 410);
    }
    return link;
  }

  /** Public metadata. Without a valid unlock, only the need for a password. */
  publicView(rawToken: string, unlocked: boolean): {
    requiresPassword: boolean;
    expiresAt: string | null;
    downloadLimit: number | null;
    downloadCount: number;
    files: Array<{ id: string; name: string; sizeBytes: number; mimeType: string | null }>;
  } {
    const link = this.resolve(rawToken);
    const requiresPassword = link.password_hash !== null;
    const base = {
      requiresPassword,
      expiresAt: link.expires_at,
      downloadLimit: link.download_limit,
      downloadCount: link.download_count,
      files: [] as Array<{ id: string; name: string; sizeBytes: number; mimeType: string | null }>,
    };
    if (requiresPassword && !unlocked) return base;
    const rows = this.db.prepare(
      `SELECT f.id, f.original_name, f.size_bytes, f.mime_type
       FROM share_link_items i JOIN files f ON f.id = i.file_id
       WHERE i.share_link_id = ? AND f.state = 'completed'
       ORDER BY f.original_name`,
    ).all(link.id) as Array<{ id: string; original_name: string; size_bytes: number; mime_type: string | null }>;
    base.files = rows.map((r) => ({
      id: r.id, name: r.original_name, sizeBytes: r.size_bytes, mimeType: r.mime_type,
    }));
    return base;
  }

  async verifyPassword(rawToken: string, password: string): Promise<boolean> {
    const link = this.resolve(rawToken);
    if (!link.password_hash) return true;
    return verifyPassword(password, link.password_hash);
  }

  /**
   * Atomically authorize one download start. The conditional UPDATE is the
   * concurrency guard: two simultaneous requests cannot both take the last slot.
   */
  consumeDownloadStart(rawToken: string, fileId: string): { sessionToken: string; expiresAtMs: number } {
    const link = this.resolve(rawToken);
    const membership = this.db.prepare(
      'SELECT 1 AS present FROM share_link_items WHERE share_link_id = ? AND file_id = ?',
    ).get(link.id, fileId) as { present: number } | undefined;
    if (!membership) throw new ShareError('file_not_found', 404);
    const file = this.db.prepare('SELECT id, state FROM files WHERE id = ?').get(fileId) as
      | { id: string; state: string }
      | undefined;
    if (!file || file.state !== 'completed') throw new ShareError('file_not_complete', 409);

    const now = new Date().toISOString();
    const info = link.download_limit === null
      ? this.db.prepare(
          "UPDATE share_links SET download_count = download_count + 1, updated_at = ? WHERE id = ? AND state = 'active'",
        ).run(now, link.id)
      : this.db.prepare(
          `UPDATE share_links SET download_count = download_count + 1, updated_at = ?
           WHERE id = ? AND state = 'active' AND download_count < download_limit`,
        ).run(now, link.id);
    if (info.changes === 0) {
      throw new ShareError('share_download_limit_reached', 429);
    }

    const rawSession = crypto.randomBytes(32).toString('base64url');
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    this.db.prepare(
      `INSERT INTO share_download_sessions (id, token_hash, share_link_id, file_id, state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(crypto.randomUUID(), sha256(rawSession), link.id, fileId, expiresAtMs, now, now);
    return { sessionToken: rawSession, expiresAtMs };
  }

  /** Re-validate the parent link for a session token on every request. */
  authorizeSession(rawSessionToken: string): { linkId: string; fileId: string } {
    if (!rawSessionToken) throw new ShareError('share_not_found', 404);
    const row = this.db.prepare('SELECT * FROM share_download_sessions WHERE token_hash = ?')
      .get(sha256(rawSessionToken)) as
      | { id: string; share_link_id: string; file_id: string; state: string; expires_at: number }
      | undefined;
    if (!row) throw new ShareError('share_not_found', 404);
    if (row.state === 'revoked') throw new ShareError('share_revoked', 410);
    if (row.state !== 'active' || row.expires_at <= Date.now()) {
      this.db.prepare("UPDATE share_download_sessions SET state = 'expired', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      throw new ShareError('share_expired', 410);
    }
    // the parent link is rechecked on every request
    const link = this.db.prepare('SELECT state, expires_at, revoked_at FROM share_links WHERE id = ?')
      .get(row.share_link_id) as { state: string; expires_at: string | null } | undefined;
    if (!link || link.state === 'revoked') throw new ShareError('share_revoked', 410);
    if (link.state === 'deleted') throw new ShareError('share_not_found', 404);
    if (link.state !== 'active') throw new ShareError('share_expired', 410);
    if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
      throw new ShareError('share_expired', 410);
    }
    return { linkId: row.share_link_id, fileId: row.file_id };
  }

  /** Revoke a link and immediately invalidate every session it issued. */
  revoke(linkId: string): boolean {
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      const info = this.db.prepare(
        "UPDATE share_links SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND state = 'active'",
      ).run(now, now, linkId);
      this.db.prepare(
        "UPDATE share_download_sessions SET state = 'revoked', updated_at = ? WHERE share_link_id = ? AND state = 'active'",
      ).run(now, linkId);
      return info.changes;
    });
    return txn() > 0;
  }

  /** Rotate: revoke the old URL and issue a new one, returned exactly once. */
  rotate(linkId: string, baseUrl: string): { url: string } {
    const link = this.db.prepare('SELECT * FROM share_links WHERE id = ?').get(linkId) as ShareLinkRow | undefined;
    if (!link) throw new ShareError('share_not_found', 404);
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.db.prepare('UPDATE share_links SET token_hash = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(sha256(rawToken), 'active', now, linkId);
      this.db.prepare(
        "UPDATE share_download_sessions SET state = 'revoked', updated_at = ? WHERE share_link_id = ? AND state = 'active'",
      ).run(now, linkId);
    });
    txn();
    return { url: `${baseUrl.replace(/\/$/, '')}/s/${rawToken}` };
  }

  /** Update policy fields; the token is never returned or changed here. */
  update(linkId: string, patch: { expiresAt?: string | null; downloadLimit?: number | null }): void {
    const link = this.db.prepare('SELECT id FROM share_links WHERE id = ?').get(linkId) as { id: string } | undefined;
    if (!link) throw new ShareError('share_not_found', 404);
    if (patch.downloadLimit !== undefined && patch.downloadLimit !== null) {
      if (!Number.isInteger(patch.downloadLimit) || patch.downloadLimit <= 0) {
        throw new ShareError('invalid_share_metadata', 400);
      }
    }
    if (patch.expiresAt) {
      if (!Number.isFinite(Date.parse(patch.expiresAt))) throw new ShareError('invalid_share_metadata', 400);
    }
    const now = new Date().toISOString();
    if (patch.expiresAt !== undefined) {
      this.db.prepare('UPDATE share_links SET expires_at = ?, updated_at = ? WHERE id = ?')
        .run(patch.expiresAt ?? null, now, linkId);
    }
    if (patch.downloadLimit !== undefined) {
      this.db.prepare('UPDATE share_links SET download_limit = ?, updated_at = ? WHERE id = ?')
        .run(patch.downloadLimit ?? null, now, linkId);
    }
  }

  /** Admin listing: no token, no password hash. */
  listLinks(): Array<{
    id: string; state: string; expiresAt: string | null; downloadLimit: number | null;
    downloadCount: number; hasPassword: boolean; fileCount: number; createdAt: string;
  }> {
    const rows = this.db.prepare(
      `SELECT l.id, l.state, l.expires_at, l.download_limit, l.download_count, l.password_hash, l.created_at,
              (SELECT COUNT(*) FROM share_link_items i WHERE i.share_link_id = l.id) AS file_count
       FROM share_links l ORDER BY l.created_at DESC`,
    ).all() as Array<{
      id: string; state: string; expires_at: string | null; download_limit: number | null;
      download_count: number; password_hash: string | null; created_at: string; file_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      expiresAt: r.expires_at,
      downloadLimit: r.download_limit,
      downloadCount: r.download_count,
      hasPassword: r.password_hash !== null,
      fileCount: r.file_count,
      createdAt: r.created_at,
    }));
  }

  getLink(linkId: string): ReturnType<ShareService['listLinks']>[number] | null {
    return this.listLinks().find((l) => l.id === linkId) ?? null;
  }

  /** Revoke links that reference a file, so deletion cannot leave them live. */
  revokeLinksForFile(fileId: string): number {
    const links = this.db.prepare(
      'SELECT share_link_id FROM share_link_items WHERE file_id = ?',
    ).all(fileId) as Array<{ share_link_id: string }>;
    let revoked = 0;
    for (const link of links) {
      if (this.revoke(link.share_link_id)) revoked++;
    }
    return revoked;
  }

  /** Bounded cleanup of expired sessions. */
  cleanupExpiredSessions(): number {
    return this.db.prepare(
      "UPDATE share_download_sessions SET state = 'expired', updated_at = ? WHERE state = 'active' AND expires_at <= ?",
    ).run(new Date().toISOString(), Date.now()).changes;
  }
}
