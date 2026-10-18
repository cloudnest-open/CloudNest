import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBytes, formatDateTime, useToast } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';
import { useUiMode } from '../ui-mode-context.js';

/**
 * Downloads (Step 5 / M10.e).
 *
 * Progress comes from persisted job rows only. Browser-native downloads are
 * used deliberately: the browser handles Range/resume itself, so the UI does
 * not offer a pause button it cannot honour. All copy resolves through the
 * app-wide i18n context; the server's safe error codes map to localized
 * remedies (t.errors.download) with the raw code kept as a diagnostic.
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

export function DownloadsPage() {
  const { t, tf } = useI18n();
  // mode = complete context: this page never sees the other tier's rows
  const { uiMode } = useUiMode();
  const tier = uiMode ?? 'personal';
  const toast = useToast();
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [files, setFiles] = useState<FileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const jobStateLabel = (state: string): string =>
    (t.states.job as Record<string, string | undefined>)[state] ?? state;

  const load = useCallback(async () => {
    setLoading(true);
    // FE-04: a failed load must explain itself and offer a retry path
    try {
      const [d, f] = await Promise.all([api.listDownloads(50, 0, tier), api.listFiles(100, 0, '', undefined, tier)]);
      if (d.status === 200) setDownloads((d.data as { downloads: DownloadView[] }).downloads ?? []);
      if (f.status === 200) setFiles((f.data as { files: FileView[] }).files ?? []);
      if (d.status !== 200 && f.status !== 200) {
        setError(t.downloads.errorLoad);
      } else {
        setError(null);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user/poll-driven; a language change must not re-fetch
  }, [tier]);

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
    // replacing the whole page with a raw JSON error document. The start
    // feedback is a toast (session-21 batch-C): the primary action deserves
    // feedback that survives scrolling, not only the in-page notice line.
    toast.push({ kind: 'info', title: tf(t.downloads.starting, { name: file.originalName }) });
    setNotice(tf(t.downloads.starting, { name: file.originalName }));
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
          ? tf(t.downloads.failedWithCode, { code })
          : tf(t.downloads.failedWithStatus, { status: res.status }));
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
            types: [{ description: t.downloads.fullFile, accept: { 'application/octet-stream': ['.bin'] } }],
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
          setNotice(tf(t.downloads.savedToDisk, { name }));
          setTimeout(() => void load(), 1500);
          return;
        } catch (err) {
          const name2 = (err as { name?: string }).name;
          if (name2 === 'AbortError') {
            // the user dismissed the save dialog: nothing to do
            setNotice(t.downloads.cancelled);
            return;
          }
          // any writer failure falls through to the native fallback below
          setNotice(t.downloads.fsFallback);
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
      setNotice(tf(t.downloads.nativeFallback, { name }));
      setTimeout(() => void load(), 1500);
    } catch {
      setError(t.downloads.reachFailed);
    }
  }

  async function cancel(jobId: string) {
    const res = await api.cancelDownload(jobId);
    if (res.status === 200) {
      setNotice(t.downloads.cancelRecorded);
      await load();
    } else {
      setError(t.downloads.cancelFailed);
    }
  }

  const downloadable = files.filter((f) => f.state === 'completed');
  const fileNames = new Map(files.map((file) => [file.id, file.originalName]));

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t.downloads.title}</h1>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? t.common.refreshing : t.common.refresh}
        </button>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <section className="card">
        <h2>{t.downloads.available}</h2>
        {downloadable.length === 0 ? (
          <p className="muted">{t.downloads.noneAvailable}</p>
        ) : (
          <div className="table-scroll-container">
          <table className="accounts-table download-table download-available-table">
            <colgroup>
              <col className="download-name-col" />
              <col className="download-size-col" />
              <col className="download-action-col" />
            </colgroup>
            <thead>
              <tr>
                <th>{t.downloads.file}</th>
                <th>{t.downloads.size}</th>
                <th>{t.downloads.action}</th>
              </tr>
            </thead>
            <tbody>
              {downloadable.map((file) => (
                <tr key={file.id}>
                  <td className="download-file-name-cell" title={file.originalName}>{file.originalName}</td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td className="actions">
                    <button type="button" className="btn-primary" onClick={() => startDownload(file)}>{t.downloads.download}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p className="muted small">{t.downloads.footnote}</p>
      </section>

      <section className="card">
        <h2>{t.downloads.transfers}</h2>
        {loading ? (
          <p className="muted">{t.common.loading}</p>
        ) : downloads.length === 0 ? (
          <p className="muted">{t.downloads.none}</p>
        ) : (
          <div className="table-scroll-container">
          <table className="accounts-table download-table download-transfers-table">
            <colgroup>
              <col className="transfer-name-col" />
              <col className="transfer-progress-col" />
              <col className="transfer-state-col" />
              <col className="transfer-updated-col" />
              <col className="transfer-actions-col" />
            </colgroup>
            <thead>
              <tr>
                <th>{t.downloads.file}</th>
                <th>{t.downloads.progress}</th>
                <th>{t.downloads.state}</th>
                <th>{t.downloads.updated}</th>
                <th>{t.downloads.actions}</th>
              </tr>
            </thead>
            <tbody>
              {downloads.map((d) => {
                const percent = d.requestedBytes && d.requestedBytes > 0
                  ? Math.min(100, Math.round(((d.bytesCompleted ?? 0) / d.requestedBytes) * 100))
                  : 0;
                return (
                  <tr key={d.jobId}>
                    <td>
                      <span className="download-file-name" title={d.fileId ? fileNames.get(d.fileId) ?? t.common.unknown : t.common.unknown}>
                        {d.fileId ? fileNames.get(d.fileId) ?? t.common.unknown : t.common.unknown}
                      </span>
                      <span className="download-range-meta muted small">
                        {d.rangeStart === null || d.rangeEnd === null
                        ? t.downloads.fullFile
                        : tf(t.downloads.bytesRange, { start: d.rangeStart, end: d.rangeEnd })}
                      </span>
                    </td>
                    <td className="download-progress-cell">
                      {formatBytes(d.bytesCompleted)} / {formatBytes(d.requestedBytes ?? 0)}
                      <div className="muted small">{tf(t.downloads.chunksOf, { done: d.chunksCompleted, total: d.chunksTotal, pct: percent })}</div>
                    </td>
                    <td>
                      <span className={`state state-${d.state === 'completed' ? 'ok' : d.state === 'failed' || d.state === 'cancelled' ? 'bad' : 'warn'}`}>
                        {jobStateLabel(d.state)}
                      </span>
                      {d.safeErrorCode && (
                        <div className="muted small">
                          {((t.errors.download as Record<string, string | undefined>)[d.safeErrorCode] ?? d.safeErrorCode)} ({d.safeErrorCode})
                        </div>
                      )}
                    </td>
                    <td className="muted small">{formatDateTime(d.updatedAt)}</td>
                    <td className="actions">
                      {/* A cancel is only meaningful while the download runs;
                          finished/failed rows keep the record but no button. */}
                      {d.state === 'running' && (
                        <button type="button" className="btn-secondary" onClick={() => void cancel(d.jobId)}>
                          {t.downloads.cancel}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </>
  );
}
