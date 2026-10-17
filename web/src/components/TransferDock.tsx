import { ChevronDown, CloudUpload, Download, Upload } from 'lucide-react';
import { formatBytes } from './ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Roadmap Phase 4 (§4.2): the always-available transfer dock. Rows come ONLY
 * from the server's durable job state (never a local counter), so what the
 * dock shows is true on every page — including a job whose browser tab moved
 * away, whose frozen progress is exactly what the server still records.
 * Session-21 batch-B: the dock defaults to a collapsed pill (icon + count +
 * micro progress ring) so it stops eating the corner it sits in; expanding
 * it reserves content space (the app adds .content-dock-reserve).
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
  collapsed,
  onToggleCollapsed,
}: {
  uploads: UploadDockJob[];
  downloads: DownloadDockJob[];
  onOpenUploads: () => void;
  onOpenDownloads: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t, tf, plural } = useI18n();

  const visibleUploads = uploads.filter((job) => ACTIVE_STATES.has(job.state));
  const visibleDownloads = downloads.filter((job) => ACTIVE_STATES.has(job.state));
  if (visibleUploads.length === 0 && visibleDownloads.length === 0) return null;

  const percent = (done: number, total: number | null): number =>
    total !== null && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const count = visibleUploads.length + visibleDownloads.length;
  // Aggregate ring on the collapsed pill: honest share of bytes moved over the
  // bytes the durable jobs account for (0 while sizes are unknown).
  const totalDone = [...visibleUploads, ...visibleDownloads].reduce<number>((sum, job) => sum + job.bytesCompleted, 0);
  const totalSize = [
    ...visibleUploads.map((job) => job.sizeBytes),
    ...visibleDownloads.map((job) => job.requestedBytes),
  ].reduce<number>((sum, size) => sum + (size ?? 0), 0);
  const aggregate = percent(totalDone, totalSize > 0 ? totalSize : null);
  const ring = 2 * Math.PI * 8;

  if (collapsed) {
    return (
      <button
        type="button"
        className="transfer-dock-pill"
        aria-label={t.dock.ariaCollapsed}
        title={t.dock.expand}
        onClick={onToggleCollapsed}
      >
        <CloudUpload size={16} aria-hidden="true" />
        <span className="transfer-count">{count}</span>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" className="dock-pill-ring">
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--cn-border)" strokeWidth="2.5" />
          <circle
            cx="10" cy="10" r="8" fill="none"
            stroke="var(--cn-primary)" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${(aggregate / 100) * ring} ${ring}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
    );
  }

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
        <button
          type="button"
          className="dock-collapse-btn"
          aria-label={t.dock.collapse}
          title={t.dock.collapse}
          onClick={onToggleCollapsed}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
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
