import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type Database from 'better-sqlite3';
import type { ShareService } from '../shares/share-service.js';
import { ShareError } from '../shares/share-service.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { verifyPassword } from '../auth/password.js';
import {
  linkHasGate,
  issueGrant,
  requireGrantForLink,
  resolvePublicLink,
} from '../shares/unlock-gate.js';
import { makeLimiterKey } from '../middleware/limiter-key.js';

/**
 * SH-1 remediation router — the gate-aware public share endpoints.
 *
 * Mounted BEFORE the original public share router, this module intercepts
 * exactly two endpoints and enforces the unlock gate server-side:
 *
 *  1. POST /api/public/shares/:token/unlock
 *     A correct gate value now mints a share-bound unlock grant (returned
 *     once, hash-stored server-side). Ungated links keep the old response.
 *
 *  2. POST /api/public/shares/:token/files/:fileId/download-session
 *     For gated links a live grant bound to THIS link is mandatory before a
 *     download session can be issued. Knowing the public token plus a file
 *     id is no longer enough.
 *
 * All other public endpoints (landing view, attachment stream) remain in the
 * original router and are unaffected. Every response stays no-store; no
 * provider URL and no stored hash ever reaches the client.
 */

function gateError(res: Response, err: unknown): void {
  if (err instanceof ShareError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  const maybe = err as { safeCode?: unknown; httpStatus?: unknown };
  if (typeof maybe?.safeCode === 'string' && typeof maybe?.httpStatus === 'number') {
    res.status(maybe.httpStatus).json({ error: maybe.safeCode, code: maybe.safeCode });
    return;
  }
  res.status(500).json({ error: 'share_failed', code: 'share_failed' });
}

/** The submitted proof travels in the same field the landing form already used. */
function submittedAccessValue(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = body['password'];
  return typeof value === 'string' ? value : '';
}

/** The grant may arrive as a header or a JSON body field. */
function submittedGrant(req: Request): unknown {
  const header = req.header('x-share-unlock');
  if (typeof header === 'string' && header.length > 0) return header;
  const body = (req.body ?? {}) as Record<string, unknown>;
  return body['unlockGrant'];
}

export function gatedPublicSharesRouter(deps: {
  db: Database.Database;
  shares: ShareService;
  csrf: CsrfBundle;
  /** BE-02: whether the Cloudflare tunnel is currently serving traffic. */
  tunnelRunning: () => boolean;
}): Router {
  const router = Router();

  // BE-02: behind the tunnel, per-visitor keying uses the verified CF client
  // header; direct loopback traffic keeps the socket address.
  const unlockLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: makeLimiterKey(deps.tunnelRunning),
    message: { error: 'share_rate_limited' },
  });
  const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: makeLimiterKey(deps.tunnelRunning),
    message: { error: 'share_rate_limited' },
  });

  // Optional unlock. State-changing on a public route, so the project's
  // synchroniser CSRF protection is enforced exactly as before.
  router.post('/api/public/shares/:token/unlock', unlockLimiter, deps.csrf.doubleCsrfProtection, async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const rawLink = String(req.params['token']);
    try {
      const link = resolvePublicLink(deps.db, rawLink);
      if (!linkHasGate(deps.db, link.id)) {
        // No gate on this link: identical response shape as before.
        const view = deps.shares.publicView(rawLink, true);
        res.json({ ok: true, ...view, unlockGrant: null, unlockExpiresAtMs: null });
        return;
      }
      const ok = await verifyPassword(submittedAccessValue(req), link.password_hash ?? '');
      if (!ok) {
        res.status(401).json({ error: 'share_password_required', code: 'share_password_required' });
        return;
      }
      const grant = issueGrant(deps.db, link.id);
      const view = deps.shares.publicView(rawLink, true);
      res.json({ ok: true, ...view, unlockGrant: grant.grant, unlockExpiresAtMs: grant.expiresAtMs });
    } catch (err) {
      gateError(res, err);
    }
  });

  // Authorize (and consume) one download start — now behind the unlock gate
  // for protected links — then issue a temporary session path.
  router.post(
    '/api/public/shares/:token/files/:fileId/download-session',
    downloadLimiter,
    deps.csrf.doubleCsrfProtection,
    (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const rawLink = String(req.params['token']);
      try {
        const link = resolvePublicLink(deps.db, rawLink);
        if (linkHasGate(deps.db, link.id)) {
          // Fails closed: no live grant for THIS link -> 401, no session.
          requireGrantForLink(deps.db, link.id, submittedGrant(req));
        }
        // The service still enforces membership, file state, and the
        // race-safe download count; nothing about those rules relaxed.
        const issued = deps.shares.consumeDownloadStart(rawLink, String(req.params['fileId']));
        res.json({ downloadPath: `/s/d/${issued.sessionToken}`, expiresAtMs: issued.expiresAtMs });
      } catch (err) {
        gateError(res, err);
      }
    },
  );

  return router;
}
