import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { makeDownloadQueries, type DownloadJobRow, type ChunkRow, type PlacementRow } from './download-queries.js';
import { makeProviderQueries } from '../db/provider-queries.js';
import { MemoryBudget, globalDownloadBudget } from './memory-budget.js';
import { chunksForRange, type ResolvedRange, type ChunkSlice } from './range.js';
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

export class DownloadService {
  private readonly q;
  private readonly providerQ;
  constructor(
    private readonly db: Database.Database,
    private readonly store: CredentialsStore,
    private readonly budget: MemoryBudget = globalDownloadBudget,
  ) {
    this.q = makeDownloadQueries(db);
    this.providerQ = makeProviderQueries(db);
  }

  getFile(fileId: string) {
    return this.q.getFile.get(fileId) as
      | { id: string; original_name: string; size_bytes: number; mime_type: string | null; chunk_size_bytes: number; chunk_count: number; manifest_hash: string | null; state: string }
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
      return payload;
    } finally {
      release();
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

  async *stream(prepared: DownloadPrepared, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (!this.manifestMatches(prepared.fileId) && prepared.slices.length > 0) {
      this.q.setFileState.run('needs_repair', prepared.fileId);
      throw new DownloadError('chunk_hash_mismatch', 502);
    }
    let chunksDone = 0;
    let bytesDone = 0;
    try {
      for (const slice of prepared.slices) {
        if (signal?.aborted) throw new DownloadError('download_cancelled', 499);
        const full = await this.readVerifiedChunk(prepared.fileId, slice, signal);
        // emit only the requested sub-slice of this chunk
        const sub = full.subarray(slice.sliceStartInChunk, slice.sliceStartInChunk + slice.sliceLength);
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
        yield sub;
      }
      this.q.finishJob.run({
        id: prepared.jobId, state: 'completed', last_safe_error_code: null, updated_at: new Date().toISOString(),
      });
    } catch (err) {
      const code = err instanceof DownloadError
        ? err.safeCode
        : err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      this.q.finishJob.run({
        id: prepared.jobId,
        state: code === 'download_cancelled' ? 'cancelled' : 'failed',
        last_safe_error_code: code,
        updated_at: new Date().toISOString(),
      });
      throw err;
    }
  }

  /** Progress for the Downloads UI, from persisted rows only. */
  publicDownloadJob(jobId: string): DownloadJobRow | null {
    const job = this.q.getJob.get(jobId) as DownloadJobRow | undefined;
    if (!job || job.job_type !== 'download') return null;
    return job;
  }

  listDownloadJobs(limit: number, offset: number): DownloadJobRow[] {
    return this.q.listDownloadJobs.all(limit, offset) as unknown as DownloadJobRow[];
  }

  countDownloadJobs(): number {
    return (this.q.countDownloadJobs.get() as { n: number }).n;
  }

  /** Cancel an active stream and mark the job truthfully. */
  cancelDownload(jobId: string): boolean {
    const job = this.q.getJob.get(jobId) as DownloadJobRow | undefined;
    if (!job || job.job_type !== 'download') throw new DownloadError('file_not_found', 404);
    if (job.state !== 'running') return false;
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
