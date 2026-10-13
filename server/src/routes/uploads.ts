import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import type { UploadService, PlanRequest } from '../uploads/upload-service.js';
import { UploadError } from '../uploads/upload-service.js';
import { assertAllowedChunkSizeMiB, DEFAULT_CHUNK_SIZE_MIB, mibToBytes, ChunkMathError } from '../uploads/chunk-math.js';
import type { CredentialsStore } from '../providers/credentials-store.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';

/**
 * Upload API (M9).
 *
 * IMPORTANT ORDERING: the raw chunk upload route is registered by
 * `rawChunkRouter()` and MUST be mounted BEFORE any JSON body middleware, so no
 * parser buffers the chunk body. Every other route here is JSON.
 */

const MAX_CHUNK_BYTES = mibToBytes(64);

function uploadErrorResponse(res: Response, err: unknown): void {
  if (err instanceof UploadError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  if (err instanceof ChunkMathError) {
    res.status(400).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  if (err instanceof ProviderError) {
    const status = err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
    res.status(status).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  res.status(500).json({ error: 'upload_failed', code: 'upload_failed' });
}

/** Raw binary chunk upload. Mounted before JSON middleware. */
export function rawChunkRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  uploads: UploadService;
  store: CredentialsStore;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);
  const chunkLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'provider_rate_limited' },
  });

  router.put(
    '/api/uploads/:jobId/chunks/:chunkIndex',
    adminOnly,
    chunkLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      // CSRF for a raw-binary request: the token travels in the header, so the
      // synchroniser check runs here without any body parsing.
      next();
    },
    deps.csrf.doubleCsrfProtection,
    async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const jobId = String(req.params['jobId']);
      const chunkIndexRaw = String(req.params['chunkIndex']);
      const chunkIndex = Number(chunkIndexRaw);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        res.status(400).json({ error: 'invalid_upload_metadata', code: 'invalid_upload_metadata' });
        return;
      }
      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined) {
        const declared = Number(declaredLength);
        if (!Number.isFinite(declared) || declared > MAX_CHUNK_BYTES) {
          res.status(413).json({ error: 'chunk_size_mismatch', code: 'chunk_size_mismatch' });
          return;
        }
      }
      try {
        const job = deps.uploads.getJob(jobId);
        if (!job) throw new UploadError('job_not_found', 404);
        if (job.state === 'cancelled') throw new UploadError('job_not_resumable', 409);
        if (job.state === 'paused') throw new UploadError('job_paused', 409);
        const allocation = deps.uploads.listAllocations(jobId).find((a) => a.chunk_index === chunkIndex);
        if (!allocation) throw new UploadError('invalid_upload_metadata', 400);
        // authority comes from the persisted allocation, never from the client
        const accountRow = deps.uploads.getAccountForUpload(allocation.provider_account_id);
        if (!accountRow) throw new UploadError('account_needs_reauth', 409);

        const { attemptId, objectKey } = deps.uploads.beginAttempt({
          jobId, chunkIndex, accountId: allocation.provider_account_id,
        });

        const adapter = getAdapter(accountRow.provider);
        if (!adapter?.uploadObjectStream || !adapter.capabilities.upload) {
          throw new UploadError('provider_unavailable', 502);
        }
        const rootId = await deps.uploads.ensureOrCreateRoot(accountRow.id);
        const bundle = deps.uploads.loadBundleFor(accountRow.id);
        const appConfig = accountRow.provider === 'mega' || accountRow.provider === 'pcloud'
          ? undefined
          : deps.store.getConfig(accountRow.provider)?.config ?? undefined;

        // stream the request body: hash it while forwarding the same bytes
        const counter = deps.uploads.hashingTransform();
        const abort = new AbortController();
        req.on('aborted', () => abort.abort());
        const stream = req.pipe(counter);
        const ref = await adapter.uploadObjectStream(
          bundle,
          {
            rootId, objectKey, name: objectKey, readable: stream,
            sizeBytes: allocation.size_bytes, signal: abort.signal,
          },
          appConfig,
        );
        const { sha256, bytes } = deps.uploads.finalizeHash(counter);
        if (bytes !== allocation.size_bytes) {
          // too many or too few bytes: the attempt is a failure, not a success
          deps.uploads.recordFailure({
            jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey,
            safeCode: 'chunk_size_mismatch', bytesReceived: bytes, remoteObjectId: ref.remoteObjectId,
          });
          throw new UploadError('chunk_size_mismatch', 400);
        }
        const result = deps.uploads.commitChunk({
          jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey,
          remoteObjectId: ref.remoteObjectId, sha256, sizeBytes: bytes,
          providerChecksumType: ref.providerChecksum?.type,
        });
        void attemptId;
        res.json({
          ok: true,
          chunkIndex,
          sha256,
          bytes,
          chunksCompleted: result.chunksCompleted,
          bytesCompleted: result.bytesCompleted,
          fileCompleted: result.fileCompleted,
        });
      } catch (err) {
        uploadErrorResponse(res, err);
      }
    },
  );

  return router;
}

/** JSON upload API: plan, status, resume manifest, control. */
export function uploadsRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  uploads: UploadService;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);
  const planLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'provider_rate_limited' },
  });

  router.post('/api/uploads/plan', adminOnly, deps.csrf.doubleCsrfProtection, planLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? (req.headers['idempotency-key'] as string)
      : typeof body['idempotencyKey'] === 'string' ? (body['idempotencyKey'] as string) : '';
    if (!idempotencyKey || idempotencyKey.length > 200) {
      res.status(400).json({ error: 'invalid_upload_metadata', code: 'invalid_upload_metadata' });
      return;
    }
    try {
      const chunkSizeMiB = body['chunkSizeMiB'] === undefined
        ? DEFAULT_CHUNK_SIZE_MIB
        : assertAllowedChunkSizeMiB(body['chunkSizeMiB']);
      const plan: PlanRequest = {
        originalName: body['originalName'] as string,
        sizeBytes: Number(body['sizeBytes']),
        chunkSizeMiB,
        mimeType: typeof body['mimeType'] === 'string' ? (body['mimeType'] as string) : null,
        idempotencyKey,
      };
      const result = deps.uploads.plan(plan);
      res.status(result.reused ? 200 : 201).json({
        jobId: result.jobId,
        fileId: result.fileId,
        chunkCount: result.chunkCount,
        chunkSizeBytes: result.chunkSizeBytes,
        sizeBytes: result.sizeBytes,
        reused: result.reused,
        // the client learns only its own chunk geometry, never provider details
        allocations: result.allocations.map((a) => ({
          chunkIndex: a.chunkIndex, offsetBytes: a.offsetBytes, sizeBytes: a.sizeBytes,
        })),
      });
    } catch (err) {
      uploadErrorResponse(res, err);
    }
  });

  router.get('/api/uploads', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const jobs = deps.uploads.listJobs(50).map((job) => deps.uploads.publicJob(job.id));
    res.json({ jobs });
  });

  router.get('/api/uploads/:jobId', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const job = deps.uploads.publicJob(String(req.params['jobId']));
    if (!job) {
      res.status(404).json({ error: 'job_not_found', code: 'job_not_found' });
      return;
    }
    res.json({ job });
  });

  router.get('/api/uploads/:jobId/resume-manifest', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const offset = Math.max(0, Number(req.query['offset'] ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 200) || 200));
    try {
      const manifest = deps.uploads.getResumeManifest(String(req.params['jobId']), offset, limit);
      res.json(manifest);
    } catch (err) {
      uploadErrorResponse(res, err);
    }
  });

  router.get('/api/dashboard/summary', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(deps.uploads.dashboardSummary());
  });

  router.get('/api/files', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const offset = Math.max(0, Number(req.query['offset'] ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
    const search = typeof req.query['search'] === 'string' ? req.query['search'].toLowerCase() : '';
    let files = deps.uploads.listFiles(limit, offset).map((f) => deps.uploads.publicFile(f.id));
    if (search) files = files.filter((f) => (f?.originalName ?? '').toLowerCase().includes(search));
    res.json({ files, total: deps.uploads.countFiles() });
  });

  for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) {
    router.post(`/api/uploads/:jobId/${action}`, adminOnly, deps.csrf.doubleCsrfProtection, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const jobId = String(req.params['jobId']);
      try {
        if (action === 'pause') deps.uploads.pause(jobId);
        if (action === 'resume') deps.uploads.resume(jobId);
        if (action === 'retry') deps.uploads.resume(jobId);
        if (action === 'cancel') await deps.uploads.cancel(jobId);
        const job = deps.uploads.publicJob(jobId);
        res.json({ ok: true, job });
      } catch (err) {
        uploadErrorResponse(res, err);
      }
    });
  }

  return router;
}
