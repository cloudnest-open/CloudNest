import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Dashboard cards backed by real database rows only.
 * Unknown quota is displayed as unknown — never as zero or a fabricated number.
 */

interface Summary {
  accounts: Array<{ id: string; provider: string; displayLabel: string; status: string; quotaStatus: string }>;
  activeJobs: number;
  recentFiles: number;
  totalFiles: number;
}

interface FileView {
  id: string;
  originalName: string;
  sizeBytes: number;
  chunkCount: number;
  state: string;
  storedAcross: string[];
  createdAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  pcloud: 'pCloud',
  mega: 'MEGA',
};

function formatBytes(bytes: number): string {
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

export function DashboardSummary() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [files, setFiles] = useState<FileView[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      const [s, f] = await Promise.all([api.dashboardSummary(), api.listFiles(5, 0)]);
      if (s.status === 200) setSummary(s.data as Summary);
      else setFailed(true);
      if (f.status === 200) setFiles((f.data as { files: FileView[] }).files ?? []);
    })();
  }, []);

  if (failed) {
    return (
      <section className="card error-card" role="alert">
        <p>Could not load the dashboard summary.</p>
      </section>
    );
  }
  if (!summary) {
    return (
      <section className="card">
        <h2>Storage overview</h2>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const connected = summary.accounts.filter((a) => a.status === 'connected');
  const needsAttention = summary.accounts.filter((a) => a.status !== 'connected');

  return (
    <>
      <section className="card">
        <h2>Storage overview</h2>
        {summary.accounts.length === 0 ? (
          <p className="muted">No cloud accounts connected yet.</p>
        ) : (
          <>
            <p className="muted">
              {connected.length} connected account(s)
              {needsAttention.length > 0 ? ` · ${needsAttention.length} needing attention` : ''}
            </p>
            <ul className="plain-list">
              {summary.accounts.map((a) => (
                <li key={a.id}>
                  <strong>{PROVIDER_LABELS[a.provider] ?? a.provider}</strong> — {a.displayLabel}:{' '}
                  <span className={`state state-${a.status === 'connected' ? 'ok' : 'warn'}`}>{a.status}</span>{' '}
                  <span className="muted small">quota: {a.quotaStatus}</span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Provider-reported quotas can change outside CloudNest. Unknown quota is shown as unknown, not as zero.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Uploads</h2>
        <p className="muted">
          {summary.activeJobs === 0
            ? 'No uploads in progress.'
            : `${summary.activeJobs} upload(s) queued, running or paused.`}
        </p>
      </section>

      <section className="card">
        <h2>Recent files</h2>
        {files.length === 0 ? (
          <p className="muted">No files yet. Upload a file to see it here.</p>
        ) : (
          <ul className="plain-list">
            {files.map((f) => (
              <li key={f.id}>
                <strong>{f.originalName}</strong> — {formatBytes(f.sizeBytes)} · {f.chunkCount} chunk(s) ·{' '}
                <span className={`state state-${f.state === 'completed' ? 'ok' : 'warn'}`}>{f.state}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{summary.totalFiles} file(s) recorded in total.</p>
      </section>
    </>
  );
}
