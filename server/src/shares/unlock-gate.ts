import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * SH-1 remediation — share unlock grants (M0010 schema).
 *
 * A password-protected share previously gated only its landing-page listing:
 * the download-session endpoint authorized on token + file id alone, so
 * anyone holding the public token could stream the file without the password.
 *
 * This gate closes that hole at the route layer:
 *  - a successful unlock issues a share-bound, expiring grant;
 *  - download-session issuance on a protected link requires a live grant
 *    bound to that exact link;
 *  - grants die with their link (revoke/rotate), expire independently, and
 *    are hash-stored exactly like link and session tokens.
 *
 * Enforcement lives here, server-side, before any session can be issued.
 * Nothing in this module trusts client-supplied authorization state.
 */

/** Grant lifetime. Long enough to browse a collection, never more than a day. */
export const UNLOCK_GRANT_TTL_MS = 12 * 60 * 60 * 1000;

const GRANT_BYTES = 32;

/** Only hashes are persisted; the raw value is returned exactly once. */
function hashForStorage(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * True when the link carries an access gate. Reads the schema column directly
 * so the gate cannot be bypassed by any code path that skips the service.
 */
export function linkHasGate(db: Database.Database, linkId: string): boolean {
  const row = db.prepare('SELECT password_hash FROM share_links WHERE id = ?').get(linkId) as
    | { password_hash: string | null }
    | undefined;
  return !!row && row.password_hash !== null;
}

/**
 * Validate a submitted gate value for a link. Returns true only when the
 * link has no gate; otherwise the submitted value must match the stored
 * scrypt hash. Uses the battle-tested verifier from the auth module.
 */
export async function verifyAccessKey(
  verifyHash: (submitted: string, stored: string) => Promise<boolean>,
  storedHash: string,
  submitted: string,
): Promise<boolean> {
  return verifyHash(submitted, storedHash);
}

/** Issue one grant for one link. Returns the raw grant exactly once. */
export function issueGrant(db: Database.Database, linkId: string): { grant: string; expiresAtMs: number } {
  const raw = crypto.randomBytes(GRANT_BYTES).toString('base64url');
  const expiresAtMs = Date.now() + UNLOCK_GRANT_TTL_MS;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO share_unlock_grants (id, token_hash, share_link_id, state, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  ).run(crypto.randomUUID(), hashForStorage(raw), linkId, expiresAtMs, now, now);
  return { grant: raw, expiresAtMs };
}

/**
 * Enforce the gate for one download start. Fails closed: a missing, foreign,
 * expired, or revoked grant throws share_password_required. Expired grants
 * are lazily transitioned so cleanup can reclaim them.
 */
export function requireGrantForLink(db: Database.Database, linkId: string, submittedGrant: unknown): void {
  if (typeof submittedGrant !== 'string' || submittedGrant.length === 0 || submittedGrant.length > 512) {
    throw Object.assign(new Error('share_password_required'), { safeCode: 'share_password_required', httpStatus: 401 });
  }
  const grant = db.prepare(
    'SELECT id, share_link_id, state, expires_at FROM share_unlock_grants WHERE token_hash = ?',
  ).get(hashForStorage(submittedGrant)) as
    | { id: string; share_link_id: string; state: string; expires_at: number }
    | undefined;
  // the grant must belong to THIS link - a grant minted for another share is
  // worthless even when its own state is still active
  if (!grant || grant.share_link_id !== linkId) {
    throw Object.assign(new Error('share_password_required'), { safeCode: 'share_password_required', httpStatus: 401 });
  }
  if (grant.state !== 'active' || grant.expires_at <= Date.now()) {
    if (grant && grant.state === 'active') {
      db.prepare(
        "UPDATE share_unlock_grants SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'active'",
      ).run(new Date().toISOString(), grant.id);
    }
    throw Object.assign(new Error('share_password_required'), { safeCode: 'share_password_required', httpStatus: 401 });
  }
}

/**
 * Kill every live grant of a link. Called on revoke and rotate so a stolen
 * grant cannot outlive the URL it was issued for.
 */
export function revokeGrantsForLink(db: Database.Database, linkId: string): number {
  return db.prepare(
    "UPDATE share_unlock_grants SET state = 'revoked', updated_at = ? WHERE share_link_id = ? AND state = 'active'",
  ).run(new Date().toISOString(), linkId).changes;
}

/** Bounded cleanup of expired grants (BE-03 hygiene). */
export function cleanupExpiredGrants(db: Database.Database): number {
  return db.prepare(
    "UPDATE share_unlock_grants SET state = 'expired', updated_at = ? WHERE state = 'active' AND expires_at <= ?",
  ).run(new Date().toISOString(), Date.now()).changes;
}

/**
 * Resolve a public share token to its link row. Mirrors the service's lazy
 * expiry exactly, so an expired or revoked link can never mint a grant.
 */
export function resolvePublicLink(db: Database.Database, rawLinkToken: string): {
  id: string; password_hash: string | null; state: string; expires_at: string | null;
} {
  const tokenHash = hashForStorage(rawLinkToken);
  const link = db.prepare('SELECT * FROM share_links WHERE token_hash = ?').get(tokenHash) as
    | { id: string; password_hash: string | null; state: string; expires_at: string | null; revoked_at: string | null }
    | undefined;
  if (!link) throw Object.assign(new Error('share_not_found'), { safeCode: 'share_not_found', httpStatus: 404 });
  if (link.state === 'revoked') throw Object.assign(new Error('share_revoked'), { safeCode: 'share_revoked', httpStatus: 410 });
  if (link.state === 'deleted') throw Object.assign(new Error('share_not_found'), { safeCode: 'share_not_found', httpStatus: 404 });
  if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
    db.prepare("UPDATE share_links SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'active'")
      .run(new Date().toISOString(), link.id);
    throw Object.assign(new Error('share_expired'), { safeCode: 'share_expired', httpStatus: 410 });
  }
  return link;
}
