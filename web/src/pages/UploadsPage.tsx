import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload, Pause, Play, RotateCcw, X } from 'lucide-react';
import { api } from '../api.js';
import { formatBytes, formatDateTime } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Uploads (Step 4 / M9.e).
 *
 * Honesty rules enforced here:
 * - progress comes only from the server's durable job state, never from a
 *   locally incremented counter;
 * - capacity preflight and the estimated remote-object count are shown BEFORE
 *   the owner confirms, with a warning when smaller chunks would create a huge
 *   number of cloud objects;
 * - on resume the UI states plainly that bytes which were never uploaded have
 *   no earlier digest to compare against (a documented V1 limitation).
 *
 * All copy resolves through the app-wide i18n context; the server's safe error
 * codes map to localized remedies (t.errors.upload) with the raw code kept as
 * a diagnostic.
 */

const CHUNK_SIZES = [8, 16, 32, 64] as const;
const DEFAULT_CHUNK_MIB = 64;
/**
 * Fallback global in-flight chunk requests. FE-05/ST-01: the real bound is the
 * admin's `upload.workerLimit` setting, served with every uploads list and
 * clamped client-side; this constant only covers a request that failed.
 */
const DEFAULT_GLOBAL_WORKERS = 4;
/** At most two chunks in flight per provider account (server-enforced: a third PUT answers 429 account_busy). */
const MAX_PER_ACCOUNT_WORKERS = 2;
const OBJECT_COUNT_WARN_THRESHOLD = 1000;
/**
 * §9: transient chunk failures get bounded exponential backoff with jitter,
 * honouring the server's Retry-After. Permanent errors (auth, quota, size
 * mismatch) stop immediately — the safe code tells the owner what to fix.
 */
const MAX_CHUNK_ATTEMPTS = 5;
const TRANSIENT_UPLOAD_CODES = new Set(['provider_rate_limited', 'account_busy', 'provider_unavailable', 'upload_failed']);

/** The server's §7.1 detail for a refused plan. */
interface CapacityDetail {
  totalUsableBytes: number | null;
  shortfallBytes: number;
  accounts: Array<{ label: string; reasonCode: string | null; usableBytes: number | null }>;
  suggestedChunkSizeMiB: number | null;
}

interface JobView {
  jobId: string;
  fileId: string | null;
  originalName: string | null;
  state: string;
  chunksCompleted: number;
  chunksTotal: number;
  bytesCompleted: number;
  sizeBytes: number;
  retryCount: number;
  safeErrorCode: string | null;
  resumable: boolean;
  cancellable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChunkPlanEntry {
  chunkIndex: number;
  offsetBytes: number;
  sizeBytes: number;
}

interface DashboardSummary {
  accounts: Array<{ id: string; provider: string; displayLabel: string; status: string; quotaStatus: string }>;
  activeJobs: number;
  recentFiles: number;
  totalFiles: number;
}

export function UploadsPage() {
  const { t, tf, plural } = useI18n();
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [selected, setSelected] = useState<File | null>(null);
  const [chunkMiB, setChunkMiB] = useState<number>(DEFAULT_CHUNK_MIB);
  // roadmap Phase 1: the storage tier picks the pool (personal OAuth vs business S3)
  const [tier, setTier] = useState<'personal' | 'business'>('personal');
  const [plannedChunks, setPlannedChunks] = useState<ChunkPlanEntry[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  /** FE-01: the job picked from Recent uploads for a restart resume. */
  const [resumeTarget, setResumeTarget] = useState<JobView | null>(null);
  /** FE-05: the effective concurrent-chunk limit served by the server. */
  const [workerLimit, setWorkerLimit] = useState<number>(DEFAULT_GLOBAL_WORKERS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [verifiedChunks, setVerifiedChunks] = useState<number | null>(null);
  const [resumeReport, setResumeReport] = useState<string | null>(null);
  /** §7.1(5): the server's largest feasible smaller chunk size after a refusal. */
  const [suggestedChunkMiB, setSuggestedChunkMiB] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  // Drag-and-drop surface (design pack §9): the hidden input still carries the
  // real file; the dropzone button and drop events both feed it.
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** The localized remedy for a server safe code; the raw code stays visible. */
  function describeError(data: unknown, fallback: string): { code: string; text: string } {
    const body = (data ?? {}) as { error?: string; code?: string };
    const code = body.code ?? body.error ?? '';
    const help = (t.errors.upload as Record<string, string | undefined>)[code];
    return { code, text: help ? `${help}${code ? ` (${code})` : ''}` : fallback };
  }

  const loadSummary = useCallback(async () => {
    // FE-04: an unreachable server is reported, not hidden behind stale zeros
    try {
      const [summary, list] = await Promise.all([api.dashboardSummary(), api.listUploads()]);
      if (summary.status === 200) setDashboard(summary.data as DashboardSummary);
      if (list.status === 200) {
        const data = list.data as { jobs: JobView[]; workerLimit?: number };
        setJobs(data.jobs ?? []);
        // the admin's configured bound wins over any client default
        if (typeof data.workerLimit === 'number' && data.workerLimit >= 1) {
          setWorkerLimit(Math.min(Math.floor(data.workerLimit), 8));
        }
      }
      if (summary.status !== 200 && list.status !== 200) {
        setError(t.uploads.errorLoad);
      }
    } catch {
      setError(t.common.errorNetwork);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user-driven; a language change must not re-fetch
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const chunkSizeBytes = chunkMiB * 1024 * 1024;
  const estimatedObjects = selected ? Math.ceil(selected.size / chunkSizeBytes) : 0;
  const shortFinalChunk = selected ? selected.size % chunkSizeBytes : 0;

  /** Metadata-only plan; no file bytes are sent in this step. */
  async function createPlan(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setNotice(null);
    setResumeReport(null);
    setSuggestedChunkMiB(null);
    setResumeTarget(null);
    try {
      const res = await api.planUpload(
        {
          originalName: selected.name,
          sizeBytes: selected.size,
          chunkSizeMiB: chunkMiB,
          mimeType: selected.type || null,
          tier,
        },
        crypto.randomUUID(),
      );
      if (res.status === 201 || res.status === 200) {
        const data = res.data as { jobId: string; chunkCount: number; allocations: ChunkPlanEntry[] };
        setJobId(data.jobId);
        setPlannedChunks(data.allocations);
        setNotice(
          data.chunkCount === 0
            ? t.uploads.emptyFile
            : plural(t.uploads.reserved, data.chunkCount),
        );
      } else {
        const described = describeError(res.data, t.uploads.planFailed);
        // §7.1(7): the refusal explains itself — exact shortfall and, on pure
        // placement fragmentation, a one-click feasible smaller chunk size.
        if (described.code === 'capacity_insufficient') {
          const detail = (res.data as CapacityDetail | null) ?? null;
          if (detail && detail.shortfallBytes > 0) {
            setError(`${described.text} ${tf(t.uploads.capacityShortfall, { bytes: formatBytes(detail.shortfallBytes) })}`);
          } else {
            setError(described.text);
          }
          if (detail?.suggestedChunkSizeMiB) {
            setSuggestedChunkMiB(detail.suggestedChunkSizeMiB);
          }
        } else {
          setError(described.text);
        }
        setErrorCode(described.code || null);
      }
    } finally {
      setBusy(false);
    }
  }

  /** §7.1(5): apply the suggested size for THIS upload only — nothing is persisted. */
  function applySuggestedChunk(): void {
    if (!suggestedChunkMiB || !selected) return;
    setChunkMiB(suggestedChunkMiB);
    setSuggestedChunkMiB(null);
    void createPlan();
  }

  /** Real progress straight from the durable job row. */
  async function refreshJob(id: string): Promise<JobView | null> {
    const res = await api.getUploadJob(id);
    if (res.status !== 200) return null;
    const job = (res.data as { job: JobView }).job;
    setJobs((prev) => {
      const next = prev.filter((j) => j.jobId !== job.jobId);
      return [job, ...next];
    });
    return job;
  }

  /**
   * Upload the remaining chunks with bounded concurrency.
   * `onlyIndices` restricts work to the chunks the server reported as missing.
   */
  async function runUpload(id: string, onlyIndices?: number[]): Promise<void> {
    if (!selected) {
      setError(t.uploads.selectOriginal);
      return;
    }
    if (runningRef.current) return;
    runningRef.current = true;
    pauseRequestedRef.current = false;
    setUploading(true);
    setError(null);
    setErrorCode(null);
    setResumeReport(null);
    abortRef.current = new AbortController();

    try {
      // the plan is authoritative: never trust a client-side chunk list
      const job = await refreshJob(id);
      if (!job) {
        setError(t.uploads.jobGone);
        return;
      }
      if (!job.fileId) {
        setError(t.uploads.jobGone);
        return;
      }
      const fileRes = await api.fileDetails(job.fileId);
      if (fileRes.status !== 200) {
        setError(t.uploads.manifestFailed);
        return;
      }
      const persistedChunkSizeBytes = (fileRes.data as { file: { chunkSizeBytes: number } }).file.chunkSizeBytes;
      if (!Number.isSafeInteger(persistedChunkSizeBytes) || persistedChunkSizeBytes <= 0) {
        setError(t.uploads.manifestFailed);
        return;
      }
      // FE-03: the job's PERSISTED geometry drives every slice, never the
      // current chunk-size select — after a restart that select may differ
      // from the plan this job was created with.
      const geometry = new Map<number, { offsetBytes: number; sizeBytes: number }>();
      const done = new Set<number>();
      for (let off = 0; ; off += 500) {
        const page = await api.resumeManifest(id, off, 500);
        if (page.status !== 200) {
          setError(t.uploads.manifestFailed);
          return;
        }
        const pageChunks = (page.data as { chunks: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }> }).chunks ?? [];
        for (const c of pageChunks) {
          done.add(c.chunkIndex);
          geometry.set(c.chunkIndex, { offsetBytes: c.offsetBytes, sizeBytes: c.sizeBytes });
        }
        if (pageChunks.length < 500) break;
      }
      const indices = onlyIndices ?? Array.from({ length: job.chunksTotal }, (_, index) => index).filter((index) => !done.has(index));
      const fallbackGeometry = (index: number): { offsetBytes: number; sizeBytes: number } => {
        const offset = index * persistedChunkSizeBytes;
        return { offsetBytes: offset, sizeBytes: Math.min(persistedChunkSizeBytes, Math.max(0, selected.size - offset)) };
      };

      let cursor = 0;
      const workerCount = Math.min(workerLimit, Math.max(1, indices.length));
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < indices.length) {
          if (abortRef.current?.signal.aborted || pauseRequestedRef.current) return;
          const chunkIndex = indices[cursor++] as number;
          // the server enforces the per-account in-flight cap: a third
          // concurrent PUT on one account answers 429 `account_busy` with
          // Retry-After, and this loop backs off and re-PUTs the same chunk
          const geo = geometry.get(chunkIndex) ?? fallbackGeometry(chunkIndex);
          if (geo.sizeBytes <= 0 || geo.offsetBytes >= selected.size) continue;
          const slice = selected.slice(geo.offsetBytes, geo.offsetBytes + geo.sizeBytes);
          // §9: bounded exponential backoff with jitter for transient errors;
          // permanent errors break out immediately with their safe code
          let res = await api.uploadChunkRaw(id, chunkIndex, slice);
          for (let attempt = 1; res.status !== 200 && attempt < MAX_CHUNK_ATTEMPTS && !pauseRequestedRef.current; attempt++) {
            const code = ((res.data ?? {}) as { code?: string }).code ?? '';
            if (code === 'job_paused') return;
            const transient = res.status === 429 || res.status >= 500 || TRANSIENT_UPLOAD_CODES.has(code);
            if (!transient || abortRef.current?.signal.aborted) break;
            const delayMs = res.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (abortRef.current?.signal.aborted || pauseRequestedRef.current) return;
            res = await api.uploadChunkRaw(id, chunkIndex, slice);
          }
          if (res.status !== 200) {
            const code = ((res.data ?? {}) as { code?: string }).code ?? '';
            if (code === 'job_paused' || pauseRequestedRef.current) return;
            const described = describeError(res.data, t.uploads.chunkFailed);
            setError(described.text);
            setErrorCode(described.code || null);
            return;
          }
          await refreshJob(id);
        }
      });
      await Promise.all(workers);
      const finalJob = await refreshJob(id);
      if (finalJob?.state === 'completed') {
        setNotice(tf(t.uploads.complete, {
          name: finalJob.originalName ?? t.fileTypes.file,
          size: formatBytes(finalJob.sizeBytes),
        }));
        setPlannedChunks(null);
        setJobId(null);
        setSelected(null);
        setResumeTarget(null);
      }
      await loadSummary();
    } finally {
      runningRef.current = false;
      pauseRequestedRef.current = false;
      setUploading(false);
      abortRef.current = null;
    }
  }

  /**
   * Resume after a browser restart: re-read only the chunks that already
   * completed, comparing each source slice with its stored digest.
   * FE-01: the job is picked from Recent uploads (resumeTarget), so the flow
   * survives a restart where no plan was created in this session.
   * FE-03: the manifest is paged fully (the server caps one page at 500).
   */
  async function prepareResume(target: JobView | null = resumeTarget): Promise<void> {
    if (!target || !selected) {
      setError(t.uploads.resumeHint);
      return;
    }
    const targetId = target.jobId;
    if (selected.size !== target.sizeBytes) {
      setErrorCode('source_changed');
      setError(`${t.errors.upload.source_changed} (source_changed)`);
      return;
    }
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setResumeReport(null);
    try {
      // Stop dispatching before reading the final manifest. Requests already
      // claimed by the server may finish and will appear in that manifest.
      if (target.state === 'running') {
        const pauseRes = await api.pauseUpload(targetId);
        if (pauseRes.status !== 200) {
          const described = describeError(pauseRes.data, t.uploads.pauseFailed);
          setError(described.text);
          setErrorCode(described.code || null);
          return;
        }
        await refreshJob(targetId);
      }
      // page through the whole manifest; the server caps one page at 500
      const chunks: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number; sha256: string }> = [];
      for (let off = 0; ; off += 500) {
        const page = await api.resumeManifest(targetId, off, 500);
        if (page.status !== 200) {
          setError(t.uploads.resumeInfoFailed);
          return;
        }
        const pageChunks = (page.data as { chunks: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number; sha256: string }> }).chunks ?? [];
        chunks.push(...pageChunks);
        if (pageChunks.length < 500) break;
      }
      // verify only completed slices; other bytes were never read, so they have
      // no earlier digest and cannot be compared (documented V1 limitation)
      const mismatched: number[] = [];
      for (const chunk of chunks) {
        const slice = selected.slice(chunk.offsetBytes, chunk.offsetBytes + chunk.sizeBytes);
        const digest = await sha256Hex(await slice.arrayBuffer());
        if (digest !== chunk.sha256) mismatched.push(chunk.chunkIndex);
      }
      if (mismatched.length > 0) {
        setErrorCode('source_changed');
        setError(`${t.errors.upload.source_changed} (source_changed)`);
        return;
      }
      const done = new Set(chunks.map((c) => c.chunkIndex));
      const jobRes = await api.getUploadJob(targetId);
      const total = jobRes.status === 200 ? (jobRes.data as { job: JobView }).job.chunksTotal : 0;
      const missing: number[] = [];
      for (let i = 0; i < total; i++) if (!done.has(i)) missing.push(i);
      setVerifiedChunks(chunks.length);
      setResumeReport(
        `${plural(t.uploads.resumeReportVerified, chunks.length)}; ${plural(t.uploads.resumeReportMissing, missing.length)}. ` +
          t.uploads.resumeReportNote,
      );
      const resumeRes = await api.resumeUpload(targetId);
      if (resumeRes.status !== 200) {
        const described = describeError(resumeRes.data, t.uploads.resumeFailed);
        setError(described.text);
        setErrorCode(described.code || null);
        return;
      }
      setJobId(targetId);
      await runUpload(targetId, missing);
    } finally {
      setBusy(false);
    }
  }

  async function pause(id: string): Promise<void> {
    const isLocalRun = runningRef.current && id === jobId;
    setBusy(true);
    try {
      const res = await api.pauseUpload(id);
      if (res.status === 200) {
        if (isLocalRun) pauseRequestedRef.current = true;
        await refreshJob(id);
        setNotice(t.uploads.pauseNotice);
      } else {
        const described = describeError(res.data, t.uploads.pauseFailed);
        setError(described.text);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!jobId) return;
    if (!window.confirm(t.uploads.cancelConfirm)) return;
    abortRef.current?.abort();
    setBusy(true);
    try {
      const res = await api.cancelUpload(jobId);
      if (res.status === 200) {
        const job = (res.data as { job: JobView | null }).job;
        if (job?.state === 'deletion_pending') {
          setNotice(t.uploads.cancelledCleanup);
        } else {
          setNotice(t.uploads.cancelled);
        }
        await refreshJob(jobId);
        await loadSummary();
      } else {
        const described = describeError(res.data, t.uploads.cancelFailed);
        setError(described.text);
      }
    } finally {
      setBusy(false);
    }
  }

  function chooseResumeSource(job: JobView): void {
    setResumeTarget(job);
    setSelected(null);
    setPlannedChunks(null);
    setJobId(job.jobId);
    setVerifiedChunks(null);
    setResumeReport(null);
    setNotice(null);
    setError(null);
    setErrorCode(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    fileInputRef.current?.click();
  }

  const currentJob = jobId ? jobs.find((j) => j.jobId === jobId) ?? null : null;
  const percent =
    currentJob && currentJob.sizeBytes > 0
      ? Math.min(100, Math.round((currentJob.bytesCompleted / currentJob.sizeBytes) * 100))
      : 0;

  const jobStateLabel = (state: string): string =>
    (t.states.job as Record<string, string | undefined>)[state] ?? state;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t.uploads.title}</h1>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && (
        <div className="card error-card" role="alert">
          <p>{error}</p>
          {errorCode && <p className="muted small">{tf(t.uploads.codeLabel, { code: errorCode })}</p>}
          {suggestedChunkMiB && (
            <button type="button" className="btn-secondary btn-compact" disabled={busy} onClick={applySuggestedChunk}>
              {tf(t.uploads.applySuggestion, { mib: suggestedChunkMiB })}
            </button>
          )}
        </div>
      )}

      <section className="card upload-composer">
        <h2>{t.uploads.selectFile}</h2>
        <p className="muted">{t.uploads.privacy}</p>
        <div className="upload-form">
          <input
            ref={fileInputRef}
            id="upload-file"
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0] ?? null;
              e.currentTarget.value = '';
              setSelected(file);
              setPlannedChunks(null);
              setJobId(resumeTarget?.jobId ?? null);
              setNotice(null);
              setResumeReport(null);
            }}
          />
          <button
            type="button"
            className={`dropzone${dragOver ? ' dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (!file) return;
              setSelected(file);
              setPlannedChunks(null);
              setJobId(resumeTarget?.jobId ?? null);
              setNotice(null);
              setResumeReport(null);
            }}
          >
            <CloudUpload className="dropzone-icon" size={28} strokeWidth={1.6} aria-hidden="true" />
            <strong>{t.uploads.dropzone}</strong>
            <span className="muted">{t.uploads.dropzoneOr}</span>
          </button>
          {selected ? (
            <p className="dropzone-hint">
              <strong>{selected.name}</strong> — {formatBytes(selected.size)}{' '}
              <button
                type="button"
                className="btn-inline"
                disabled={uploading}
                onClick={() => { setSelected(null); setPlannedChunks(null); setJobId(null); setResumeTarget(null); setResumeReport(null); }}
              >
                <X size={13} aria-hidden="true" />
                {t.common.remove}
              </button>
            </p>
          ) : (
            <p className="muted small dropzone-hint">{t.uploads.keepHint}</p>
          )}
          <label htmlFor="upload-tier">{t.uploads.tierLabel}</label>
          <select
            id="upload-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as 'personal' | 'business')}
            disabled={Boolean(plannedChunks) || Boolean(resumeTarget) || uploading}
          >
            <option value="personal">{t.uploads.tierPersonal}</option>
            <option value="business">{t.uploads.tierBusiness}</option>
          </select>
          <label htmlFor="upload-chunk-size">{t.uploads.maxChunkSize}</label>
          <select
            id="upload-chunk-size"
            value={chunkMiB}
            onChange={(e) => setChunkMiB(Number(e.target.value))}
            disabled={Boolean(plannedChunks) || Boolean(resumeTarget) || uploading}
          >
            {CHUNK_SIZES.map((size) => (
              <option key={size} value={size}>{size} MiB</option>
            ))}
          </select>
          <p className="muted small upload-chunk-note">{t.uploads.tierNote}</p>
          <p className="muted small upload-chunk-note">{t.uploads.maxChunkNote}</p>
        </div>

        {selected && !resumeTarget && (
          <div className="plan-preview">
            <p className="muted small">
              {t.uploads.planPreview.objects} <strong>{estimatedObjects}</strong>
              {shortFinalChunk > 0 ? ` ${t.uploads.planPreview.shortFinal}` : ''}
            </p>
            {estimatedObjects > OBJECT_COUNT_WARN_THRESHOLD && (
              <p className="form-error" role="alert">
                {tf(t.uploads.planPreview.warning, { count: estimatedObjects })}
              </p>
            )}
          </div>
        )}

        {resumeTarget && <p className="muted small">{t.uploads.resumeHint}</p>}
        <div className="actions">
          {resumeTarget ? (
            <>
              <button type="button" className="btn-primary" disabled={!selected || busy || uploading} onClick={() => void prepareResume()}>
                {busy ? t.common.working : t.uploads.resumeRestart}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || uploading}
                onClick={() => { setResumeTarget(null); setJobId(null); setResumeReport(null); setVerifiedChunks(null); }}
              >
                {t.common.cancel}
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" disabled={!selected || busy || uploading} onClick={() => void createPlan()}>
              {busy ? t.common.working : t.uploads.plan}
            </button>
          )}
        </div>
        {verifiedChunks !== null && (
          <p className="muted small">{tf(t.uploads.verifiedCount, { count: verifiedChunks })}</p>
        )}
        {resumeReport && <p className="muted small">{resumeReport}</p>}
      </section>

      {plannedChunks && (
        <section className="card">
          <h2>{t.uploads.ready}</h2>
          <p className="muted">
            {plural(t.uploads.readyDetail, plannedChunks.length, {
              workers: workerLimit,
              perAccount: MAX_PER_ACCOUNT_WORKERS,
            })}
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn-primary"
              disabled={uploading || busy || !jobId}
              onClick={() => jobId && void runUpload(jobId)}
            >
              {uploading ? t.uploads.uploading : t.uploads.start}
            </button>
          </div>
        </section>
      )}

      {currentJob && (
        <section className="card">
          <div className="page-head">
            <h2>{t.uploads.current}</h2>
            <span className={`state state-${currentJob.state === 'completed' ? 'ok' : currentJob.state === 'failed' || currentJob.state === 'deletion_pending' ? 'bad' : 'warn'}`}>
              {jobStateLabel(currentJob.state)}
            </span>
          </div>
          <p className="muted small">
            {tf(t.uploads.progressDetail, {
              name: currentJob.originalName ?? t.fileTypes.file,
              done: currentJob.chunksCompleted,
              total: currentJob.chunksTotal,
              bytes: formatBytes(currentJob.bytesCompleted),
              size: formatBytes(currentJob.sizeBytes),
            })}
          </p>
          <div className="upload-progress-summary">
            <span className="muted small">{t.uploads.progressFromServer}</span>
            <strong>{percent}%</strong>
          </div>
          <div className="progress-track" role="progressbar" aria-label={t.uploads.progressFromServer} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          {currentJob.safeErrorCode && (
            <p className="form-error">
              {((t.errors.upload as Record<string, string | undefined>)[currentJob.safeErrorCode] ?? t.errors.upload.fallback)}
              {' '}({currentJob.safeErrorCode})
            </p>
          )}
          {!resumeTarget && <div className="actions">
            {currentJob.state === 'running' && (
              <button type="button" className="btn-secondary btn-compact" disabled={busy} onClick={() => void pause(currentJob.jobId)}>
                <Pause size={14} aria-hidden="true" />{t.uploads.pause}
              </button>
            )}
            {(currentJob.state === 'paused' || currentJob.state === 'failed') && (
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={!selected || busy || uploading}
                onClick={() => void prepareResume(currentJob)}
              >
                {currentJob.state === 'paused' ? <Play size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                {currentJob.state === 'paused' ? t.uploads.resume : t.uploads.retry}
              </button>
            )}
            {currentJob.cancellable && currentJob.state !== 'deletion_pending' && (
              <button type="button" className="btn-danger btn-compact" disabled={busy} onClick={() => void cancel()}>
                <X size={14} aria-hidden="true" />{t.uploads.cancel}
              </button>
            )}
          </div>}
        </section>
      )}

      <section className="card">
        <h2>{t.uploads.recent}</h2>
        {jobs.length === 0 ? (
          <p className="muted">{t.uploads.none}</p>
        ) : (
          <div className="table-scroll-container">
          <table className="accounts-table uploads-jobs-table">
            <thead>
              <tr>
                <th>{t.uploads.file}</th>
                <th>{t.uploads.size}</th>
                <th>{t.uploads.chunks}</th>
                <th>{t.uploads.state}</th>
                <th>{t.uploads.updated}</th>
                <th>{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId}>
                  <td className="uploads-job-name" title={job.originalName ?? '—'}>{job.originalName ?? '—'}</td>
                  <td>{formatBytes(job.sizeBytes)}</td>
                  <td>{job.chunksCompleted} / {job.chunksTotal}</td>
                  <td><span className={`state state-${job.state === 'completed' ? 'ok' : job.state === 'failed' || job.state === 'deletion_pending' ? 'bad' : 'warn'}`}>{jobStateLabel(job.state)}</span></td>
                  <td className="muted small">{formatDateTime(job.updatedAt)}</td>
                  <td className="actions upload-job-actions">
                    {job.state === 'running' && !(job.jobId === jobId && uploading) ? (
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => void pause(job.jobId)}>{t.uploads.pause}</button>
                    ) : job.state !== 'running' && job.resumable && job.state !== 'deletion_pending' ? (
                      <button type="button" className="btn-secondary" title={t.uploads.resumeHint} disabled={busy || uploading} onClick={() => chooseResumeSource(job)}>{t.uploads.resume}</button>
                    ) : <span className="muted small">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t.uploads.overview}</h2>
        {dashboard ? (
          <>
            <p className="muted small">
              {[
                plural(t.uploads.overviewAccounts, dashboard.accounts.length),
                plural(t.uploads.overviewJobs, dashboard.activeJobs),
                plural(t.uploads.overviewFiles, dashboard.totalFiles),
              ].join(' · ')}
            </p>
            {dashboard.accounts.length === 0 ? (
              <p className="muted">{t.common.noAccountsYet}</p>
            ) : (
              <ul className="plain-list">
                {dashboard.accounts.map((a) => (
                  <li key={a.id}>
                    {tf(t.uploads.accountLine, {
                      label: a.displayLabel,
                      status: a.status,
                      quota: (t.states.quota as Record<string, string | undefined>)[a.quotaStatus] ?? a.quotaStatus,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">{t.common.loading}</p>
        )}
      </section>
    </>
  );
}

/** SHA-256 via the platform Web Crypto API (no dependency). */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
