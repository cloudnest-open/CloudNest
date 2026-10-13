import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Queries } from '../db/queries.js';

/**
 * Admin gate: a valid server-side session whose authVersion matches the
 * current admin_users.auth_version. Stale sessions (e.g. after a password
 * change) are rejected and destroyed. Hiding UI is not access control.
 */
export function requireAdmin(queries: Queries): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = req.session;
    const admin = queries.getAdmin();
    if (
      !session ||
      session.adminId !== 1 ||
      typeof session.authVersion !== 'number' ||
      !admin ||
      session.authVersion !== admin.auth_version
    ) {
      req.session?.destroy(() => {});
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}
