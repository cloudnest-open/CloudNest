import { Router, type Request, type Response } from 'express';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requirePrincipal } from '../middleware/require-admin.js';
import type { FolderService } from '../files/folder-service.js';
import { FolderError } from '../files/folder-service.js';
import type { TrashService } from '../files/trash-service.js';
import { TrashError, TRASH_RETENTION_MS } from '../files/trash-service.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { UploadService } from '../uploads/upload-service.js';
import type { MirrorService } from '../mirroring/mirror-service.js';
import { MirrorError } from '../mirroring/mirror-service.js';

/**
 * Roadmap Phase 4 — folders, trash and the notification feed. Every route is
 * principal-gated; mutations are CSRF-protected. Ownership follows the Phase 3
 * rule: a member only ever touches their own resources (foreign ids answer the
 * same 404 as missing ones); the admin role sees everything and purges
 * anywhere, while folder/tree mutations stay inside the caller's own tree.
 */

interface FilesRouterDeps {
  queries: Queries;
  csrf: CsrfBundle;
  folders: FolderService;
  trash: TrashService;
  notifications: NotificationService;
  uploads: UploadService;
  mirror: MirrorService;
}

function folderError(res: Response, err: unknown): void {
  if (err instanceof FolderError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  res.status(500).json({ error: 'internal_error', code: 'internal_error' });
}

function trashError(res: Response, err: unknown): void {
  if (err instanceof TrashError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  res.status(500).json({ error: 'internal_error', code: 'internal_error' });
}

function mirrorError(res: Response, err: unknown): void {
  if (err instanceof MirrorError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  res.status(500).json({ error: 'internal_error', code: 'internal_error' });
}

/** 'root' is the client's name for the principal's tree root (null parent). */
function folderIdOrRoot(value: unknown): string | null {
  if (value === 'root' || value === '' || value === undefined || value === null) return null;
  return String(value);
}

export function filesRouter(deps: FilesRouterDeps): Router {
  const router = Router();
  const principalOnly = requirePrincipal(deps.queries);

  // ---- folders ----

  router.post('/api/folders', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const body = (req.body ?? {}) as { name?: unknown; parentId?: unknown };
    if (typeof body.name !== 'string') {
      res.status(400).json({ error: 'invalid_folder_name', code: 'invalid_folder_name' });
      return;
    }
    try {
      const parentId = folderIdOrRoot(body.parentId);
      const folder = deps.folders.create(principal.id, parentId, body.name);
      res.status(201).json({ folder });
    } catch (err) {
      folderError(res, err);
    }
  });

  router.get('/api/folders/:folderId/children', principalOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    try {
      const parentId = folderIdOrRoot(req.params['folderId']);
      // the read scope decides whether this tree is visible at all
      let breadcrumb: Array<{ id: string; name: string }> = [];
      if (parentId !== null) {
        deps.folders.scopedGet(parentId, principal.role === 'admin' ? null : principal.id);
        breadcrumb = deps.folders.breadcrumb(parentId);
      }
      const folders = deps.folders.children(principal.role === 'admin' ? null : principal.id, parentId);
      // one grouped pair of queries for the whole page instead of a COUNT pair
      // per folder
      const countsByParent = deps.folders.countsForParents(folders.map((f) => f.id));
      res.json({
        breadcrumb,
        folders: folders.map((f) => ({
          id: f.id,
          name: f.name,
          parentId: f.parent_id,
          createdAt: f.created_at,
          // rename/delete/move are tree-owner actions; the read-scoped admin
          // sees another principal's tree but does not mutate it
          owned: f.user_id === principal.id,
          counts: countsByParent.get(f.id) ?? { folders: 0, files: 0 },
        })),
      });
    } catch (err) {
      folderError(res, err);
    }
  });

  router.patch('/api/folders/:folderId', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string') {
      res.status(400).json({ error: 'invalid_folder_name', code: 'invalid_folder_name' });
      return;
    }
    try {
      const folder = deps.folders.rename(req.principal!.id, String(req.params['folderId']), body.name);
      res.json({ ok: true, folder });
    } catch (err) {
      folderError(res, err);
    }
  });

  router.delete('/api/folders/:folderId', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      deps.folders.delete(req.principal!.id, String(req.params['folderId']));
      res.json({ ok: true });
    } catch (err) {
      folderError(res, err);
    }
  });

  // ---- move ----

  router.post('/api/files/:fileId/move', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const body = (req.body ?? {}) as { folderId?: unknown; fileIds?: unknown };
    const ids = Array.isArray(body.fileIds) && body.fileIds.length > 0
      ? body.fileIds.filter((v): v is string => typeof v === 'string')
      : [String(req.params['fileId'])];
    try {
      const target = folderIdOrRoot(body.folderId);
      const result = deps.folders.moveFiles(
        principal.role === 'admin' ? null : principal.id,
        ids,
        target,
      );
      res.json({ ok: result.failed.length === 0, ...result });
    } catch (err) {
      folderError(res, err);
    }
  });

  // ---- trash ----

  router.get('/api/trash', principalOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const owner = principal.role === 'admin' ? null : principal.id;
    const offset = Math.max(0, Number(req.query['offset'] ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
    const rows = deps.trash.list(owner, limit, offset);
    const shaped = deps.uploads.publicFiles(rows.map((r) => r.id));
    res.json({
      // retention is a fixed constant; the client shows the honest date per file
      retentionDays: Math.round(TRASH_RETENTION_MS / (24 * 60 * 60 * 1000)),
      files: rows.map((r) => ({
        ...(shaped.get(r.id) ?? { id: r.id, originalName: r.original_name, sizeBytes: r.size_bytes, storedAcross: [] as string[] }),
        state: r.state,
        trashedAt: r.trashed_at,
      })),
      total: deps.trash.count(owner),
    });
  });

  router.post('/api/trash/empty', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const owner = principal.role === 'admin' ? null : principal.id;
    res.json({ ok: true, purged: deps.trash.empty(owner) });
  });

  router.post('/api/files/:fileId/restore', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    try {
      deps.trash.restore(principal.role === 'admin' ? null : principal.id, String(req.params['fileId']));
      res.json({ ok: true });
    } catch (err) {
      trashError(res, err);
    }
  });

  router.post('/api/files/:fileId/purge', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    try {
      const queued = deps.trash.purge(principal.role === 'admin' ? null : principal.id, String(req.params['fileId']));
      res.status(202).json({ ok: true, jobId: queued.jobId, state: queued.state });
    } catch (err) {
      trashError(res, err);
    }
  });

  // ---- mirror (roadmap Phase 5, §4.5) ----

  /**
   * Queue (or re-drive) a chunk mirror for a completed file. POSTing over a
   * FAILED mirror job retries it; any other active job answers 409. The copy
   * runs in the background on the same durable engine; the client polls GET.
   */
  router.post('/api/files/:fileId/mirror', principalOnly, deps.csrf.doubleCsrfProtection, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const fileId = String(req.params['fileId']);
    const file = deps.uploads.getFile(fileId);
    if (!file || (principal.role !== 'admin' && file.user_id !== principal.id)) {
      res.status(404).json({ error: 'file_not_found', code: 'file_not_found' });
      return;
    }
    try {
      const latest = deps.mirror.jobForFile(fileId);
      if (latest && latest.state === 'failed') {
        const result = await deps.mirror.retry(latest.jobId);
        res.status(202).json({ ok: true, jobId: latest.jobId, state: result.state });
        return;
      }
      const queued = deps.mirror.enqueue(principal.role === 'admin' ? null : principal.id, fileId);
      // fire-and-forget: the job row is durable, the scheduler and this kick
      // both drive it, and a crash can never lose the work
      void deps.mirror.process(queued.jobId).catch(() => {
        // stays recorded; the sweep or an explicit POST drives it again
      });
      res.status(202).json({ ok: true, jobId: queued.jobId, state: queued.state });
    } catch (err) {
      mirrorError(res, err);
    }
  });

  router.get('/api/files/:fileId/mirror', principalOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const fileId = String(req.params['fileId']);
    const file = deps.uploads.getFile(fileId);
    if (!file || (principal.role !== 'admin' && file.user_id !== principal.id)) {
      res.status(404).json({ error: 'file_not_found', code: 'file_not_found' });
      return;
    }
    const job = deps.mirror.jobForFile(fileId);
    res.json({
      job,
      chunkCount: file.chunk_count,
      mirroredChunks: deps.mirror.mirroredChunkCount(fileId),
    });
  });

  // ---- notification feed ----

  router.get('/api/notifications', principalOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const offset = Math.max(0, Number(req.query['offset'] ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 30) || 30));
    const rows = deps.notifications.list(principal.id, limit, offset);
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: JSON.parse(n.payload) as Record<string, unknown>,
        readAt: n.read_at,
        createdAt: n.created_at,
      })),
      unreadCount: deps.notifications.unreadCount(principal.id),
    });
  });

  router.post('/api/notifications/:id/read', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const marked = deps.notifications.markRead(principal.id, String(req.params['id']));
    res.json({ ok: true, marked, unreadCount: deps.notifications.unreadCount(principal.id) });
  });

  router.post('/api/notifications/read-all', principalOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = req.principal!;
    const marked = deps.notifications.markAllRead(principal.id);
    res.json({ ok: true, marked, unreadCount: 0 });
  });

  return router;
}
