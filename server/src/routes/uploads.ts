import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import type { UploadService, PlanRequest } from '../uploads/upload-service.js';
import { UploadError, CapacityInsufficientError, compareProviderChecksum } from '../uploads/upload-service.js';
import type { SettingsService } from '../settings/settings-service.js';
import { assertAllowedChunkSizeMiB, DEFAULT_CHUNK_SIZE_MIB, mibToBytes, ChunkMathError } from '../uploads/chunk-math.js';
import type { CredentialsStore } from '../providers/credentials-store.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import { isS3Bundle, presignUploadUrl } from '../providers/s3-files.js';

/**
 * Upload API (M9).
 *
 * IMPORTANT ORDERING: the raw chunk upload route is registered by
 * `rawChunkRouter()` and MUST be mounted BEFORE any JSON body middleware, so no
 * parser buffers the chunk body. Every other route here is JSON.
 */

const MAX_CHUNK_BYTES = mibToBytes(64);

/**
 * §10: adapter errors that leave the remote outcome UNKNOWN — the upload may
 * or may not have been accepted. For these, the handler probes the provider
 * with the attempt's app-generated key before recording the failure.
 */
const AMBIGUOUS_UPLOAD_CODES = new Set(['provider_unavailable', 'upload_aborted']);

/**
 * Phase 2: safe codes a direct-transfer client may report on the fail route.
 * Anything else degrades to the generic upload_failed — a client never gets
 * to write arbitrary strings into the job's error column.
 */
const DIRECT_FAIL_CODES = new Set(['provider_rate_limited', 'provider_unavailable', 'upload_aborted', 'upload_failed']);

/** A client-reported digest must at least look like a SHA-256 hex string. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

function uploadErrorResponse(res: Response, err: unknown): void {
  if (err instanceof CapacityInsufficientError) {
    // §7.1(7): a refused plan explains itself — shortfall, per-account safe
    // reasons, and (on pure fragmentation) the largest feasible smaller chunk.
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode, ...err.detail });
    return;
  }
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
  settings: SettingsService;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);
  const chunkLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'provider_rate_limited' },
  });

  /**
   * §10: after an ambiguous adapter error, ask the provider whether the
   * attempt's object exists anyway (lookup by the CloudNest-generated key).
   * Returns the remote id when found, else null. Never guesses success: a
   * found object becomes a durable cleanup obligation, not a completed chunk.
   */
  async function probeAmbiguousObject(providerId: string, accountId: string, rootId: string | null, objectKey: string): Promise<string | null> {
    if (!rootId) return null;
    try {
      const adapter = getAdapter(providerId);
      if (!adapter?.findAppObjectByKey) return null;
      const bundle = deps.uploads.loadBundleFor(accountId);
      const appConfig = providerId === 'mega' || providerId === 'pcloud'
        ? undefined
        : deps.store.getConfig(providerId)?.config ?? undefined;
      const found = await adapter.findAppObjectByKey(bundle, rootId, objectKey, appConfig);
      return found?.remoteObjectId ?? null;
    } catch {
      return null;
    }
  }

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
      // durable-state tracking that must survive into the catch block
      let objectKey: string | null = null;
      let uploadedAccountId: string | null = null;
      let uploadedProviderId = '';
      let rootIdForProbe: string | null = null;
      let failureRecorded = false;
      try {
        const job = deps.uploads.getJob(jobId);
        if (!job) throw new UploadError('job_not_found', 404);
        if (job.state === 'cancelled') throw new UploadError('job_not_resumable', 409);
        if (job.state === 'paused') throw new UploadError('job_paused', 409);
        // UL-2: a completed file is immutable from the upload path; a late or
        // replayed chunk PUT must not write a divergent placement under it.
        if (job.state === 'completed') throw new UploadError('job_not_resumable', 409);
        const allocation = deps.uploads.listAllocations(jobId).find((a) => a.chunk_index === chunkIndex);
        if (!allocation) throw new UploadError('invalid_upload_metadata', 400);
        // authority comes from the persisted allocation, never from the client
        const accountRow = deps.uploads.getAccountForUpload(allocation.provider_account_id);
        if (!accountRow) throw new UploadError('account_needs_reauth', 409);

        const { attemptId, objectKey: key } = deps.uploads.beginAttempt({
          jobId, chunkIndex, accountId: allocation.provider_account_id,
        });
        objectKey = key;
        uploadedAccountId = allocation.provider_account_id;
        uploadedProviderId = accountRow.provider;

        const adapter = getAdapter(accountRow.provider);
        if (!adapter?.uploadObjectStream || !adapter.capabilities.upload) {
          throw new UploadError('provider_unavailable', 502);
        }
        const rootId = await deps.uploads.ensureOrCreateRoot(accountRow.id);
        rootIdForProbe = rootId;
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
          failureRecorded = true;
          throw new UploadError('chunk_size_mismatch', 400);
        }
        // M12.a `upload.verifyIntegrity`: when enabled, a provider checksum is
        // honoured when AND ONLY when its algorithm is the same as ours. A
        // mismatch is a failure; a different algorithm is never compared and
        // never labelled as a verified checksum.
        if (deps.settings.get('upload.verifyIntegrity')) {
          const verdict = compareProviderChecksum(ref.providerChecksum, sha256);
          if (verdict === 'mismatch') {
            deps.uploads.recordFailure({
              jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey,
              safeCode: 'chunk_hash_mismatch', bytesReceived: bytes, remoteObjectId: ref.remoteObjectId,
            });
            failureRecorded = true;
            throw new UploadError('chunk_hash_mismatch', 502);
          }
        }
        const result = deps.uploads.commitChunk({
          jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey,
          remoteObjectId: ref.remoteObjectId, sha256, sizeBytes: bytes,
          providerChecksumType: ref.providerChecksum?.type,
          providerChecksumValue: ref.providerChecksum?.value,
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
        // §9 contention: the per-account in-flight gate rejects BEFORE any
        // durable state changes. Pure backpressure — no failure is recorded,
        // the client simply waits and re-PUTs the same chunk.
        if (err instanceof UploadError && err.safeCode === 'account_busy') {
          res.set('Retry-After', '2');
          uploadErrorResponse(res, err);
          return;
        }
        // a begun attempt must never linger unresolved: record the outcome
        // durably so retry/restart reconcile it instead of forgetting it
        if (objectKey && uploadedAccountId && !failureRecorded) {
          const safeCode = err instanceof UploadError || err instanceof ProviderError
            ? err.safeCode
            : 'upload_failed';
          let remoteObjectId: string | null = null;
          if (err instanceof ProviderError && AMBIGUOUS_UPLOAD_CODES.has(err.safeCode)) {
            remoteObjectId = await probeAmbiguousObject(uploadedProviderId, uploadedAccountId, rootIdForProbe, objectKey);
          }
          deps.uploads.recordFailure({
            jobId, chunkIndex, accountId: uploadedAccountId, objectKey,
            safeCode, bytesReceived: 0, remoteObjectId,
          });
          // §7.3: an insufficient-storage rejection makes the quota observation
          // stale so no new chunk is planned onto that account until refresh
          if (safeCode === 'provider_no_space') {
            deps.uploads.markQuotaStale(uploadedAccountId, safeCode);
          }
        }
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
  settings: SettingsService;
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
      // M12.a: an explicit per-request chunk size still wins; otherwise the
      // saved Upload & Storage setting is the default (never for an already
      // uploaded logical file, whose geometry is stored per file).
      const chunkSizeMiB = body['chunkSizeMiB'] === undefined
        ? deps.settings.effectiveChunkSizeMiB()
        : assertAllowedChunkSizeMiB(body['chunkSizeMiB']);
      // roadmap Phase 1: the storage tier chooses the pool (personal OAuth vs
      // business S3); anything but the two documented values is refused.
      const tierBody = body['tier'];
      const tier = tierBody === undefined ? 'personal' : tierBody;
      if (tier !== 'personal' && tier !== 'business') {
        res.status(400).json({ error: 'invalid_upload_metadata', code: 'invalid_upload_metadata' });
        return;
      }
      const plan: PlanRequest = {
        originalName: body['originalName'] as string,
        sizeBytes: Number(body['sizeBytes']),
        chunkSizeMiB,
        mimeType: typeof body['mimeType'] === 'string' ? (body['mimeType'] as string) : null,
        idempotencyKey,
        tier,
        routingStrategy: deps.settings.get('upload.spaceAwareRouting') ? 'capacity-aware' : 'balanced',
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
    // M12.a: the worker bound the UI must respect is served from settings, so
    // the client can never invent a higher limit than the admin configured.
    res.json({ jobs, workerLimit: deps.settings.effectiveWorkerLimit() });
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

  // ---- Roadmap Phase 2: presigned direct transfer ----
  // The browser asks where one chunk should go. S3-compatible accounts get a
  // one-object, one-hour presigned PUT URL and the bytes never pass through
  // CloudNest; every other provider keeps the proxy PUT. The client never
  // learns an account id, a credential, or which provider serves the chunk.
  const directLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'provider_rate_limited' },
  });

  router.post(
    '/api/uploads/:jobId/chunks/:chunkIndex/begin',
    adminOnly,
    deps.csrf.doubleCsrfProtection,
    directLimiter,
    async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const jobId = String(req.params['jobId']);
      const chunkIndex = Number(String(req.params['chunkIndex']));
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        res.status(400).json({ error: 'invalid_upload_metadata', code: 'invalid_upload_metadata' });
        return;
      }
      // durable-state tracking so a begun attempt is never left unresolved
      let attemptObjectKey: string | null = null;
      let attemptAccountId: string | null = null;
      try {
        const job = deps.uploads.getJob(jobId);
        if (!job) throw new UploadError('job_not_found', 404);
        if (job.state === 'cancelled' || job.state === 'completed') throw new UploadError('job_not_resumable', 409);
        if (job.state === 'paused') throw new UploadError('job_paused', 409);
        const allocation = deps.uploads.listAllocations(jobId).find((a) => a.chunk_index === chunkIndex);
        if (!allocation) throw new UploadError('invalid_upload_metadata', 400);
        const accountRow = deps.uploads.getAccountForUpload(allocation.provider_account_id);
        if (!accountRow) throw new UploadError('account_needs_reauth', 409);
        // attempt row FIRST (crash-recovery anchor, same as the proxy path);
        // a 429 account_busy is thrown before any durable state changes
        const begun = deps.uploads.beginAttempt({
          jobId, chunkIndex, accountId: allocation.provider_account_id,
        });
        attemptObjectKey = begun.objectKey;
        attemptAccountId = allocation.provider_account_id;
        if (accountRow.provider !== 's3') {
          res.json({ mode: 'proxy' });
          return;
        }
        const rootId = await deps.uploads.ensureOrCreateRoot(accountRow.id);
        const bundle = deps.uploads.loadBundleFor(accountRow.id);
        if (!isS3Bundle(bundle)) throw new UploadError('account_needs_reauth', 409);
        const presigned = presignUploadUrl(bundle, rootId, begun.objectKey);
        res.json({
          mode: 'direct',
          attemptId: begun.attemptId,
          objectKey: begun.objectKey,
          url: presigned.url,
          expiresAt: presigned.expiresAt,
        });
      } catch (err) {
        if (attemptObjectKey && attemptAccountId) {
          deps.uploads.recordFailure({
            jobId, chunkIndex, accountId: attemptAccountId, objectKey: attemptObjectKey,
            safeCode: err instanceof UploadError || err instanceof ProviderError ? err.safeCode : 'upload_failed',
            bytesReceived: 0, remoteObjectId: null,
          });
        }
        if (err instanceof UploadError && err.safeCode === 'account_busy') {
          res.set('Retry-After', '2');
        }
        uploadErrorResponse(res, err);
      }
    },
  );

  router.post(
    '/api/uploads/:jobId/chunks/:chunkIndex/complete',
    adminOnly,
    deps.csrf.doubleCsrfProtection,
    directLimiter,
    async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const jobId = String(req.params['jobId']);
      const chunkIndex = Number(String(req.params['chunkIndex']));
      const body = (req.body ?? {}) as { attemptId?: unknown; sha256?: unknown; etag?: unknown };
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
      const sha256 = typeof body.sha256 === 'string' ? body.sha256 : '';
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !attemptId || !SHA256_HEX.test(sha256)) {
        res.status(400).json({ error: 'invalid_upload_metadata', code: 'invalid_upload_metadata' });
        return;
      }
      try {
        const job = deps.uploads.getJob(jobId);
        if (!job) throw new UploadError('job_not_found', 404);
        if (job.state === 'cancelled' || job.state === 'completed') throw new UploadError('job_not_resumable', 409);
        if (job.state === 'paused') throw new UploadError('job_paused', 409);
        const allocation = deps.uploads.listAllocations(jobId).find((a) => a.chunk_index === chunkIndex);
        if (!allocation) throw new UploadError('invalid_upload_metadata', 400);
        const attempt = deps.uploads.getAttemptForChunk(jobId, chunkIndex, attemptId);
        if (!attempt || attempt.provider_account_id !== allocation.provider_account_id) {
          throw new UploadError('invalid_upload_metadata', 400);
        }
        const accountRow = deps.uploads.getAccountForUpload(allocation.provider_account_id);
        if (!accountRow) throw new UploadError('account_needs_reauth', 409);
        // complete exists for the direct flow only; OAuth chunks go through
        // the proxy PUT, which commits by itself
        if (accountRow.provider !== 's3') throw new UploadError('invalid_upload_metadata', 400);
        // the browser's receipt is never trusted for size: the server asks the
        // provider itself (HeadObject) before anything is committed
        const adapter = getAdapter('s3');
        if (!adapter?.findAppObjectByKey) throw new UploadError('provider_unavailable', 502);
        const rootId = deps.uploads.ensureRootFor(accountRow.id);
        const bundle = deps.uploads.loadBundleFor(accountRow.id);
        if (!isS3Bundle(bundle)) throw new UploadError('account_needs_reauth', 409);
        const found = await adapter.findAppObjectByKey(bundle, rootId, attempt.object_key, undefined);
        if (!found) {
          // nothing landed remotely: an honest failure, and no cleanup
          // obligation because no object id was ever observed
          deps.uploads.recordFailure({
            jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey: attempt.object_key,
            safeCode: 'provider_object_missing', bytesReceived: 0, remoteObjectId: null,
          });
          throw new UploadError('provider_object_missing', 409);
        }
        if (found.sizeBytes !== allocation.size_bytes) {
          // a wrong-size object exists: it must be deleted, not committed —
          // recordFailure keeps it as a durable cleanup obligation (UL-3)
          deps.uploads.recordFailure({
            jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey: attempt.object_key,
            safeCode: 'chunk_size_mismatch', bytesReceived: found.sizeBytes, remoteObjectId: found.remoteObjectId,
          });
          throw new UploadError('chunk_size_mismatch', 400);
        }
        // sha256 is client-reported (the browser hashed its own slice); the
        // placement is recorded 'uploaded', never 'verified', and the download
        // engine re-verifies every stored digest when the file is streamed
        const result = deps.uploads.commitChunk({
          jobId, chunkIndex, accountId: allocation.provider_account_id, objectKey: attempt.object_key,
          remoteObjectId: found.remoteObjectId, sha256, sizeBytes: allocation.size_bytes,
          providerChecksumType: 'etag',
        });
        res.json({
          ok: true,
          chunkIndex,
          sha256,
          bytes: allocation.size_bytes,
          chunksCompleted: result.chunksCompleted,
          bytesCompleted: result.bytesCompleted,
          fileCompleted: result.fileCompleted,
        });
      } catch (err) {
        uploadErrorResponse(res, err);
      }
    },
  );

  // The client reports a direct PUT it could not finish, so the attempt stops
  // counting as in-flight and the per-account slot frees immediately.
  router.post(
    '/api/uploads/:jobId/chunks/:chunkIndex/fail',
    adminOnly,
    deps.csrf.doubleCsrfProtection,
    directLimiter,
    (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const jobId = String(req.params['jobId']);
      const chunkIndex = Number(String(req.params['chunkIndex']));
      const body = (req.body ?? {}) as { attemptId?: unknown; code?: unknown };
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !attemptId) {
        res.status(400).json({ error: 'invalid_upload_metadata', code: 'invalid_upload_metadata' });
        return;
      }
      try {
        if (!deps.uploads.getJob(jobId)) throw new UploadError('job_not_found', 404);
        const attempt = deps.uploads.getAttemptForChunk(jobId, chunkIndex, attemptId);
        if (!attempt) throw new UploadError('invalid_upload_metadata', 400);
        const reported = typeof body.code === 'string' ? body.code : '';
        deps.uploads.recordFailure({
          jobId, chunkIndex, accountId: attempt.provider_account_id, objectKey: attempt.object_key,
          safeCode: DIRECT_FAIL_CODES.has(reported) ? reported : 'upload_failed',
          bytesReceived: 0, remoteObjectId: null,
        });
        res.json({ ok: true });
      } catch (err) {
        uploadErrorResponse(res, err);
      }
    },
  );

  router.get('/api/dashboard/summary', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(deps.uploads.dashboardSummary());
  });

  router.get('/api/files', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const offset = Math.max(0, Number(req.query['offset'] ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
    const search = typeof req.query['search'] === 'string' ? req.query['search'].toLowerCase() : '';
    // FE-02: filtering happens in SQL before limit/offset, so a search sees
    // the entire library; `total` reflects the same filter. The page is
    // resolved with one batched placement query (no per-file N+1).
    const rows = deps.uploads.searchFiles(search, limit, offset);
    const shaped = deps.uploads.publicFiles(rows.map((f) => f.id));
    const files = rows.map((f) => shaped.get(f.id)!);
    res.json({ files, total: deps.uploads.countSearchedFiles(search) });
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
