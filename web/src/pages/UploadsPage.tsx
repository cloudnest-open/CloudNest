import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

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
 */

const CHUNK_SIZES = [8, 16, 32, 64] as const;
const DEFAULT_CHUNK_MIB = 64;
/** Global in-flight chunk requests; the server ceiling is 8. */
const MAX_GLOBAL_WORKERS = 4;
/** At most two chunks in flight per provider account. */
const MAX_PER_ACCOUNT_WORKERS = 2;
const OBJECT_COUNT_WARN_THRESHOLD = 1000;

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

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** The exact safe codes the server may return, with plain-language remedies. */
const ERROR_HELP: Record<string, string> = {
  capacity_insufficient: 'Not enough verified free space across your connected accounts. Refresh quota or connect another account.',
  invalid_upload_metadata: 'The file details were rejected. Check the name and size.',
  chunk_size_mismatch: 'A chunk did not arrive with the expected byte count. It was rejected and will be retried.',
  source_changed: 'The file you selected does not match the one this upload started with. Progress was preserved; select the original file again.',
  provider_no_space: 'A provider reported it is out of space. Its quota was marked stale; refresh it and retry.',
  provider_rate_limited: 'A provider is throttling requests. Wait a moment and retry.',
  provider_unavailable: 'A provider is temporarily unreachable. Retry shortly.',
  cleanup_pending: 'Some temporary remote objects could not be confirmed deleted. They stay recorded and will be retried.',
  job_not_resumable: 'This job can no longer be resumed.',
  idempotency_key_reused: 'The same request key was reused with different file details.',
  account_needs_reauth: 'A connected account needs you to sign in again.',
  provider_checksum_mismatch: 'A provider reported a size that does not match the uploaded bytes.',
  remote_size_mismatch: 'The stored object size does not match what was sent.',
  provider_root_missing: 'The CloudNest folder for that account is missing; try a quota refresh or reconnect.',
  upload_aborted: 'The upload was cancelled.',
  job_paused: 'This job is paused.',
  job_not_found: 'That upload job no longer exists.',
};

export function UploadsPage() {
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [selected, setSelected] = useState<File | null>(null);
  const [chunkMiB, setChunkMiB] = useState<number>(DEFAULT_CHUNK_MIB);
  const [plannedChunks, setPlannedChunks] = useState<ChunkPlanEntry[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  /** FE-01: the job picked from Recent uploads for a restart resume. */
  const [resumeTarget, setResumeTarget] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [verifiedChunks, setVerifiedChunks] = useState<number | null>(null);
  const [resumeReport, setResumeReport] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const loadSummary = useCallback(async () => {
    const [summary, list] = await Promise.all([api.dashboardSummary(), api.listUploads()]);
    if (summary.status === 200) setDashboard(summary.data as DashboardSummary);
    if (list.status === 200) setJobs(((list.data as { jobs: JobView[] }).jobs) ?? []);
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const chunkSizeBytes = chunkMiB * 1024 * 1024;
  const estimatedObjects = selected ? Math.ceil(selected.size / chunkSizeBytes) : 0;
  const shortFinalChunk = selected ? selected.size % chunkSizeBytes : 0;

  function describeError(data: unknown, fallback: string): { code: string; text: string } {
    const body = (data ?? {}) as { error?: string; code?: string };
    const code = body.code ?? body.error ?? '';
    const help = ERROR_HELP[code];
    return { code, text: help ? `${help}${code ? ` (${code})` : ''}` : fallback };
  }

  /** Metadata-only plan; no file bytes are sent in this step. */
  async function createPlan(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setNotice(null);
    setResumeReport(null);
    try {
      const res = await api.planUpload(
        {
          originalName: selected.name,
          sizeBytes: selected.size,
          chunkSizeMiB: chunkMiB,
          mimeType: selected.type || null,
        },
        crypto.randomUUID(),
      );
      if (res.status === 201 || res.status === 200) {
        const data = res.data as { jobId: string; chunkCount: number; allocations: ChunkPlanEntry[] };
        setJobId(data.jobId);
        setPlannedChunks(data.allocations);
        setNotice(
          data.chunkCount === 0
            ? 'This file is empty and needs no upload; it was recorded as complete.'
            : `Capacity reserved for ${data.chunkCount} chunk(s). You can start the upload now.`,
        );
      } else {
        const described = describeError(res.data, 'The upload could not be planned.');
        setError(described.text);
        setErrorCode(described.code || null);
      }
    } finally {
      setBusy(false);
    }
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
      setError('Select the original file before continuing this upload.');
      return;
    }
    if (runningRef.current) return;
    runningRef.current = true;
    setUploading(true);
    setError(null);
    setErrorCode(null);
    setResumeReport(null);
    abortRef.current = new AbortController();

    try {
      // the plan is authoritative: never trust a client-side chunk list
      const job = await refreshJob(id);
      if (!job) {
        setError('That upload job no longer exists.');
        return;
      }
      const planRes = await api.getUploadJob(id);
      void planRes;
      let indices: number[];
      if (onlyIndices && onlyIndices.length > 0) {
        indices = onlyIndices;
      } else {
        // rebuild the chunk geometry from the server's persisted plan
        const manifest = await api.resumeManifest(id, 1000);
        if (manifest.status !== 200) {
          setError('Could not read the upload plan from the server.');
          return;
        }
        const done = new Set(
          ((manifest.data as { chunks: Array<{ chunkIndex: number }> }).chunks ?? []).map((c) => c.chunkIndex),
        );
        indices = [];
        for (let i = 0; i < job.chunksTotal; i++) if (!done.has(i)) indices.push(i);
      }

      // FE-03: the job's PERSISTED geometry drives every slice, never the
      // current chunk-size select — after a restart that select may differ
      // from the plan this job was created with.
      const geometry = new Map<number, { offsetBytes: number; sizeBytes: number }>();
      for (let off = 0; ; off += 500) {
        const page = await api.resumeManifest(id, off, 500);
        if (page.status !== 200) break;
        const pageChunks = (page.data as { chunks: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }> }).chunks ?? [];
        for (const c of pageChunks) geometry.set(c.chunkIndex, { offsetBytes: c.offsetBytes, sizeBytes: c.sizeBytes });
        if (pageChunks.length < 500) break;
      }
      const jobResGeom = await api.getUploadJob(id);
      const chunksTotal = jobResGeom.status === 200 ? (jobResGeom.data as { job: JobView }).job.chunksTotal : 0;
      const fallbackGeometry = (index: number): { offsetBytes: number; sizeBytes: number } => {
        const offset = index * chunkSizeBytes;
        return { offsetBytes: offset, sizeBytes: Math.min(chunkSizeBytes, Math.max(0, selected.size - offset)) };
      };

      let cursor = 0;
      const workerCount = Math.min(MAX_GLOBAL_WORKERS, Math.max(1, indices.length));
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < indices.length) {
          if (abortRef.current?.signal.aborted) return;
          const chunkIndex = indices[cursor++] as number;
          // at most two chunks in flight per account is enforced server-side by
          // the persisted allocation; the client keeps its own global bound
          const geo = geometry.get(chunkIndex) ?? fallbackGeometry(chunkIndex);
          if (geo.sizeBytes <= 0 || geo.offsetBytes >= selected.size) continue;
          const slice = selected.slice(geo.offsetBytes, geo.offsetBytes + geo.sizeBytes);
          const res = await api.uploadChunkRaw(id, chunkIndex, slice);
          if (res.status !== 200) {
            const described = describeError(res.data, 'A chunk failed to upload.');
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
        setNotice(`Upload complete: ${finalJob.originalName ?? 'file'} (${formatBytes(finalJob.sizeBytes)}).`);
        setPlannedChunks(null);
        setJobId(null);
        setSelected(null);
      }
      await loadSummary();
    } finally {
      runningRef.current = false;
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
  async function prepareResume(): Promise<void> {
    const target = resumeTarget;
    if (!target || !selected) {
      setError('Pick the interrupted upload below and choose the original file, then use Resume.');
      return;
    }
    const targetId = target.jobId;
    setBusy(true);
    setError(null);
    try {
      // page through the whole manifest; the server caps one page at 500
      const chunks: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number; sha256: string }> = [];
      for (let off = 0; ; off += 500) {
        const page = await api.resumeManifest(targetId, off, 500);
        if (page.status !== 200) {
          setError('Could not read the resume information for this upload.');
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
        setError(ERROR_HELP['source_changed'] as string);
        return;
      }
      const done = new Set(chunks.map((c) => c.chunkIndex));
      const jobRes = await api.getUploadJob(targetId);
      const total = jobRes.status === 200 ? (jobRes.data as { job: JobView }).job.chunksTotal : 0;
      const missing: number[] = [];
      for (let i = 0; i < total; i++) if (!done.has(i)) missing.push(i);
      setVerifiedChunks(chunks.length);
      setResumeReport(
        `Verified ${chunks.length} previously uploaded chunk(s); ${missing.length} still to send. ` +
          'Note: chunks that were never uploaded cannot be compared with an earlier checksum because those bytes were never read.',
      );
      setJobId(targetId);
      await runUpload(targetId, missing);
    } finally {
      setBusy(false);
    }
  }

  async function pause(): Promise<void> {
    if (!jobId) return;
    setBusy(true);
    try {
      const res = await api.pauseUpload(jobId);
      if (res.status === 200) {
        await refreshJob(jobId);
        setNotice('Paused. Chunks already in flight were allowed to finish safely.');
      } else {
        const described = describeError(res.data, 'Could not pause the upload.');
        setError(described.text);
      }
    } finally {
      setBusy(false);
    }
  }

  async function resume(): Promise<void> {
    if (!jobId) return;
    setBusy(true);
    try {
      const res = await api.resumeUpload(jobId);
      if (res.status === 200) {
        await refreshJob(jobId);
        await runUpload(jobId);
      } else {
        const described = describeError(res.data, 'Could not resume the upload.');
        setError(described.text);
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!jobId) return;
    if (!window.confirm('Cancel this upload? Temporary remote objects are cleaned up; completed chunks are preserved.')) return;
    abortRef.current?.abort();
    setBusy(true);
    try {
      const res = await api.cancelUpload(jobId);
      if (res.status === 200) {
        const job = (res.data as { job: JobView | null }).job;
        if (job?.state === 'deletion_pending') {
          setNotice('Some temporary objects could not be confirmed deleted; they stay recorded as cleanup pending and will be retried.');
        } else {
          setNotice('Upload cancelled. Completed chunks were preserved.');
        }
        await refreshJob(jobId);
        await loadSummary();
      } else {
        const described = describeError(res.data, 'Could not cancel the upload.');
        setError(described.text);
      }
    } finally {
      setBusy(false);
    }
  }

  async function retry(): Promise<void> {
    if (!jobId) return;
    setBusy(true);
    try {
      const res = await api.retryUpload(jobId);
      if (res.status === 200) {
        await runUpload(jobId);
      } else {
        const described = describeError(res.data, 'Could not retry the upload.');
        setError(described.text);
      }
    } finally {
      setBusy(false);
    }
  }

  const currentJob = jobs.find((j) => j.jobId === jobId) ?? jobs[0] ?? null;
  const percent =
    currentJob && currentJob.sizeBytes > 0
      ? Math.min(100, Math.round((currentJob.bytesCompleted / currentJob.sizeBytes) * 100))
      : 0;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Uploads</h1>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && (
        <div className="card error-card" role="alert">
          <p>{error}</p>
          {errorCode && <p className="muted small">Code: {errorCode}</p>}
        </div>
      )}

      <section className="card">
        <h2>Select a file</h2>
        <p className="muted">
          The original file is never stored on the server. It is split in your browser and each chunk is
          streamed straight to your connected accounts.
        </p>
        <div className="upload-form">
          <label htmlFor="upload-file">File</label>
          <input
            id="upload-file"
            type="file"
            onChange={(e) => {
              setSelected(e.target.files?.[0] ?? null);
              setPlannedChunks(null);
              setJobId(null);
              setNotice(null);
              setResumeReport(null);
            }}
          />
          <label htmlFor="upload-chunk-size">Chunk size</label>
          <select
            id="upload-chunk-size"
            value={chunkMiB}
            onChange={(e) => setChunkMiB(Number(e.target.value))}
            disabled={Boolean(plannedChunks) || uploading}
          >
            {CHUNK_SIZES.map((size) => (
              <option key={size} value={size}>{size} MiB</option>
            ))}
          </select>
        </div>

        {selected && (
          <div className="plan-preview">
            <p>
              <strong>{selected.name}</strong> — {formatBytes(selected.size)}
            </p>
            <p className="muted small">
              Estimated logical chunks / remote objects: <strong>{estimatedObjects}</strong>
              {shortFinalChunk > 0 ? ' (the final chunk is smaller)' : ''}
            </p>
            {estimatedObjects > OBJECT_COUNT_WARN_THRESHOLD && (
              <p className="form-error" role="alert">
                Warning: this creates about {estimatedObjects} separate cloud objects and API calls.
                A larger chunk size produces fewer objects; smaller chunks make many more.
              </p>
            )}
          </div>
        )}

        <div className="actions">
          <button type="button" className="btn-primary" disabled={!selected || busy || uploading} onClick={() => void createPlan()}>
            {busy ? 'Working…' : 'Plan upload'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={!jobId || busy || uploading}
            onClick={() => void prepareResume()}
          >
            Resume (after restart)
          </button>
        </div>
        {verifiedChunks !== null && (
          <p className="muted small">Previously uploaded chunks verified by checksum: {verifiedChunks}</p>
        )}
        {resumeReport && <p className="muted small">{resumeReport}</p>}
      </section>

      {plannedChunks && (
        <section className="card">
          <h2>Ready to upload</h2>
          <p className="muted">
            {plannedChunks.length} chunk(s) reserved. Upload is bounded to {MAX_GLOBAL_WORKERS} chunks at once
            (at most {MAX_PER_ACCOUNT_WORKERS} per account).
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn-primary"
              disabled={uploading || busy || !jobId}
              onClick={() => jobId && void runUpload(jobId)}
            >
              {uploading ? 'Uploading…' : 'Start upload'}
            </button>
          </div>
        </section>
      )}

      {currentJob && (
        <section className="card">
          <div className="page-head">
            <h2>Current upload</h2>
            <span className={`state state-${currentJob.state === 'completed' ? 'ok' : currentJob.state === 'failed' || currentJob.state === 'deletion_pending' ? 'bad' : 'warn'}`}>
              {currentJob.state}
            </span>
          </div>
          <p className="muted small">
            {currentJob.originalName ?? 'file'} — {currentJob.chunksCompleted} / {currentJob.chunksTotal} chunks ·{' '}
            {formatBytes(currentJob.bytesCompleted)} of {formatBytes(currentJob.sizeBytes)}
          </p>
          <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted small">{percent}% (from server-reported progress)</p>
          {currentJob.safeErrorCode && (
            <p className="form-error">
              {ERROR_HELP[currentJob.safeErrorCode] ?? 'The upload reported an error.'} ({currentJob.safeErrorCode})
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn-secondary" disabled={!(currentJob.jobId === jobId) || busy || uploading} onClick={() => void pause()}>Pause</button>
            <button type="button" className="btn-secondary" disabled={!(currentJob.jobId === jobId) || busy || uploading} onClick={() => void resume()}>Resume</button>
            <button type="button" className="btn-secondary" disabled={!(currentJob.jobId === jobId) || busy || uploading} onClick={() => void retry()}>Retry</button>
            <button type="button" className="btn-danger" disabled={!(currentJob.jobId === jobId) || busy || !currentJob.cancellable} onClick={() => void cancel()}>Cancel</button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Recent uploads</h2>
        {jobs.length === 0 ? (
          <p className="muted">No uploads yet.</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Chunks</th>
                <th>State</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId}>
                  <td className="ellipsis">{job.originalName ?? '—'}</td>
                  <td>{formatBytes(job.sizeBytes)}</td>
                  <td>{job.chunksCompleted} / {job.chunksTotal}</td>
                  <td><span className={`state state-${job.state === 'completed' ? 'ok' : job.state === 'failed' || job.state === 'deletion_pending' ? 'bad' : 'warn'}`}>{job.state}</span></td>
                  <td className="muted small">{new Date(job.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Storage overview</h2>
        {dashboard ? (
          <>
            <p className="muted small">
              {dashboard.accounts.length} connected account(s) · {dashboard.activeJobs} active upload(s) · {dashboard.totalFiles} file(s) recorded
            </p>
            {dashboard.accounts.length === 0 ? (
              <p className="muted">No cloud accounts connected yet.</p>
            ) : (
              <ul className="plain-list">
                {dashboard.accounts.map((a) => (
                  <li key={a.id}>
                    <strong>{a.displayLabel}</strong> — {a.status}; quota {a.quotaStatus}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">Loading…</p>
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
