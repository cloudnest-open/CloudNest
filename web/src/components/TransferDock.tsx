import { CloudUpload, Download, Upload } from 'lucide-react';
import { formatBytes } from './ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Roadmap Phase 4 (§4.2): the always-available transfer dock. Rows come ONLY
 * from the server's durable job state (never a local counter), so what the
 * dock shows is true on every page — including a job whose browser tab moved
 * away, whose frozen progress is exactly what the server still records.
 */

export interface UploadDockJob {
  jobId: string;
  fileName: string | null;
  state: string;
  bytesCompleted: number;
  sizeBytes: number;
}

export interface DownloadDockJob {
  jobId: string;
  fileId: string | null;
  state: string;
  requestedBytes: number | null;
  bytesCompleted: number;
}

const ACTIVE_STATES = new Set(['queued', 'running', 'paused']);

export function TransferDock({
  uploads,
  downloads,
  onOpenUploads,
  onOpenDownloads,
}: {
  uploads: UploadDockJob[];
  downloads: DownloadDockJob[];
  onOpenUploads: () => void;
  onOpenDownloads: () => void;
}) {
  const { t, tf, plural } = useI18n();

  const visibleUploads = uploads.filter((job) => ACTIVE_STATES.has(job.state));
  const visibleDownloads = downloads.filter((job) => ACTIVE_STATES.has(job.state));
  if (visibleUploads.length === 0 && visibleDownloads.length === 0) return null;

  const percent = (done: number, total: number | null): number =>
    total !== null && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <aside className="transfer-dock" aria-label={t.dock.aria}>
      <div className="dock-head">
        <CloudUpload size={15} aria-hidden="true" />
        <strong>
          {visibleDownloads.length === 0
            ? plural(t.dock.uploadsOnly, visibleUploads.length)
            : visibleUploads.length === 0
              ? plural(t.dock.downloadsOnly, visibleDownloads.length)
              : tf(t.dock.both, { up: visibleUploads.length, down: visibleDownloads.length })}
        </strong>
      </div>
      <ul className="dock-rows">
        {visibleUploads.map((job) => {
          const pct = percent(job.bytesCompleted, job.sizeBytes);
          return (
            <li key={job.jobId} className="dock-row">
              <Upload size={14} aria-hidden="true" className="muted" />
              <div className="dock-row-body">
                <span className="dock-row-name ellipsis" title={job.fileName ?? ''}>
                  {job.fileName ?? t.fileTypes.file}
                </span>
                <div className="progress-track dock-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className={`state state-${job.state === 'paused' ? 'bad' : 'warn'}`}>
                {(t.states.job as Record<string, string | undefined>)[job.state] ?? job.state}
              </span>
            </li>
          );
        })}
        {visibleDownloads.map((job) => {
          const pct = percent(job.bytesCompleted, job.requestedBytes);
          return (
            <li key={job.jobId} className="dock-row">
              <Download size={14} aria-hidden="true" className="muted" />
              <div className="dock-row-body">
                <span className="dock-row-name ellipsis">{tf(t.dock.downloadRow, { bytes: formatBytes(job.bytesCompleted) })}</span>
                <div className="progress-track dock-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className={`state state-${job.state === 'paused' ? 'bad' : 'warn'}`}>
                {(t.states.job as Record<string, string | undefined>)[job.state] ?? job.state}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="dock-links">
        {visibleUploads.length > 0 && (
          <button type="button" className="btn-inline" onClick={onOpenUploads}>{t.dock.openUploads}</button>
        )}
        {visibleDownloads.length > 0 && (
          <button type="button" className="btn-inline" onClick={onOpenDownloads}>{t.dock.openDownloads}</button>
        )}
      </div>
    </aside>
  );
}
