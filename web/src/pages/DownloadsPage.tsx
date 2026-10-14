import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Downloads (Step 5 / M10.e).
 *
 * Progress comes from persisted job rows only. Browser-native downloads are
 * used deliberately: the browser handles Range/resume itself, so the UI does
 * not offer a pause button it cannot honour.
 */

interface DownloadView {
  jobId: string;
  fileId: string | null;
  state: string;
  requestedBytes: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  chunksCompleted: number;
  chunksTotal: number;
  bytesCompleted: number;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FileView {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
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

const ERROR_HELP: Record<string, string> = {
  chunk_missing: 'A required chunk is no longer present on its provider. The file needs repair.',
  chunk_hash_mismatch: 'A chunk did not match its recorded checksum; the download was aborted rather than delivering corrupt data.',
  file_not_complete: 'This file is not fully uploaded yet, so it cannot be downloaded.',
  file_not_found: 'That file no longer exists.',
  deletion_pending: 'This file is queued for deletion and cannot be downloaded.',
  provider_needs_reauth: 'A connected account needs you to sign in again.',
  provider_rate_limited: 'A provider is throttling requests. Try again shortly.',
  provider_unavailable: 'A provider is temporarily unreachable.',
  download_cancelled: 'The download was cancelled.',
  download_interrupted: 'The download was interrupted (for example by a server restart) and did not complete.',
  invalid_range: 'The requested byte range was not understood.',
  range_not_satisfiable: 'The requested byte range lies outside the file.',
};

export function DownloadsPage() {
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [files, setFiles] = useState<FileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, f] = await Promise.all([api.listDownloads(50, 0), api.listFiles(100, 0)]);
    if (d.status === 200) setDownloads((d.data as { downloads: DownloadView[] }).downloads ?? []);
    if (f.status === 200) setFiles((f.data as { files: FileView[] }).files ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startDownload(file: FileView) {
    // the browser performs a native download and manages Range/resume itself
    setNotice(`Starting download of ${file.originalName}. Your browser handles the transfer and any resume.`);
    window.location.assign(api.downloadUrl(file.id));
    setTimeout(() => void load(), 1500);
  }

  async function cancel(jobId: string) {
    const res = await api.cancelDownload(jobId);
    if (res.status === 200) {
      setNotice('Cancellation recorded. The browser may still be finishing its own transfer.');
      await load();
    } else {
      setError('Could not cancel that download.');
    }
  }

  const downloadable = files.filter((f) => f.state === 'completed');

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Downloads</h1>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <section className="card">
        <h2>Available files</h2>
        {downloadable.length === 0 ? (
          <p className="muted">No completed files to download yet.</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {downloadable.map((file) => (
                <tr key={file.id}>
                  <td className="ellipsis">{file.originalName}</td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td className="actions">
                    <button type="button" className="btn-primary" onClick={() => startDownload(file)}>Download</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Downloads stream through CloudNest and are reassembled chunk by chunk with a checksum check before any
          bytes are sent. Progress below is the server's record of bytes it streamed; it is not proof that your
          device finished saving the file. Pause/resume is provided by your browser, so no in-app pause button is shown.
        </p>
      </section>

      <section className="card">
        <h2>Recent transfers</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : downloads.length === 0 ? (
          <p className="muted">No downloads yet.</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Range</th>
                <th>Progress</th>
                <th>State</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {downloads.map((d) => {
                const percent = d.requestedBytes && d.requestedBytes > 0
                  ? Math.min(100, Math.round(((d.bytesCompleted ?? 0) / d.requestedBytes) * 100))
                  : 0;
                return (
                  <tr key={d.jobId}>
                    <td className="muted small">
                      {d.rangeStart === null || d.rangeEnd === null
                        ? 'Full file'
                        : `bytes ${d.rangeStart}–${d.rangeEnd}`}
                    </td>
                    <td>
                      {formatBytes(d.bytesCompleted)} / {formatBytes(d.requestedBytes ?? 0)}
                      <div className="muted small">{d.chunksCompleted} / {d.chunksTotal} chunks · {percent}%</div>
                    </td>
                    <td>
                      <span className={`state state-${d.state === 'completed' ? 'ok' : d.state === 'failed' || d.state === 'cancelled' ? 'bad' : 'warn'}`}>
                        {d.state}
                      </span>
                      {d.safeErrorCode && (
                        <div className="muted small">
                          {ERROR_HELP[d.safeErrorCode] ?? d.safeErrorCode} ({d.safeErrorCode})
                        </div>
                      )}
                    </td>
                    <td className="muted small">{new Date(d.updatedAt).toLocaleString()}</td>
                    <td className="actions">
                      <button type="button" className="btn-secondary" disabled={d.state !== 'running'} onClick={() => void cancel(d.jobId)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
