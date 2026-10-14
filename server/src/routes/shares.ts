import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { ShareService } from '../shares/share-service.js';
import { ShareError } from '../shares/share-service.js';
import type { DeletionService } from '../deletions/deletion-service.js';
import { DeletionError } from '../deletions/deletion-service.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import type { SettingsService } from '../settings/settings-service.js';
import type Database from 'better-sqlite3';
import { revokeGrantsForLink } from '../shares/unlock-gate.js';
import { makeLimiterKey } from '../middleware/limiter-key.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * M12.a — settings are read per request, never cached at construction, so a
 * saved preference applies to the very next share. When no settings service is
 * available, every default stays exactly as it was before settings existed.
 */
function resolveSettings(req: Request, injected?: SettingsService): SettingsService | null {
  if (injected) return injected;
  const registered = req.app.get('settings') as SettingsService | undefined;
  return typeof registered?.get === 'function' ? registered : null;
}

/**
 * The single origin a share URL is built from: a configured public base URL
 * wins, otherwise the fixed app base URL. A request's Host header is never
 * consulted, so a hostile Host cannot forge a share link.
 */
function effectiveBaseUrl(appBaseUrl: string, settings: SettingsService | null): string {
  return settings?.get('domain.publicBaseUrl') ?? appBaseUrl;
}

/**
 * Effective expiry. An explicit body value wins — including an explicit null,
 * which keeps meaning "never expires"; only an omitted value falls back to the
 * configured number of days, materialized as a real timestamp from now.
 */
function effectiveExpiresAt(raw: unknown, settings: SettingsService | null): string | null {
  if (raw !== undefined) return typeof raw === 'string' ? raw : null;
  const days = settings?.get('share.defaultExpiryDays') ?? null;
  if (days === null) return null;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/**
 * Effective download limit. An absent value and an explicit 0 both mean "use
 * the configured default"; a negative value is refused here, in the route's own
 * safe error style, so it can never reach the database. Every other number is
 * passed through to the service, whose existing validation still applies.
 */
function effectiveDownloadLimit(raw: unknown, settings: SettingsService | null): number | null {
  if (typeof raw === 'number') {
    if (raw < 0) throw new ShareError('invalid_share_metadata', 400);
    if (raw !== 0) return raw;
  }
  return settings?.get('share.defaultDownloadLimit') ?? null;
}

export function sharesRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  shares: ShareService;
  deletions: DeletionService;
  appBaseUrl: string;
  /** Direct metadata connection, used for unlock-grant bookkeeping. */
  db: Database.Database;
  /** Optional: a caller without a settings service keeps today's defaults. */
  settings?: SettingsService;
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
      const settings = resolveSettings(req, deps.settings);
      const common = {
        fileIds,
        expiresAt: effectiveExpiresAt(body.expiresAt, settings),
        downloadLimit: effectiveDownloadLimit(body.downloadLimit, settings),
        baseUrl: effectiveBaseUrl(deps.appBaseUrl, settings),
      };
      const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : null;
      // A "passwords required" policy must never silently yield an open link,
      // so the caller is asked to supply one instead.
      if (password === null && settings?.get('share.requirePassword') === true) {
        throw new ShareError('share_password_required_by_policy', 400);
      }
      let created: { id: string; url: string; fileIds: string[] };
      if (password !== null) {
        created = await deps.shares.createWithPassword({ ...common, password });
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
      const rotated = deps.shares.rotate(
        String(req.params['id']),
        effectiveBaseUrl(deps.appBaseUrl, resolveSettings(req, deps.settings)),
      );
      revokeGrantsForLink(deps.db, String(req.params['id']));
      res.json({ ok: true, url: rotated.url });
    } catch (err) {
      shareError(res, err);
    }
  });

  router.post('/api/share-links/:id/revoke', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const revoked = deps.shares.revoke(String(req.params['id']));
      revokeGrantsForLink(deps.db, String(req.params['id']));
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
  /** BE-02: whether the Cloudflare tunnel is currently serving traffic. */
  tunnelRunning: () => boolean;
  /** Metadata for an authorized shared file (name/size/type only). */
  downloadFileInfo: (fileId: string) => { sizeBytes: number; mimeType: string | null; disposition: string } | null;
  /** Stream a file's verified chunks; never returns provider URLs. */
  streamSharedFile: (fileId: string, signal: AbortSignal) => AsyncGenerator<Buffer>;
}): Router {
  const router = Router();

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
