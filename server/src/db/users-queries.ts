import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AdminRow, UserRow } from './queries.js';

/**
 * Prepared statements for user management (roadmap Phase 3). The reads the
 * session gate itself needs live in db/queries.ts; everything the Users
 * admin API and the invite/reset flows need lives here. No ORM.
 */
export function makeUserQueries(db: Database.Database) {
  return {
    listUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
    getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare(
      `INSERT INTO users (id, email, display_name, role, status, password_hash, password_changed_at,
        allowance_bytes, auth_version, created_at, updated_at)
       VALUES (@id, @email, @display_name, @role, @status, @password_hash, @password_changed_at,
        @allowance_bytes, 1, @created_at, @updated_at)`,
    ),
    /** Sets a first/next password and bumps auth_version (stale sessions die). */
    setUserPassword: db.prepare(
      `UPDATE users SET password_hash = @password_hash, password_changed_at = @password_changed_at,
        status = @status, auth_version = auth_version + 1, updated_at = @updated_at WHERE id = @id`,
    ),
    /** Self-service password change: same bump, status untouched. */
    changeOwnPassword: db.prepare(
      `UPDATE users SET password_hash = @password_hash, password_changed_at = @password_changed_at,
        auth_version = auth_version + 1, updated_at = @updated_at WHERE id = @id`,
    ),
    setUserRole: db.prepare('UPDATE users SET role = @role, updated_at = @updated_at WHERE id = @id'),
    setUserStatus: db.prepare(
      'UPDATE users SET status = @status, auth_version = auth_version + 1, updated_at = @updated_at WHERE id = @id',
    ),
    setUserAllowance: db.prepare('UPDATE users SET allowance_bytes = @allowance_bytes, updated_at = @updated_at WHERE id = @id'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    // ---- the built-in admin's login-name rename ----
    getAdmin: db.prepare('SELECT * FROM admin_users WHERE id = 1'),
    /** Username only: no auth_version bump — sessions store the fixed id. */
    updateAdminUsername: db.prepare('UPDATE admin_users SET username = @username, updated_at = @updated_at WHERE id = 1'),
    /** The users row of the built-in admin always carries the same login name. */
    setUserEmail: db.prepare('UPDATE users SET email = @email, updated_at = @updated_at WHERE id = @id'),
    countActiveAdmins: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'",
    ),
    /** CloudNest-tracked bytes per user: every file except fully deleted ones. */
    userUsageBytes: db.prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files WHERE user_id = ? AND state <> 'deleted'",
    ),
    usersUsageMap: db.prepare(
      "SELECT user_id, COALESCE(SUM(size_bytes), 0) AS n FROM files WHERE state <> 'deleted' GROUP BY user_id",
    ),

    // ---- single-use tokens (invite / password reset) ----
    insertToken: db.prepare(
      'INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    getToken: db.prepare('SELECT * FROM user_tokens WHERE token_hash = ?'),
    deleteToken: db.prepare('DELETE FROM user_tokens WHERE token_hash = ?'),
    deleteExpiredTokens: db.prepare('DELETE FROM user_tokens WHERE expires_at <= ?'),
    deleteTokensForUser: db.prepare('DELETE FROM user_tokens WHERE user_id = ?'),

    newId: () => crypto.randomUUID(),
  };
}

export type UserQueries = ReturnType<typeof makeUserQueries>;

/**
 * Delete exactly one user's sessions. Sessions persist express-session's JSON
 * blob, which has no user_id column, so the match is an interpolated LIKE
 * pattern. Safe only while BOTH invariants hold: userId is a server-generated
 * UUID (never carries the LIKE metacharacters % or _, and its fixed length
 * rules out substring collisions) and the whole pattern stays parameter-bound.
 * If a caller would ever pass a non-UUID id, add a sessions.user_id column
 * instead of widening the pattern.
 */
export function deleteUserSessionsByUserId(db: Database.Database, userId: string): void {
  db.prepare('DELETE FROM sessions WHERE session_json LIKE ?')
    .run(`%"userId":"${userId}"%`);
}

export type { UserRow };
