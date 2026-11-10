import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBytes, formatDateTime, pageList, useToast } from '../components/ui.js';
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
  /** session-26 F3: empty = nothing is stored on any provider yet, so a
   * download could only ever fail — the button says so instead. */
  storedAcross: string[];
}

export function DownloadsPage() {
  const { t, tf } = useI18n();
  // mode = complete context: this page never sees the other tier's rows
  const { uiMode } = useUiMode();
  const tier = uiMode ?? 'personal';
  const toast = useToast();
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [files, setFiles] = useState<FileView[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [fileSearch, setFileSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filePage, setFilePage] = useState(0);
  const FILE_PAGE_SIZE = 50;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const jobStateLabel = (state: string): string =>
    (t.states.job as Record<string, string | undefined>)[state] ?? state;

  const load = useCallback(async () => {
    setLoading(true);
    // FE-04: a failed load must explain itself and offer a retry path
    try {
      const [d, f] = await Promise.all([
        api.listDownloads(50, 0, tier),
        api.listFiles(FILE_PAGE_SIZE, filePage * FILE_PAGE_SIZE, appliedSearch, undefined, tier),
      ]);
      if (d.status === 200) setDownloads((d.data as { downloads: DownloadView[] }).downloads ?? []);
      if (f.status === 200) {
        const data = f.data as { files: FileView[]; total: number };
        setFiles(data.files ?? []);
        setFilesTotal(data.total ?? 0);
      }
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
  }, [tier, filePage, appliedSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilePage(0);
      setAppliedSearch(fileSearch.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [fileSearch]);

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
    // session-26 F3: an unplaced file has no bytes anywhere — starting a job
    // could only end in the honest chunk_missing failure, so the row-level
    // button is disabled and this guard keeps the keyboard path honest too.
    if (file.storedAcross.length === 0) return;
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

      // Native fallback: stream directly through the browser without buffering
      // the whole file into tab RAM, preventing Out-Of-Memory crashes on large files.
      const anchor = document.createElement('a');
      anchor.href = api.downloadUrl(file.id);
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
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

  const downloadable = files
    .filter((f) => f.state === 'completed')
    .map((f) => ({ ...f, storedAcross: f.storedAcross ?? [] }));
  const fileNames = new Map(files.map((file) => [file.id, file.originalName]));
  const totalPages = Math.max(1, Math.ceil(filesTotal / FILE_PAGE_SIZE));

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
        <div className="card-head">
          <h2>{t.downloads.available}</h2>
          <div className="card-tools">
            <input
              type="search"
              aria-label={t.files.searchLabel}
              placeholder={t.files.searchPlaceholder}
              value={fileSearch}
              onChange={(e) => setFileSearch(e.target.value)}
            />
          </div>
        </div>
        {downloadable.length === 0 ? (
          <p className="muted">{appliedSearch ? t.files.emptySearchBody : t.downloads.noneAvailable}</p>
        ) : (
          <>
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
                  <td className="download-file-name-cell">
                    <span className="download-file-name" title={file.originalName}>{file.originalName}</span>
                    {file.storedAcross.length === 0 && (
                      <span className="download-range-meta muted small">{t.common.notPlaced}</span>
                    )}
                  </td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td className="actions">
                    {/* session-26 F3: a file with zero placements cannot
                        produce a download — the disabled button carries the
                        reason, matching the Files page's disabled Share. */}
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={file.storedAcross.length === 0}
                      title={file.storedAcross.length === 0 ? t.downloads.notPlacedTitle : undefined}
                      onClick={() => void startDownload(file)}
                    >
                      {t.downloads.download}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {totalPages > 1 && (
            <div className="files-footer" style={{ marginTop: 12 }}>
              <span className="muted small">
                {tf(t.common.showingRange, {
                  from: filePage * FILE_PAGE_SIZE + 1,
                  to: filePage * FILE_PAGE_SIZE + files.length,
                  total: filesTotal,
                })}
              </span>
              <nav className="pagination" aria-label={t.files.paginationAria}>
                <button
                  type="button"
                  className="page-btn"
                  disabled={filePage === 0 || loading}
                  aria-label={t.common.previousPage}
                  onClick={() => setFilePage((p) => Math.max(0, p - 1))}
                >‹</button>
                {pageList(filePage + 1, totalPages).map((p, i) =>
                  p === 'gap' ? (
                    <span key={`gap-${i}`} className="pagination-gap" aria-hidden="true">…</span>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      className={`page-btn${p === filePage + 1 ? ' active' : ''}`}
                      aria-current={p === filePage + 1 ? 'page' : undefined}
                      disabled={loading}
                      onClick={() => setFilePage(p - 1)}
                    >{p}</button>
                  ),
                )}
                <button
                  type="button"
                  className="page-btn"
                  disabled={filePage + 1 >= totalPages || loading}
                  aria-label={t.common.nextPage}
                  onClick={() => setFilePage((p) => Math.min(totalPages - 1, p + 1))}
                >›</button>
              </nav>
            </div>
          )}
          </>
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
