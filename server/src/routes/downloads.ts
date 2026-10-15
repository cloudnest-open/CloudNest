import { Router, type Request, type Response } from 'express';
import type { DownloadService } from '../downloads/download-service.js';
import { DownloadError } from '../downloads/download-service.js';
import { parseSingleRange, RangeError_, contentDisposition, safeContentType, etagForManifest } from '../downloads/range.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { sanitizeDisplayName, ChunkMathError } from '../uploads/chunk-math.js';

/**
 * Download routes (M10.c).
 *
 * Safety rules applied here:
 * - compression is bypassed so Content-Length/Range/ETag describe exact bytes;
 * - Cache-Control is private, no-store; nosniff is always set;
 * - the filename is stripped of control characters and sent both as a quoted
 *   ASCII fallback and an RFC 5987 UTF-8 form;
 * - only one Range spec is supported; malformed => 400, unsatisfiable => 416;
 * - If-Range that does not match the ETag makes the server ignore the Range.
 */

function errorResponse(res: Response, err: unknown, fileSizeBytes?: number): void {
  if (err instanceof DownloadError) {
    res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  if (err instanceof ChunkMathError) {
    res.status(400).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  if (err instanceof RangeError_) {
    // an unsatisfiable range must advertise the real file length; a malformed
    // request must NOT claim a satisfiable interval
    if (err.kind === 'unsatisfiable' && fileSizeBytes !== undefined) {
      res.set('Content-Range', `bytes */${fileSizeBytes}`);
    }
    res.status(err.status).json({ error: err.safeCode, code: err.safeCode });
    return;
  }
  res.status(500).json({ error: 'download_failed', code: 'download_failed' });
}

function setStreamingHeaders(res: Response, fileName: string, mimeType: string | null, etag: string): void {
  res.set('Content-Type', safeContentType(mimeType));
  res.set('Content-Disposition', contentDisposition(fileName));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, no-store');
  res.set('Accept-Ranges', 'bytes');
  res.set('ETag', etag);
}

export function downloadsRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  downloads: DownloadService;
  /** Task §5.B: account-aware availability for the file details response. */
  storageHealth: (fileId: string) => import('../uploads/upload-service.js').FileStorageHealth;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);

  /** Shared implementation for GET and HEAD on the download route. */
  async function handleDownload(req: Request, res: Response, headOnly: boolean): Promise<void> {
    const fileId = String(req.params['fileId']);
    try {
      const file = deps.downloads.getFile(fileId);
      if (!file) throw new DownloadError('file_not_found', 404);
      const etag = etagForManifest(file.manifest_hash);

      // conditional evaluation happens before Range handling
      const ifNoneMatch = req.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }

      // Range validation happens for GET only; a HEAD response describes the
      // full representation and ignores any Range (per RFC 9110).
      if (headOnly) {
        const prepared = deps.downloads.prepare(fileId, null, false);
        setStreamingHeaders(res, prepared.fileName, prepared.mimeType, etag);
        res.set('Content-Length', String(prepared.fileSizeBytes));
        res.status(200).end();
        return;
      }

      // If-Range must match, otherwise the Range is ignored
      const ifRange = req.headers['if-range'];
      const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      const rangeIgnored = typeof ifRange === 'string' && ifRange.trim() !== etag;
      let range = null;
      if (rangeHeader && !rangeIgnored) {
        range = parseSingleRange(rangeHeader, file.size_bytes);
      }
      if (rangeHeader && !rangeIgnored && range === null) {
        throw new RangeError_('malformed');
      }


      const prepared = deps.downloads.prepare(fileId, range, true);
      setStreamingHeaders(res, prepared.fileName, prepared.mimeType, etag);

      if (range) {
        res.status(206);
        res.set('Content-Range', `bytes ${range.start}-${range.end}/${prepared.fileSizeBytes}`);
        res.set('Content-Length', String(range.length));
      } else {
        res.status(200);
        res.set('Content-Length', String(prepared.fileSizeBytes));
      }

      const controller = new AbortController();
      req.on('aborted', () => controller.abort());
      req.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      try {
        for await (const chunk of deps.downloads.stream(prepared, controller.signal)) {
          if (controller.signal.aborted) break;
          if (!res.write(chunk)) {
            // respect backpressure: wait for the socket to drain
            await new Promise<void>((resolve) => res.once('drain', () => resolve()));
          }
        }
        if (!controller.signal.aborted) res.end();
        else res.destroy();
      } catch (streamErr) {
        // headers are already sent: destroy the response so the client sees a
        // truncated failure rather than a successful-looking corrupt file
        if (!res.headersSent) {
          errorResponse(res, streamErr);
        } else {
          res.destroy();
        }
      }
    } catch (err) {
      if (!res.headersSent) {
        const knownSize = (() => {
          try {
            return deps.downloads.getFile(fileId)?.size_bytes;
          } catch {
            return undefined;
          }
        })();
        errorResponse(res, err, knownSize);
      } else {
        res.destroy();
      }
    }
  }

  // HEAD is registered BEFORE GET: Express would otherwise serve a HEAD request
  // through the GET handler and start a real download.
  router.head('/api/files/:fileId/download', adminOnly, (req, res) => void handleDownload(req, res, true));
  router.get('/api/files/:fileId/download', adminOnly, (req, res) => void handleDownload(req, res, false));

  router.get('/api/files/:fileId', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const file = deps.downloads.getFile(String(req.params['fileId']));
    if (!file) {
      res.status(404).json({ error: 'file_not_found', code: 'file_not_found' });
      return;
    }
    const chunks = deps.downloads.listChunks(file.id);
    // availability is derived from real placements, never from a stored flag alone
    res.json({
      file: {
        id: file.id,
        originalName: file.original_name,
        sizeBytes: file.size_bytes,
        mimeType: file.mime_type,
        chunkCount: file.chunk_count,
        chunkSizeBytes: file.chunk_size_bytes,
        state: file.state,
        manifestHash: file.manifest_hash,
        chunksPresent: chunks.length,
        // task §5.B: which accounts currently make this file not fully usable
        storageHealth: deps.storageHealth(file.id),
      },
    });
  });

  router.post('/api/files/:fileId/rename', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { name?: unknown };
    try {
      const name = sanitizeDisplayName(body.name);
      const result = deps.downloads.renameFile(String(req.params['fileId']), name);
      res.json({ ok: true, file: result });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  router.get('/api/downloads', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const offset = Math.max(0, Number(req.query['offset'] ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
    const jobs = deps.downloads.listDownloadJobs(limit, offset).map((job) => ({
      jobId: job.id,
      fileId: job.file_id,
      state: job.state,
      requestedBytes: job.requested_bytes,
      rangeStart: job.requested_range_start_bytes,
      rangeEnd: job.requested_range_end_bytes,
      chunksCompleted: job.chunks_completed,
      chunksTotal: job.chunks_total,
      bytesCompleted: job.bytes_completed,
      safeErrorCode: job.last_safe_error_code,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    }));
    res.json({ downloads: jobs, total: deps.downloads.countDownloadJobs() });
  });

  router.get('/api/downloads/:jobId', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const job = deps.downloads.publicDownloadJob(String(req.params['jobId']));
    if (!job) {
      res.status(404).json({ error: 'file_not_found', code: 'file_not_found' });
      return;
    }
    res.json({
      download: {
        jobId: job.id,
        fileId: job.file_id,
        state: job.state,
        requestedBytes: job.requested_bytes,
        rangeStart: job.requested_range_start_bytes,
        rangeEnd: job.requested_range_end_bytes,
        chunksCompleted: job.chunks_completed,
        chunksTotal: job.chunks_total,
        bytesCompleted: job.bytes_completed,
        safeErrorCode: job.last_safe_error_code,
      },
    });
  });

  router.post('/api/downloads/:jobId/cancel', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const cancelled = deps.downloads.cancelDownload(String(req.params['jobId']));
      res.json({ ok: true, cancelled });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  return router;
}
