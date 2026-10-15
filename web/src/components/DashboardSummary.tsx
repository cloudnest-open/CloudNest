import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatBytes, PROVIDER_LABELS } from './ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Dashboard cards backed by real database rows only.
 * Unknown quota is displayed as unknown — never as zero or a fabricated number.
 * All copy resolves through the app-wide i18n context.
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

export function DashboardSummary() {
  const { t, tf, plural } = useI18n();
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
        <p>{t.summary.failed}</p>
      </section>
    );
  }
  if (!summary) {
    return (
      <section className="card">
        <h2>{t.summary.overview}</h2>
        <p className="muted">{t.common.loading}</p>
      </section>
    );
  }

  const connected = summary.accounts.filter((a) => a.status === 'connected');
  const needsAttention = summary.accounts.filter((a) => a.status !== 'connected');

  return (
    <>
      <section className="card">
        <h2>{t.summary.overview}</h2>
        {summary.accounts.length === 0 ? (
          <p className="muted">{t.summary.noAccounts}</p>
        ) : (
          <>
            <p className="muted">
              {plural(t.summary.connectedAccounts, connected.length)}
              {needsAttention.length > 0 ? ` ${plural(t.summary.needingAttention, needsAttention.length)}` : ''}
            </p>
            <ul className="plain-list">
              {summary.accounts.map((a) => (
                <li key={a.id}>
                  {tf(t.summary.accountLine, {
                    label: `${PROVIDER_LABELS[a.provider] ?? a.provider} — ${a.displayLabel}`,
                    status: a.status,
                    quota: a.quotaStatus,
                  })}
                </li>
              ))}
            </ul>
            <p className="muted small">{t.summary.quotaNote}</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>{t.summary.uploadsTitle}</h2>
        <p className="muted">
          {summary.activeJobs === 0
            ? t.summary.uploadsNone
            : plural(t.summary.uploadsSome, summary.activeJobs)}
        </p>
      </section>

      <section className="card">
        <h2>{t.summary.recentTitle}</h2>
        {files.length === 0 ? (
          <p className="muted">{t.summary.recentNone}</p>
        ) : (
          <ul className="plain-list">
            {files.map((f) => (
              <li key={f.id}>
                <strong>{f.originalName}</strong> — {formatBytes(f.sizeBytes)} · {plural(t.summary.fileLine, f.chunkCount)} ·{' '}
                <span className={`state state-${f.state === 'completed' ? 'ok' : 'warn'}`}>{f.state}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{plural(t.summary.totalNote, summary.totalFiles)}</p>
      </section>
    </>
  );
}
