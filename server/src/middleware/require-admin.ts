import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Queries } from '../db/queries.js';

/**
 * Roadmap Phase 3: the session gate now recognises two principal kinds.
 *
 * - kind 'admin': the built-in root admin (admin_users id=1). Its files are
 *   attributed to the seeded users row ADMIN_USER_ID; its credentials are
 *   unchanged and it keeps signing in with the username 'admin'.
 * - kind 'user': a users-table account (admin or member role). A member's
 *   stale sessions are rejected the same way the root admin's are: the
 *   session's stored auth_version must still match the user's current one.
 *
 * Hiding UI is not access control — every router keeps its own server-side
 * gate, exactly as before.
 */

/** The users-table row that represents the built-in root admin. */
export const ADMIN_USER_ID = 'usr_admin';

export interface Principal {
  kind: 'admin' | 'user';
  id: string;
  role: 'admin' | 'member';
  authVersion: number;
}

/** Resolve the authenticated principal for a request, or null when none is valid. */
export function resolvePrincipal(req: Request, queries: Queries): Principal | null {
  const session = req.session;
  if (!session) return null;
  if (session.adminId === 1 && typeof session.authVersion === 'number') {
    const admin = queries.getAdmin();
    if (admin && session.authVersion === admin.auth_version) {
      return { kind: 'admin', id: ADMIN_USER_ID, role: 'admin', authVersion: session.authVersion };
    }
    return null;
  }
  if (typeof session.userId === 'string' && typeof session.userAuthVersion === 'number') {
    const user = queries.getUser(session.userId);
    if (user && user.status === 'active' && session.userAuthVersion === user.auth_version) {
      return { kind: 'user', id: user.id, role: user.role, authVersion: user.auth_version };
    }
  }
  return null;
}

function reject(res: Response): void {
  res.status(401).json({ error: 'Authentication required' });
}

/** Any authenticated principal: the root admin or any active users-table account. */
export function requirePrincipal(queries: Queries): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = resolvePrincipal(req, queries);
    if (!principal) {
      req.session?.destroy(() => {});
      reject(res);
      return;
    }
    req.principal = principal;
    next();
  };
}

/**
 * Admin gate: a valid principal whose role is admin (the root admin, or a
 * users-table account with role 'admin'). An authenticated member is refused
 * with 403 — the session itself is fine, the resource is not theirs to touch.
 */
export function requireAdmin(queries: Queries): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = resolvePrincipal(req, queries);
    if (!principal) {
      req.session?.destroy(() => {});
      reject(res);
      return;
    }
    if (principal.role !== 'admin') {
      res.status(403).json({ error: 'Administrator access required' });
      return;
    }
    req.principal = principal;
    next();
  };
}
