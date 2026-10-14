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
    // FE-04: a failed load must explain itself and offer a retry path
    try {
      const [d, f] = await Promise.all([api.listDownloads(50, 0), api.listFiles(100, 0)]);
      if (d.status === 200) setDownloads((d.data as { downloads: DownloadView[] }).downloads ?? []);
      if (f.status === 200) setFiles((f.data as { files: FileView[] }).files ?? []);
      if (d.status !== 200 && f.status !== 200) {
        setError('Could not load the download list. The server did not answer with real data.');
      } else {
        setError(null);
      }
    } catch {
      setError('Could not reach the server. Check that CloudNest is running, then retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // FE-09: real server-side byte progress is only useful if it is visible.
  // While any download job is running, poll the list; stop when none is.
  useEffect(() => {
    const running = downloads.some((d) => d.state === 'running');
    if (!running) return;
    const timer = setTimeout(() => { void load(); }, 1000);
    return () => clearTimeout(timer);
  }, [downloads, load]);

  /** FE-06: true when the browser exposes the File System Access writer. */
  function supportsFsAccess(): boolean {
    return typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
  }

  async function startDownload(file: FileView) {
    // FE-08: fetch first so a failed download surfaces IN-APP instead of
    // replacing the whole page with a raw JSON error document.
    setNotice(`Starting download of ${file.originalName}...`);
    try {
      const res = await fetch(api.downloadUrl(file.id));
      if (!res.ok) {
        let code = '';
        try {
          const body = (await res.json()) as { code?: string };
          code = body.code ?? '';
        } catch {
          // non-JSON failure body: fall back to the status alone
        }
        setError(code
          ? `The download failed (${code}). Check the file's chunks and provider accounts, then retry.`
          : `The download failed (HTTP ${res.status}). Check the file's chunks and provider accounts, then retry.`);
        return;
      }
      const disposition = res.headers.get('content-disposition') ?? '';
      const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
      const name = match ? decodeURIComponent(match[1] ?? match[2] ?? '') : file.originalName;

      // FE-06 preferred path: stream straight to disk through the File System
      // Access API. Bytes are written as they arrive, so even large files
      // never sit in browser memory. Cancel/user-dismiss falls back to the
      // native download below.
      const picker = (window as {
        showSaveFilePicker?: (opts: {
          suggestedName?: string;
          types?: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<{
          createWritable: () => Promise<{
            write: (data: BufferSource | Blob | string) => Promise<void>;
            close: () => Promise<void>;
            abort?: (reason?: string) => Promise<void>;
          }>;
        }>;
      }).showSaveFilePicker;
      if (supportsFsAccess() && picker) {
        try {
          const handle = await picker({
            suggestedName: name,
            types: [{ description: 'All files', accept: { 'application/octet-stream': ['.bin'] } }],
          });
          const writable = await handle.createWritable();
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await writable.write(value);
            }
          }
          await writable.close();
          setNotice(`Saved ${name} to disk.`);
          setTimeout(() => void load(), 1500);
          return;
        } catch (err) {
          const name2 = (err as { name?: string }).name;
          if (name2 === 'AbortError') {
            // the user dismissed the save dialog: nothing to do
            setNotice('Download cancelled.');
            return;
          }
          // any writer failure falls through to the native fallback below
          setNotice('Direct-to-disk save failed; using the browser download instead.');
        }
      }

      // Native fallback: the browser performs the download and manages
      // Range/resume itself. In-app progress/resume controls are limited in
      // this mode (disclosed in the downloads list copy).
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${name} via the browser download. In-app progress and resume are limited in this fallback.`);
      setTimeout(() => void load(), 1500);
    } catch {
      setError('Could not reach the server for the download. Check that CloudNest is running, then retry.');
    }
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
