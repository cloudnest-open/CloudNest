import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { makeDownloadQueries, type DownloadJobRow, type ChunkRow, type PlacementRow } from './download-queries.js';
import { makeProviderQueries } from '../db/provider-queries.js';
import { MemoryBudget, globalDownloadBudget } from './memory-budget.js';
import { chunksForRange, type ResolvedRange, type ChunkSlice } from './range.js';
import { SETTINGS_DEFAULTS, WORKER_LIMITS, type SettingsService } from '../settings/settings-service.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import type { CredentialsStore } from '../providers/credentials-store.js';

/**
 * Download and reconstruction (M10.a/b).
 *
 * Invariants:
 * - every chunk's bytes are verified (size + SHA-256) BEFORE any of its bytes
 *   reach the client;
 * - chunks stream in exact order with backpressure;
 * - a chunk that cannot be verified aborts the response rather than emitting
 *   unknown bytes, and the file is marked incomplete/needs_repair;
 * - a short range reads only the overlapping chunks, never the whole file.
 */

export class DownloadError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

export interface DownloadPrepared {
  jobId: string;
  fileId: string;
  fileName: string;
  mimeType: string | null;
  fileSizeBytes: number;
  manifestHash: string | null;
  range: ResolvedRange | null;
  slices: ChunkSlice[];
  chunksTotal: number;
}

/** One prefetched chunk read: verified bytes, its slice, and its reservation. */
interface VerifiedChunk {
  /** The full chunk bytes, verified against the stored size and SHA-256. */
  bytes: Buffer;
  /** The sub-slice of that chunk the client actually asked for. */
  meta: ChunkSlice;
  /** Returns this chunk's reservation to the shared budget. Idempotent. */
  release: () => void;
}

interface ReadHandle {
  /** The provider stream the read is pulling, so an abort can stop it promptly. */
  stream: NodeJS.ReadableStream | null;
}

interface PrefetchSlot {
  index: number;
  promise: Promise<VerifiedChunk>;
  handle: ReadHandle;
}

/** Stop a provider stream so an aborted or failed read cannot hold a connection. */
function destroyStream(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  const destroyable = stream as unknown as { destroy?: () => void };
  if (typeof destroyable.destroy === 'function') destroyable.destroy();
}

export class DownloadService {
  private readonly q;
  private readonly providerQ;
  /**
   * FE-07: one abort entry per live streaming job. cancelDownload() fires the
   * controller so the stream stops emitting and the job row already written
   * as 'cancelled' stays the truth (the loop then re-marks it consistently).
   */
  private readonly activeStreams = new Map<string, AbortController>();
  constructor(
    private readonly db: Database.Database,
    private readonly store: CredentialsStore,
    /** M12.a: only the typed getter is needed; read per stream, never cached. */
    private readonly settings: Pick<SettingsService, 'get'>,
    private readonly budget: MemoryBudget = globalDownloadBudget,
  ) {
    this.q = makeDownloadQueries(db);
    this.providerQ = makeProviderQueries(db);
  }

  /**
   * Effective prefetch depth for one stream (M12.a).
   *
   * Read at stream time, never cached in the constructor, so changing the setting
   * governs the next download without a restart. Clamped to the same 1..8 range
   * the settings validator enforces: this is the code that actually spends
   * memory, so a hand-edited or corrupt row must never widen the bound.
   */
  private downloadConcurrency(): number {
    let configured: unknown;
    try {
      configured = this.settings.get('download.concurrency');
    } catch {
      return SETTINGS_DEFAULTS['download.concurrency'];
    }
    const value = Number(configured);
    if (!Number.isInteger(value)) return SETTINGS_DEFAULTS['download.concurrency'];
    return Math.min(Math.max(value, 1), WORKER_LIMITS.hardCeiling);
  }

  getFile(fileId: string) {
    return this.q.getFile.get(fileId) as
      | { id: string; user_id: string; original_name: string; size_bytes: number; mime_type: string | null; chunk_size_bytes: number; chunk_count: number; manifest_hash: string | null; state: string }
      | undefined;
  }

  listChunks(fileId: string): ChunkRow[] {
    return this.q.listChunks.all(fileId) as unknown as ChunkRow[];
  }

  /**
   * Validate the file and create the download job. Metadata only: no provider
   * read happens here, so a HEAD request never touches a provider.
   */
  prepare(fileId: string, range: ResolvedRange | null, createJob: boolean): DownloadPrepared {
    const file = this.getFile(fileId);
    if (!file) throw new DownloadError('file_not_found', 404);
    if (file.state === 'deleting' || file.state === 'deletion_pending' || file.state === 'deleted') {
      throw new DownloadError('deletion_pending', 409);
    }
    if (file.chunk_count > 0 && file.state !== 'completed') {
      throw new DownloadError('file_not_complete', 409);
    }
    // A metadata-only request (createJob=false) describes the representation and
    // never touches provider content, so it must not require a verifiable chunk
    // manifest or live placements. It still reports the real file state.
    if (!createJob) {
      return {
        jobId: '',
        fileId: file.id,
        fileName: file.original_name,
        mimeType: file.mime_type,
        fileSizeBytes: file.size_bytes,
        manifestHash: file.manifest_hash,
        range: null,
        slices: [],
        chunksTotal: 0,
      };
    }

    const slices = range
      ? chunksForRange(range, file.chunk_size_bytes, file.size_bytes)
      : this.listChunks(file.id).map((c) => ({
          chunkIndex: c.chunk_index,
          chunkOffsetBytes: c.offset_bytes,
          chunkSizeBytes: c.size_bytes,
          sliceStartInChunk: 0,
          sliceLength: c.size_bytes,
        }));

    let jobId = '';
    if (createJob) {
      const now = new Date().toISOString();
      jobId = this.q.newId();
      this.q.insertDownloadJob.run({
        id: jobId,
        file_id: file.id,
        chunks_total: slices.length,
        range_start: range ? range.start : (file.size_bytes > 0 ? 0 : null),
        range_end: range ? range.end : (file.size_bytes > 0 ? file.size_bytes - 1 : null),
        requested_bytes: range ? range.length : file.size_bytes,
        created_at: now,
        updated_at: now,
      });
    }

    return {
      jobId,
      fileId: file.id,
      fileName: file.original_name,
      mimeType: file.mime_type,
      fileSizeBytes: file.size_bytes,
      manifestHash: file.manifest_hash,
      range,
      slices,
      chunksTotal: slices.length,
    };
  }

  /** True when the manifest still matches the chunks actually stored. */
  private manifestMatches(fileId: string): boolean {
    const file = this.getFile(fileId);
    if (!file?.manifest_hash) return true; // empty files carry no chunk manifest
    const chunks = this.listChunks(fileId);
    const canonical = chunks.map((c, i) => `${i}:${c.size_bytes}:${c.sha256 ?? ''}`).join('|');
    const expected = crypto.createHash('sha256').update(`v1|${canonical}`).digest('hex');
    return expected === file.manifest_hash;
  }

  /**
   * Read one chunk fully, verify size + hash, and return its bytes.
   * Memory is reserved from the global budget and always released.
   *
   * `fileId` is passed explicitly: the service is stateless with respect to the
   * current download, so two concurrent downloads can never resolve each
   * other's chunks.
   */
  private async readVerifiedChunk(fileId: string, slice: ChunkSlice, signal?: AbortSignal): Promise<Buffer> {
    const verified = await this.readVerifiedChunkHolding(fileId, slice, signal);
    try {
      return verified.bytes;
    } finally {
      verified.release();
    }
  }

  /**
   * Read and verify one chunk, KEEPING its memory reservation.
   *
   * The caller owns the returned `release` and must call it exactly once, from a
   * `finally`. Keeping the reservation alive is what makes the prefetch bound
   * meaningful: bytes that are read ahead still occupy the shared budget.
   */
  private async readVerifiedChunkHolding(
    fileId: string,
    slice: ChunkSlice,
    signal?: AbortSignal,
    handle?: ReadHandle,
  ): Promise<VerifiedChunk> {
    const resolved = this.activePlacement(slice.chunkIndex, fileId);
    if (!resolved) throw new DownloadError('chunk_missing', 409);
    const placements = resolved.placement;

    const release = await this.budget.acquire(slice.chunkSizeBytes);
    try {
      const account = this.providerQ.getAccount.get(placements.provider_account_id) as
        | { id: string; provider: string; status: string }
        | undefined;
      if (!account) throw new DownloadError('provider_needs_reauth', 409);
      const adapter = getAdapter(account.provider);
      if (!adapter?.downloadObjectStream) throw new DownloadError('provider_unavailable', 502);
      const bundle = this.loadBundle(account.id);
      const appConfig = account.provider === 'mega' || account.provider === 'pcloud'
        ? undefined
        : this.store.getConfig(account.provider)?.config ?? undefined;
      const remoteId = placements.remote_object_id;
      if (!remoteId) throw new DownloadError('chunk_missing', 409);

      const out = await adapter.downloadObjectStream(bundle, remoteId, appConfig);
      // expose the live stream so an abandoned read can be destroyed promptly
      if (handle) handle.stream = out.stream;
      const parts: Buffer[] = [];
      let received = 0;
      for await (const piece of out.stream) {
        if (signal?.aborted) throw new DownloadError('download_cancelled', 499);
        const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as unknown as Uint8Array);
        received += buf.length;
        if (received > slice.chunkSizeBytes) {
          throw new DownloadError('chunk_hash_mismatch', 502);
        }
        parts.push(buf);
      }
      const payload = Buffer.concat(parts);
      if (payload.length !== slice.chunkSizeBytes) {
        throw new DownloadError('chunk_hash_mismatch', 502);
      }
      // the ONLY authority on integrity is our own digest of the received bytes
      const digest = crypto.createHash('sha256').update(payload).digest('hex');
      if (digest !== resolved.chunk.sha256) {
        this.markChunkProblem(fileId, slice.chunkIndex);
        throw new DownloadError('chunk_hash_mismatch', 502);
      }
      return { bytes: payload, meta: slice, release };
    } catch (err) {
      // a failed read must not leak its reservation
      release();
      throw err;
    }
  }

  /** Resolve the active placement and its chunk for a slice. */
  private activePlacement(chunkIndex: number, fileId: string): { chunk: ChunkRow; placement: PlacementRow } | null {
    const chunk = this.q.getChunk.get(fileId, chunkIndex) as ChunkRow | undefined;
    if (!chunk) return null;
    const placements = this.q.activePlacements.all(chunk.id) as unknown as PlacementRow[];
    const placement = placements.find((p) => p.state === 'verified' || p.state === 'uploaded') ?? placements[0];
    if (!placement) return null;
    return { chunk, placement };
  }

  private markChunkProblem(fileId: string, chunkIndex: number): void {
    const chunk = this.q.getChunk.get(fileId, chunkIndex) as ChunkRow | undefined;
    if (!chunk) return;
    this.db.prepare("UPDATE file_chunks SET state = 'failed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), chunk.id);
    this.q.setFileState.run('needs_repair', fileId);
  }

  private loadBundle(accountId: string) {
    const row = this.providerQ.getAccount.get(accountId) as Parameters<CredentialsStore['loadAccountBundle']>[0] | undefined;
    if (!row) throw new DownloadError('provider_needs_reauth', 409);
    const bundle = this.store.loadAccountBundle(row);
    if (!bundle) throw new DownloadError('provider_needs_reauth', 409);
    return bundle;
  }

  /**
   * Stream the prepared download in order. Each chunk is verified before its
   * bytes are written; a failure after headers aborts the response.
   */
  /**
   * Integrity check for the stored manifest. Only meaningful when bytes are
   * actually being produced: a metadata-only request must never mutate state.
   */
  verifyManifest(fileId: string): boolean {
    return this.manifestMatches(fileId);
  }

  /**
   * Stream the prepared download in order, reading ahead with a BOUNDED
   * pipeline (M12.a `download.concurrency`).
   *
   * Contract, unchanged from the serial implementation:
   * - bytes are yielded strictly in order;
   * - each chunk is hash-verified BEFORE its bytes are yielded;
   * - a verification failure throws `chunk_hash_mismatch` and marks the file
   *   `needs_repair`;
   * - an abort throws `download_cancelled` promptly and stops the reads;
   * - progress comes from real completed chunks and never double counts.
   *
   * The bound matters because bytes read ahead still occupy the process-wide
   * verification-buffer budget: at most `concurrency` chunk reservations and at
   * most `concurrency` in-flight provider reads exist at any moment. A verified
   * chunk's reservation ends before the next read starts, so the ceiling is
   * exactly `concurrency` chunks — not concurrency+1. On failure, abort or an
   * early-stopping consumer, the in-flight reads are destroyed, awaited and
   * every reservation is returned in a `finally` — deterministically, with no
   * stranding.
   */
  async *stream(prepared: DownloadPrepared, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (!this.manifestMatches(prepared.fileId) && prepared.slices.length > 0) {
      this.q.setFileState.run('needs_repair', prepared.fileId);
      throw new DownloadError('chunk_hash_mismatch', 502);
    }

    // FE-07: register this live stream so cancelDownload() can abort it. The
    // external signal (client disconnect) and the registry controller are
    // linked: either one stops the loop.
    let registryController: AbortController | null = null;
    if (prepared.jobId) {
      registryController = new AbortController();
      this.activeStreams.set(prepared.jobId, registryController);
      signal?.addEventListener('abort', () => registryController?.abort(), { once: true });
    }
    const effectiveSignal = registryController?.signal ?? signal;

    const depth = Math.max(1, this.downloadConcurrency());
    const pending: Array<PrefetchSlot | null> = [];
    /** Reservations currently held by this stream but not yet released. */
    const held = new Set<() => void>();
    let inFlight = 0;
    /** Once true, no further read is started and the budget is being drained. */
    let finished = false;
    let nextToStart = 0;
    let chunksDone = 0;
    let bytesDone = 0;

    const releaseAll = (): void => {
      for (const release of held) release();
      held.clear();
    };

    /**
     * Abandon every read that has not been awaited yet: destroy its provider
     * stream, wait for it to settle, then return its reservation. A settled
     * read has either moved its release into `held` or released its own
     * reservation on failure — waiting makes the release deterministic instead
     * of leaving it to a racing task after the stream is already gone.
     */
    const abandonInFlight = async (): Promise<void> => {
      for (const slot of pending) {
        if (slot) destroyStream(slot.handle.stream);
      }
      const unsettled: Array<Promise<VerifiedChunk>> = [];
      for (const slot of pending) {
        if (slot) unsettled.push(slot.promise);
      }
      await Promise.allSettled(unsettled);
      releaseAll();
    };

    /** Start the next read unless the look-ahead window is already full. */
    const fill = (): void => {
      while (!finished && inFlight < depth && nextToStart < prepared.slices.length) {
        const index = nextToStart++;
        const slice = prepared.slices[index]!;
        const handle: ReadHandle = { stream: null };
        const slot: PrefetchSlot = {
          index,
          handle,
          promise: this.readVerifiedChunkHolding(prepared.fileId, slice, effectiveSignal, handle),
        };
        pending[index] = slot;
        inFlight++;
        slot.promise.then(
          (value) => {
            held.add(value.release);
          },
          () => {
            // the failure is surfaced when the slot is awaited; this handler only
            // prevents an unhandled rejection while the failure waits its turn
          },
        );
      }
    };

    try {
      fill();
      for (let index = 0; index < prepared.slices.length; index++) {
        if (effectiveSignal?.aborted) throw new DownloadError('download_cancelled', 499);
        const slot = pending[index]!;
        pending[index] = null;
        let chunk: VerifiedChunk;
        try {
          chunk = await slot.promise;
        } catch (err) {
          inFlight--;
          // a failed read must never start new ones
          throw err;
        }
        inFlight--;
        const slice = chunk.meta;
        // emit only the requested sub-slice of this chunk
        const sub = chunk.bytes.subarray(
          slice.sliceStartInChunk,
          slice.sliceStartInChunk + slice.sliceLength,
        );
        try {
          if (sub.length !== slice.sliceLength) throw new DownloadError('chunk_hash_mismatch', 502);
          chunksDone++;
          bytesDone += sub.length;
          this.q.updateJobProgress.run({
            id: prepared.jobId,
            chunks_completed: chunksDone,
            bytes_completed: bytesDone,
            last_safe_error_code: null,
            updated_at: new Date().toISOString(),
          });
        } finally {
          // verification is complete, so this chunk's reservation ends BEFORE
          // any further read is started: the window ceiling stays `depth`
          // chunks, and the delivered bytes belong to the consumer from here,
          // exactly as in the serial loop
          chunk.release();
          held.delete(chunk.release);
        }
        // keep the window full while there is still work to read
        if (index + 1 < prepared.slices.length) fill();
        yield sub;
      }
      finished = true;
      this.q.finishJob.run({
        id: prepared.jobId, state: 'completed', last_safe_error_code: null, updated_at: new Date().toISOString(),
      });
    } catch (err) {
      finished = true;
      await abandonInFlight();
      const code = err instanceof DownloadError
        ? err.safeCode
        : err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      // FE-07: an externally cancelled job already carries the truthful
      // cancelled row; the loop must not overwrite it with 'failed' when its
      // own late abort surfaces as a generic error.
      const current = this.q.getJob.get(prepared.jobId) as DownloadJobRow | undefined;
      const externallyCancelled = current?.state === 'cancelled' && current.last_safe_error_code === 'download_cancelled';
      if (!externallyCancelled) {
        this.q.finishJob.run({
          id: prepared.jobId,
          state: code === 'download_cancelled' ? 'cancelled' : 'failed',
          last_safe_error_code: code,
          updated_at: new Date().toISOString(),
        });
      }
      throw err;
    } finally {
      finished = true;
      if (prepared.jobId && registryController) {
        this.activeStreams.delete(prepared.jobId);
      }
      // a consumer that stops iterating early must not strand reservations
      await abandonInFlight();
    }
  }

  /** Progress for the Downloads UI, from persisted rows only. */
  publicDownloadJob(jobId: string): DownloadJobRow | null {
    const job = this.q.getJob.get(jobId) as DownloadJobRow | undefined;
    if (!job || job.job_type !== 'download') return null;
    return job;
  }

  listDownloadJobs(limit: number, offset: number, userId: string | null = null): DownloadJobRow[] {
    if (userId === null) return this.q.listDownloadJobs.all(limit, offset) as unknown as DownloadJobRow[];
    return this.q.listDownloadJobsForUser.all(userId, limit, offset) as unknown as DownloadJobRow[];
  }

  countDownloadJobs(userId: string | null = null): number {
    if (userId === null) return (this.q.countDownloadJobs.get() as { n: number }).n;
    return (this.q.countDownloadJobsForUser.get(userId) as { n: number }).n;
  }

  /**
   * Phase 3 ownership check: the users-table id that owns a download job's
   * file, or null when the job does not exist. Routes answer a foreign job
   * with the same 404 as a missing one.
   */
  downloadJobOwnerUserId(jobId: string): string | null {
    const row = this.q.getJobOwnerUserId.get(jobId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /** Cancel an active stream and mark the job truthfully. */
  cancelDownload(jobId: string): boolean {
    const job = this.q.getJob.get(jobId) as DownloadJobRow | undefined;
    if (!job || job.job_type !== 'download') throw new DownloadError('file_not_found', 404);
    if (job.state !== 'running') return false;
    // FE-07: abort the live stream BEFORE writing the row, so the loop's own
    // cancellation handling cannot overwrite the cancelled state afterwards.
    const live = this.activeStreams.get(jobId);
    if (live) {
      this.activeStreams.delete(jobId);
      live.abort();
    }
    this.q.finishJob.run({
      id: jobId, state: 'cancelled', last_safe_error_code: 'download_cancelled', updated_at: new Date().toISOString(),
    });
    return true;
  }

  /** Metadata-only rename: no remote object is touched. */
  renameFile(fileId: string, newName: string): { id: string; originalName: string } {
    const file = this.getFile(fileId);
    if (!file) throw new DownloadError('file_not_found', 404);
    this.q.renameFile.run(newName, fileId);
    return { id: fileId, originalName: newName };
  }

  /** Startup reconciliation: a running download is reported as interrupted. */
  recoverDownloadsOnStartup(): number {
    const running = this.q.runningDownloadJobs.all() as unknown as DownloadJobRow[];
    const now = new Date().toISOString();
    for (const job of running) {
      // a stream cannot survive a restart; report it truthfully rather than
      // claiming it completed
      this.q.finishJob.run({
        id: job.id, state: 'failed', last_safe_error_code: 'download_interrupted', updated_at: now,
      });
    }
    return running.length;
  }
}
