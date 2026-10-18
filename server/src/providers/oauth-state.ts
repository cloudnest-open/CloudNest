import crypto from 'node:crypto';

/**
 * Session-bound OAuth state, kept in a bounded process-memory map (single
 * process by design in this step). Only the SHA-256 hash of the random state
 * is stored — never the raw state or PKCE verifier in SQLite.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

interface PendingOAuth {
  stateHash: string;
  sessionIdHash: string;
  provider: string;
  pkceVerifier?: string;
  /** Wizard multi-account rule: set when the flow re-authorizes an EXISTING
   * account row (reconnect); a fresh connect carries no row id, so the
   * callback can honestly refuse a duplicate with already_connected. */
  reconnectOf?: string;
  createdAt: number;
}

const pending = new Map<string, PendingOAuth>(); // key: stateHash

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now - entry.createdAt > STATE_TTL_MS) pending.delete(key);
  }
}

export function startOAuthFlow(provider: string, sessionId: string, pkceVerifier?: string, reconnectOf?: string): { state: string } {
  purgeExpired();
  if (pending.size >= MAX_PENDING) {
    throw Object.assign(new Error('Too many pending authorization flows; try again shortly.'), { safeCode: 'oauth_state_invalid' });
  }
  const state = crypto.randomBytes(32).toString('base64url');
  pending.set(sha256(state), {
    stateHash: sha256(state),
    sessionIdHash: sha256(sessionId),
    provider,
    pkceVerifier,
    reconnectOf,
    createdAt: Date.now(),
  });
  return { state };
}

export interface ConsumedFlow {
  provider: string;
  pkceVerifier?: string;
  reconnectOf?: string;
}

/** Consume exactly once; validates provider match and owning session. */
export function consumeOAuthState(state: string, provider: string, sessionId: string): ConsumedFlow | null {
  const stateHash = sha256(state);
  const entry = pending.get(stateHash);
  if (!entry) return null;
  pending.delete(stateHash); // one-time use, even on failure paths
  if (entry.provider !== provider) return null;
  if (entry.sessionIdHash !== sha256(sessionId)) return null;
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return { provider: entry.provider, pkceVerifier: entry.pkceVerifier, reconnectOf: entry.reconnectOf };
}

export function makePkcePair(): { verifier: string; challengeS256: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challengeS256 = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challengeS256 };
}

/** Test helper. */
export function clearPendingOAuthForTests(): void {
  pending.clear();
}
