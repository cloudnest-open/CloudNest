import crypto from 'node:crypto';
import { Store, type SessionData } from 'express-session';
import type Database from 'better-sqlite3';

/**
 * express-session Store backed by the existing SQLite connection.
 * - Raw session IDs are SHA-256 hashed before storage (the DB never holds a raw sid).
 * - Expiry is stored in Unix milliseconds; expired rows are treated as absent.
 * - Callbacks are invoked exactly once; errors are passed, not swallowed.
 */

interface SessionRow {
  sid_hash: string;
  session_json: string;
  expires_at: number;
}

function hashSid(sid: string): string {
  return crypto.createHash('sha256').update(sid, 'utf8').digest('hex');
}

export class SqliteSessionStore extends Store {
  private readonly db: Database.Database;
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;
  private touchStmt: Database.Statement;
  private destroyStmt: Database.Statement;
  private clearStmt: Database.Statement;
  private cleanupStmt: Database.Statement;

  constructor(db: Database.Database) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT session_json, expires_at FROM sessions WHERE sid_hash = ?');
    this.setStmt = db.prepare(
      `INSERT INTO sessions (sid_hash, session_json, expires_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(sid_hash) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    );
    this.touchStmt = db.prepare(
      'UPDATE sessions SET expires_at = ?, updated_at = ? WHERE sid_hash = ?',
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid_hash = ?');
    this.clearStmt = db.prepare('DELETE FROM sessions');
    this.cleanupStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  }

  override get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    let called = false;
    try {
      const row = this.getStmt.get(hashSid(sid)) as SessionRow | undefined;
      if (!row || row.expires_at <= Date.now()) {
        if (row) {
          // lazily remove the expired row (bounded single-row delete)
          this.destroyStmt.run(hashSid(sid));
        }
        called = true;
        return callback(null, null);
      }
      called = true;
      callback(null, JSON.parse(row.session_json) as SessionData);
    } catch (err) {
      if (!called) callback(err);
    }
  }

  override set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expiresAt = Number(session.cookie?.expires?.getTime()) || Date.now() + 12 * 60 * 60 * 1000;
      this.setStmt.run(hashSid(sid), JSON.stringify(session), expiresAt, new Date().toISOString());
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  override touch(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expiresAt = Number(session.cookie?.expires?.getTime()) || Date.now() + 12 * 60 * 60 * 1000;
      const info = this.touchStmt.run(expiresAt, new Date().toISOString(), hashSid(sid));
      if (info.changes === 0) {
        // row vanished between get and touch; recreate it
        this.set(sid, session, callback);
        return;
      }
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      this.destroyStmt.run(hashSid(sid));
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  override clear(callback?: (err?: unknown) => void): void {
    try {
      this.clearStmt.run();
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  /** Bounded expired-row cleanup (call opportunistically, not on the hot path). */
  cleanupExpired(): number {
    return this.cleanupStmt.run(Date.now()).changes;
  }
}
