import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/** Short prepared statements around the single app connection. No ORM. */

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  password_changed_at: string;
  created_at: string;
  updated_at: string;
  auth_version: number;
}

/** A row of the users table (roadmap Phase 3). Never expose password_hash. */
export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'invited' | 'disabled';
  password_hash: string | null;
  password_changed_at: string | null;
  allowance_bytes: number | null;
  auth_version: number;
  created_at: string;
  updated_at: string;
}

export function makeQueries(db: Database.Database) {
  return {
    getAdmin(): AdminRow | undefined {
      return db.prepare('SELECT * FROM admin_users WHERE id = 1').get() as AdminRow | undefined;
    },
    createAdmin(username: string, passwordHash: string, nowIso: string): void {
      db.prepare(
        `INSERT INTO admin_users (id, username, password_hash, password_changed_at, created_at, updated_at, auth_version)
         VALUES (1, ?, ?, ?, ?, ?, 1)`,
      ).run(username, passwordHash, nowIso, nowIso, nowIso);
    },
    updateAdminPassword(passwordHash: string, nowIso: string): number {
      const result = db.prepare(
        `UPDATE admin_users
         SET password_hash = ?, password_changed_at = ?, updated_at = ?, auth_version = auth_version + 1
         WHERE id = 1`,
      ).run(passwordHash, nowIso, nowIso);
      const row = db.prepare('SELECT auth_version FROM admin_users WHERE id = 1').get() as { auth_version: number };
      return row.auth_version;
    },
    // ---- users (Phase 3): the reads the session gate itself needs live here,
    // so requireAdmin/requirePrincipal keep taking the same Queries object.
    getUser(id: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    },
    getUserByEmail(email: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    },
    deleteAllSessions(): void {
      db.prepare('DELETE FROM sessions').run();
    },
    newId(): string {
      return crypto.randomUUID();
    },
    recordAudit(eventType: string, success: boolean, reasonCode: string, metadata?: Record<string, string | number>): void {
      db.prepare(
        'INSERT INTO audit_events (id, created_at, event_type, success, reason_code, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        crypto.randomUUID(),
        new Date().toISOString(),
        eventType,
        success ? 1 : 0,
        reasonCode,
        metadata ? JSON.stringify(metadata) : null,
      );
    },
  };
}

export type Queries = ReturnType<typeof makeQueries>;
