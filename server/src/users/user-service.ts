import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { UserRow } from '../db/queries.js';
import { makeUserQueries, deleteUserSessionsByUserId, type UserQueries } from '../db/users-queries.js';
import { ADMIN_USER_ID } from '../middleware/require-admin.js';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../auth/password.js';

/**
 * User management (roadmap Phase 3): invite, password reset, role/allowance
 * administration, and the built-in admin's invariants. Secrets follow the
 * project's established rules: passwords are scrypt-hashed (auth/password.ts),
 * tokens are crypto-random and only their SHA-256 hash is ever stored, and a
 * raw token is returned exactly once, when it is issued.
 */

export class UserError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

const TOKEN_BYTES = 32;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week to accept an invite
const RESET_TTL_MS = 60 * 60 * 1000; // one hour to finish a reset

/** A user as the API returns it: no hash, no token material. */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  status: 'active' | 'invited' | 'disabled';
  allowanceBytes: number | null;
  usedBytes: number;
  authVersion: number;
  createdAt: string;
  updatedAt: string;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The invite/reset URL is only as trustworthy as its origin: configured
 * public base URL when present, otherwise the app's own base URL — a request's
 * Host header is never consulted (same rule as share links). */
function tokenUrl(baseUrl: string, rawToken: string): string {
  return `${baseUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}

function publicUser(row: UserRow, usedBytes: number): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    allowanceBytes: row.allowance_bytes,
    usedBytes,
    authVersion: row.auth_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserService {
  private readonly q: UserQueries;
  constructor(private readonly db: Database.Database) {
    this.q = makeUserQueries(db);
  }

  private usageMap(): Map<string, number> {
    const rows = this.q.usersUsageMap.all() as Array<{ user_id: string; n: number }>;
    return new Map(rows.map((r) => [r.user_id, r.n]));
  }

  private rowOr404(id: string): UserRow {
    const row = this.q.getUser.get(id) as UserRow | undefined;
    if (!row) throw new UserError('user_not_found', 404);
    return row;
  }

  listUsers(): PublicUser[] {
    this.q.deleteExpiredTokens.run(Date.now());
    const usage = this.usageMap();
    return (this.q.listUsers.all() as UserRow[]).map((row) => publicUser(row, usage.get(row.id) ?? 0));
  }

  getUser(id: string): PublicUser | null {
    const row = this.q.getUser.get(id) as UserRow | undefined;
    if (!row) return null;
    return publicUser(row, (this.q.userUsageBytes.get(id) as { n: number }).n);
  }

  /**
   * Create an invited user and return the one-time accept URL. The URL is the
   * whole invitation (no SMTP in this product): the admin hands it to the
   * person directly, exactly once.
   */
  inviteUser(input: {
    email: string;
    displayName: string;
    role: 'admin' | 'member';
    allowanceBytes: number | null;
    baseUrl: string;
  }): { user: PublicUser; acceptUrl: string } {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new UserError('invalid_email', 400);
    }
    const displayName = input.displayName.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (displayName.length === 0) throw new UserError('invalid_display_name', 400);
    if (input.role !== 'admin' && input.role !== 'member') throw new UserError('invalid_role', 400);
    if (input.allowanceBytes !== null && (!Number.isInteger(input.allowanceBytes) || input.allowanceBytes <= 0)) {
      throw new UserError('invalid_allowance', 400);
    }
    if (this.q.getUserByEmail.get(email)) throw new UserError('email_already_exists', 409);

    const id = this.q.newId();
    const now = new Date().toISOString();
    try {
      this.q.insertUser.run({
        id,
        email,
        display_name: displayName,
        role: input.role,
        status: 'invited',
        password_hash: null,
        password_changed_at: null,
        allowance_bytes: input.allowanceBytes,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      // a concurrent invite can pass the pre-check above; the UNIQUE
      // constraint on users.email is the real gate — surface it as 409,
      // not as a generic 500
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed: users.email')) {
        throw new UserError('email_already_exists', 409);
      }
      throw err;
    }
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    this.q.insertToken.run(sha256(rawToken), id, 'invite', Date.now() + INVITE_TTL_MS, now);
    return { user: this.getUser(id)!, acceptUrl: tokenUrl(input.baseUrl, rawToken) };
  }

  /**
   * Issue a one-time reset link for an active or invited user. For an invited
   * user this doubles as a fresh invite (setting the password activates the
   * account); a disabled account must be re-enabled first — silently handing
   * working credentials to a disabled account would defeat the disable.
   */
  startPasswordReset(userId: string, baseUrl: string): { resetUrl: string } {
    const row = this.rowOr404(userId);
    if (row.id === ADMIN_USER_ID) throw new UserError('user_admin_immutable', 409);
    if (row.status === 'disabled') throw new UserError('user_disabled', 409);
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    this.q.insertToken.run(sha256(rawToken), userId, 'password_reset', Date.now() + RESET_TTL_MS, new Date().toISOString());
    return { resetUrl: tokenUrl(baseUrl, rawToken) };
  }

  /**
   * Consume a one-time token (invite or password reset) and set the password.
   * An invited account becomes active; an active account's old sessions are
   * invalidated by the auth_version bump. The raw token is never logged.
   */
  async claimToken(rawToken: string, password: string): Promise<{ email: string }> {
    if (!rawToken) throw new UserError('token_invalid', 400);
    const policy = validatePasswordPolicy(password);
    if (!policy.ok) throw new UserError('password_policy', 400);
    const tokenRow = this.q.getToken.get(sha256(rawToken)) as
      | { token_hash: string; user_id: string; purpose: string; expires_at: number }
      | undefined;
    if (!tokenRow || tokenRow.expires_at <= Date.now()) {
      if (tokenRow) this.q.deleteToken.run(tokenRow.token_hash);
      throw new UserError('token_invalid', 400);
    }
    const user = this.q.getUser.get(tokenRow.user_id) as UserRow | undefined;
    if (!user) throw new UserError('token_invalid', 400);
    if (user.status === 'disabled') throw new UserError('user_disabled', 409);
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.q.deleteToken.run(tokenRow.token_hash);
      this.q.setUserPassword.run({
        id: user.id,
        password_hash: passwordHash,
        password_changed_at: now,
        // an invited account activates the moment its first password is set
        status: user.status === 'invited' ? 'active' : user.status,
        updated_at: now,
      });
      deleteUserSessionsByUserId(this.db, user.id);
    });
    txn();
    return { email: user.email };
  }

  /** A signed-in user changes their own password (current one must match). */
  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = this.q.getUser.get(userId) as UserRow | undefined;
    if (!user || user.id === ADMIN_USER_ID || !user.password_hash) {
      throw new UserError('user_not_found', 404);
    }
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new UserError('wrong_current_password', 401);
    }
    const policy = validatePasswordPolicy(newPassword);
    if (!policy.ok) throw new UserError('password_policy', 400);
    const passwordHash = await hashPassword(newPassword);
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.q.changeOwnPassword.run({ id: user.id, password_hash: passwordHash, password_changed_at: now, updated_at: now });
      deleteUserSessionsByUserId(this.db, user.id);
    });
    txn();
  }

  /** Admin edit of role/status/allowance, protecting the last active admin. */
  updateUser(id: string, patch: {
    role?: 'admin' | 'member';
    status?: 'active' | 'disabled';
    allowanceBytes?: number | null;
  }): PublicUser {
    const row = this.rowOr404(id);
    if (row.id === ADMIN_USER_ID && (patch.role !== undefined || patch.status !== undefined)) {
      // the built-in admin is the instance's anchor account
      throw new UserError('user_admin_immutable', 409);
    }
    if (patch.allowanceBytes !== undefined && patch.allowanceBytes !== null
      && (!Number.isInteger(patch.allowanceBytes) || patch.allowanceBytes <= 0)) {
      throw new UserError('invalid_allowance', 400);
    }
    const losesAdmin =
      (patch.role === 'member' && row.role === 'admin') ||
      (patch.status === 'disabled' && row.status !== 'disabled' && row.role === 'admin');
    if (losesAdmin) {
      const activeAdmins = (this.q.countActiveAdmins.get() as { n: number }).n;
      if (activeAdmins <= 1) throw new UserError('last_admin', 409);
    }
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      if (patch.role !== undefined && patch.role !== row.role) {
        this.q.setUserRole.run({ id, role: patch.role, updated_at: now });
      }
      if (patch.status !== undefined && patch.status !== row.status) {
        this.q.setUserStatus.run({ id, status: patch.status, updated_at: now });
        // disabling kicks live sessions immediately; re-enabling forces a
        // fresh login through the version bump as well
        deleteUserSessionsByUserId(this.db, id);
      }
      if (patch.allowanceBytes !== undefined) {
        this.q.setUserAllowance.run({ id, allowance_bytes: patch.allowanceBytes, updated_at: now });
      }
    });
    txn();
    return this.getUser(id)!;
  }

  /** Remove a user. The FK to files is the honest guard: a user who owns
   * files cannot be deleted until those files are gone. */
  deleteUser(id: string): void {
    const row = this.rowOr404(id);
    if (row.id === ADMIN_USER_ID) throw new UserError('user_admin_immutable', 409);
    if (row.role === 'admin') {
      const activeAdmins = (this.q.countActiveAdmins.get() as { n: number }).n;
      if (activeAdmins <= 1) throw new UserError('last_admin', 409);
    }
    const usage = (this.q.userUsageBytes.get(id) as { n: number }).n;
    const deletedFiles = (
      this.db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND state = 'deleted'").get(id) as { n: number }
    ).n;
    if (usage > 0 || deletedFiles > 0) throw new UserError('user_has_files', 409);
    const txn = this.db.transaction(() => {
      deleteUserSessionsByUserId(this.db, id);
      this.q.deleteUser.run(id);
    });
    try {
      txn();
    } catch (err) {
      // a concurrent plan could have created a file between the check and now
      if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
        throw new UserError('user_has_files', 409);
      }
      throw err;
    }
  }
}
