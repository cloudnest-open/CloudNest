import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Roadmap Phase 4 — the real feed behind the bell. Events are recorded for a
 * principal at the moment they happen (upload finished, a share link was used,
 * a quota observation went stale); nothing is synthesized after the fact, and
 * a principal only ever sees their own rows.
 */

export type NotificationKind = 'upload_completed' | 'share_used' | 'quota_stale';

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  /** JSON string; the route parses it for the client. */
  payload: string;
  read_at: string | null;
  created_at: string;
}

export class NotificationService {
  constructor(private readonly db: Database.Database) {}

  /** `tier` (M0018): which storage mode the event belongs to. NULL rows stay
   * visible in both modes (e.g. an event whose context spans both tiers). */
  push(userId: string, kind: NotificationKind, payload: Record<string, unknown>, tier?: string | null): string {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO notifications (id, user_id, kind, payload, tier, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(id, userId, kind, JSON.stringify(payload), tier ?? null, new Date().toISOString());
    return id;
  }

  /** Account events (quota staleness) are admin knowledge: every active admin. */
  pushToAdmins(kind: NotificationKind, payload: Record<string, unknown>, tier?: string | null): number {
    const admins = this.db.prepare(
      "SELECT id FROM users WHERE role = 'admin' AND status = 'active'",
    ).all() as Array<{ id: string }>;
    for (const admin of admins) this.push(admin.id, kind, payload, tier);
    return admins.length;
  }

  list(userId: string, limit: number, offset: number, tier: string | null = null): NotificationRow[] {
    return this.db.prepare(
      `SELECT * FROM notifications WHERE user_id = ? AND (? IS NULL OR tier IS NULL OR tier = ?)
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(userId, tier, tier, limit, offset) as NotificationRow[];
  }

  unreadCount(userId: string, tier: string | null = null): number {
    return (this.db.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND (? IS NULL OR tier IS NULL OR tier = ?)',
    ).get(userId, tier, tier) as { n: number }).n;
  }

  markRead(userId: string, id: string): boolean {
    const info = this.db.prepare(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
    ).run(new Date().toISOString(), id, userId);
    return info.changes > 0;
  }

  markAllRead(userId: string): number {
    const info = this.db.prepare(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
    ).run(new Date().toISOString(), userId);
    return info.changes;
  }
}
