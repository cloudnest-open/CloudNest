import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { ShareService } from '../shares/share-service.js';
import { ShareError } from '../shares/share-service.js';
import type { DeletionService } from '../deletions/deletion-service.js';
import { DeletionError } from '../deletions/deletion-service.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';

/**
 * Share links and deletion (M11.a–d).
 *
 * Public routes deliberately reveal nothing until authorized: a password
 * protected landing page shows no file names, and every response is no-store.
 */

function shareError(res: Response, err: unknown): void {
  if (err instanceof ShareError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  if (err instanceof DeletionError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  res.status(500).json({ error: 'share_failed', code: 'share_failed' });
}

export function sharesRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  shares: ShareService;
  deletions: DeletionService;
  appBaseUrl: string;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);

  // ---- admin: create/list/update/revoke ----
  router.post('/api/share-links', adminOnly, deps.csrf.doubleCsrfProtection, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      fileIds?: unknown; password?: unknown; expiresAt?: unknown; downloadLimit?: unknown;
    };
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((v): v is string => typeof v === 'string') : [];
    try {
      let created: { id: string; url: string; fileIds: string[] };
      const common = {
        fileIds,
        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        downloadLimit: typeof body.downloadLimit === 'number' ? body.downloadLimit : null,
        baseUrl: deps.appBaseUrl,
      };
      if (typeof body.password === 'string' && body.password.length > 0) {
        created = await deps.shares.createWithPassword({ ...common, password: body.password });
      } else {
        created = deps.shares.create(common);
      }
      deps.queries.recordAudit('share_link_created', true, 'created');
      // the raw URL is returned exactly once, here
      res.status(201).json({ id: created.id, url: created.url, fileIds: created.fileIds });
    } catch (err) {
      shareError(res, err);
    }
  });

  router.get('/api/share-links', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ links: deps.shares.listLinks() });
  });

  router.get('/api/share-links/:id', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const link = deps.shares.getLink(String(req.params['id']));
    if (!link) {
      res.status(404).json({ error: 'share_not_found', code: 'share_not_found' });
      return;
    }
    res.json({ link });
  });

  router.patch('/api/share-links/:id', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { expiresAt?: unknown; downloadLimit?: unknown };
    try {
      deps.shares.update(String(req.params['id']), {
        ...(body.expiresAt !== undefined ? { expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null } : {}),
        ...(body.downloadLimit !== undefined
          ? { downloadLimit: typeof body.downloadLimit === 'number' ? body.downloadLimit : null }
          : {}),
      });
      res.json({ ok: true, link: deps.shares.getLink(String(req.params['id'])) });
    } catch (err) {
      shareError(res, err);
    }
  });

  router.post('/api/share-links/:id/rotate', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const rotated = deps.shares.rotate(String(req.params['id']), deps.appBaseUrl);
      res.json({ ok: true, url: rotated.url });
    } catch (err) {
      shareError(res, err);
    }
  });

  router.post('/api/share-links/:id/revoke', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const revoked = deps.shares.revoke(String(req.params['id']));
      res.json({ ok: true, revoked });
    } catch (err) {
      shareError(res, err);
    }
  });

  // ---- admin: deletion ----
  router.delete('/api/files/:fileId', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const queued = deps.deletions.enqueue(String(req.params['fileId']));
      res.status(202).json({ ok: true, jobId: queued.jobId, state: queued.state });
    } catch (err) {
      shareError(res, err);
    }
  });

  router.get('/api/deletions/:jobId', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const status = deps.deletions.jobStatus(String(req.params['jobId']));
    if (!status) {
      res.status(404).json({ error: 'file_not_found', code: 'file_not_found' });
      return;
    }
    res.json({ deletion: status });
  });

  router.post('/api/deletions/:jobId/retry', adminOnly, deps.csrf.doubleCsrfProtection, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await deps.deletions.retry(String(req.params['jobId']));
      res.json({ ok: true, result });
    } catch (err) {
      shareError(res, err);
    }
  });

  return router;
}

/** Public share routes: no admin session, but never trusting by default. */
export function publicSharesRouter(deps: {
  shares: ShareService;
  csrf: CsrfBundle;
  /** Metadata for an authorized shared file (name/size/type only). */
  downloadFileInfo: (fileId: string) => { sizeBytes: number; mimeType: string | null; disposition: string } | null;
  /** Stream a file's verified chunks; never returns provider URLs. */
  streamSharedFile: (fileId: string, signal: AbortSignal) => AsyncGenerator<Buffer>;
}): Router {
  const router = Router();

  const unlockLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'share_rate_limited' },
  });
  const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'share_rate_limited' },
  });

  // Landing page data. Without a valid unlock nothing is disclosed.
  router.get('/api/public/shares/:token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const view = deps.shares.publicView(String(req.params['token']), false);
      res.json(view);
    } catch (err) {
      // an invalid/revoked/expired token must be indistinguishable in shape
      shareError(res, err);
    }
  });

  // Optional password unlock. State-changing on a public route, so the project's
  // synchroniser CSRF token is enforced exactly as it is for admin routes.
  router.post('/api/public/shares/:token/unlock', unlockLimiter, deps.csrf.doubleCsrfProtection, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { password?: unknown };
    try {
      const ok = await deps.shares.verifyPassword(
        String(req.params['token']),
        typeof body.password === 'string' ? body.password : '',
      );
      if (!ok) {
        res.status(401).json({ error: 'share_password_required', code: 'share_password_required' });
        return;
      }
      const view = deps.shares.publicView(String(req.params['token']), true);
      res.json({ ok: true, ...view });
    } catch (err) {
      shareError(res, err);
    }
  });

  // Authorize (and consume) one download start, then issue a temporary token.
  router.post(
    '/api/public/shares/:token/files/:fileId/download-session',
    downloadLimiter,
    deps.csrf.doubleCsrfProtection,
    (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const issued = deps.shares.consumeDownloadStart(
          String(req.params['token']),
          String(req.params['fileId']),
        );
        res.json({ downloadPath: `/s/d/${issued.sessionToken}`, expiresAtMs: issued.expiresAtMs });
      } catch (err) {
        shareError(res, err);
      }
    },
  );

  /**
   * Authorized attachment stream for a consumed download session.
   * The parent link is rechecked on every request; only the file's own chunks
   * are read, and every chunk is verified before its bytes are emitted.
   */
  router.get('/s/d/:sessionToken', downloadLimiter, async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const auth = deps.shares.authorizeSession(String(req.params['sessionToken']));
      const file = deps.downloadFileInfo(auth.fileId);
      if (!file) throw new ShareError('file_not_found', 404);
      res.set('Content-Type', file.mimeType ?? 'application/octet-stream');
      res.set('Content-Disposition', file.disposition);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Length', String(file.sizeBytes));
      const controller = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      for await (const chunk of deps.streamSharedFile(auth.fileId, controller.signal)) {
        if (controller.signal.aborted) break;
        if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', () => resolve()));
      }
      if (!controller.signal.aborted) res.end();
      else res.destroy();
    } catch (err) {
      if (!res.headersSent) shareError(res, err);
      else res.destroy();
    }
  });

  router.head('/s/d/:sessionToken', downloadLimiter, (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const auth = deps.shares.authorizeSession(String(req.params['sessionToken']));
      const file = deps.downloadFileInfo(auth.fileId);
      if (!file) throw new ShareError('file_not_found', 404);
      res.set('Content-Type', file.mimeType ?? 'application/octet-stream');
      res.set('Content-Disposition', file.disposition);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Length', String(file.sizeBytes));
      res.status(200).end();
    } catch (err) {
      shareError(res, err);
    }
  });

  return router;
}
