import { useCallback, useEffect, useState } from 'react';
import {
  Cloud, Database, FileText, Link as LinkIcon, Plus, Upload, ArrowRight,
  Share2 as ShareIcon, Pencil, Trash2, RefreshCw,
} from 'lucide-react';
import { api } from '../api.js';
import {
  Badge, EmptyState, ProviderTile, ProgressBar, SkeletonRows, TypeIcon,
  formatBytes, formatDateTime, PROVIDER_LABELS,
} from '../components/ui.js';
import { useFileActions } from '../components/FileActionsProvider.js';

/**
 * Dashboard (design pack §7): heading, four real summary cards, provider
 * cards and the latest CloudNest-managed files.
 *
 * Honesty rules enforced here: every number comes from the API, unknown/stale
 * quota renders as "Unknown" (never 0), and an unhealthy account can never be
 * labelled "Connected".
 */

type Page = 'Files' | 'Uploads' | 'Cloud Accounts' | 'Shared Links';

interface AccountDetail {
  id: string;
  provider: string;
  displayLabel: string;
  status: string;
  quotaStatus: string;
  quotaTotalBytes: number | null;
  quotaUsedBytes: number | null;
  reserveBytes: number;
  outstandingBytes: number;
  usableBytes: number | null;
  lastQuotaCheckAt: string | null;
}

interface FileRow {
  id: string;
  originalName: string;
  sizeBytes: number;
  chunkCount: number;
  state: string;
  storedAcross: string[];
  createdAt: string;
}

interface Summary {
  accounts: Array<{ id: string; provider: string; status: string; quotaStatus: string }>;
  activeJobs: number;
  totalFiles: number;
  accountsDetailed: AccountDetail[];
  storage: {
    knownAccounts: number;
    unknownAccounts: number;
    totalBytes: number | null;
    usedBytes: number | null;
    reservedBytes: number;
    usableBytes: number | null;
    lastCheckedAt: string | null;
  };
  activeShareLinks: number;
  recentFileList: FileRow[];
}

/** One account's health, expressed as dot tone + honest label. */
function accountHealth(account: AccountDetail): { tone: 'ok' | 'warn' | 'bad' | 'muted'; label: string } {
  if (account.status === 'needs_reauth') return { tone: 'warn', label: 'Needs attention — reconnect' };
  if (account.status === 'error') return { tone: 'bad', label: 'Error — check the account' };
  if (account.status === 'disconnected') return { tone: 'muted', label: 'Disconnected' };
  if (account.quotaStatus !== 'current') return { tone: 'warn', label: 'Quota not refreshed' };
  return { tone: 'ok', label: 'Connected' };
}

function usageTone(account: AccountDetail): 'primary' | 'warning' | 'danger' {
  if (account.status === 'error' || account.status === 'needs_reauth') return 'danger';
  const total = account.quotaTotalBytes;
  const used = account.quotaUsedBytes;
  if (typeof total === 'number' && total > 0 && typeof used === 'number' && used / total >= 0.9) return 'warning';
  return 'primary';
}

export function DashboardPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const actions = useFileActions();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'size'>('modified');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.dashboardSummary();
    if (res.status === 200) {
      setSummary(res.data as Summary);
      setError(null);
    } else {
      setError('Could not load the dashboard. The server did not answer with real data.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const storage = summary?.storage;
  const accounts = summary?.accountsDetailed ?? [];
  const healthy = accounts.filter((a) => accountHealth(a).tone === 'ok').length;
  const attention = accounts.length - healthy;
  const files = (summary?.recentFileList ?? [])
    .filter((f) => (search ? f.originalName.toLowerCase().includes(search.toLowerCase()) : true))
    .sort((a, b) => {
      if (sortBy === 'name') return a.originalName.localeCompare(b.originalName);
      if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    });

  const storageKnown = Boolean(storage) && storage!.usableBytes !== null && storage!.totalBytes !== null;
  const usedPct = storageKnown && (storage!.totalBytes ?? 0) > 0
    ? Math.min(100, Math.round(((storage!.usedBytes ?? 0) / storage!.totalBytes!) * 100))
    : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="muted">Manage your files, cloud accounts and storage across multiple providers.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} aria-hidden="true" />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <div className="dash-grid">
        <div className="dash-main">
          {/* ---- summary cards ---- */}
          <div className="metric-grid">
            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><Cloud size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">Connected Accounts</span>
                <span className="metric-value">{accounts.length === 0 ? '—' : `${healthy} / ${accounts.length}`}</span>
                {accounts.length === 0 ? (
                  <span className="small muted">None connected yet</span>
                ) : attention === 0 ? (
                  <span className="metric-sub ok"><span className="status-dot status-ok" aria-hidden="true" />All Connected</span>
                ) : (
                  <span className="metric-sub warn"><span className="status-dot status-warn" aria-hidden="true" />{attention} need attention</span>
                )}
              </div>
            </section>

            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><Database size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">Available Storage</span>
                <span className="metric-value">{storageKnown ? formatBytes(storage!.usableBytes) : 'Unknown'}</span>
                {storageKnown ? (
                  <>
                    <span className="metric-row">
                      <span className="muted">of {formatBytes(storage!.totalBytes)} total</span>
                      <span className="muted">{Math.max(0, 100 - usedPct)}% free</span>
                    </span>
                    <ProgressBar value={usedPct} />
                  </>
                ) : (
                  <span className="small muted">
                    {accounts.length === 0
                      ? 'Connect an account to see real capacity.'
                      : `Quota not verified${storage?.lastCheckedAt ? ` · last checked ${formatDateTime(storage.lastCheckedAt)}` : ''}`}
                  </span>
                )}
              </div>
            </section>

            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><FileText size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">Files Stored</span>
                <span className="metric-value">{summary?.totalFiles ?? 0}</span>
                <span className="small muted">Total files &amp; folders</span>
              </div>
            </section>

            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><LinkIcon size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">Shared Links</span>
                <span className="metric-value">{summary?.activeShareLinks ?? 0}</span>
                <span className="small muted">Active links</span>
              </div>
            </section>
          </div>

          {/* ---- provider accounts ---- */}
          <h2 className="section-title">Cloud Provider Accounts</h2>
          {loading && accounts.length === 0 ? (
            <section className="card"><SkeletonRows rows={2} /></section>
          ) : accounts.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={Cloud}
                title="No cloud accounts connected"
                body="Connect Google Drive, Dropbox, OneDrive, pCloud or MEGA to start storing chunks across providers."
              >
                <button type="button" className="btn-primary" onClick={() => onNavigate('Cloud Accounts')}>
                  <Plus size={15} aria-hidden="true" />
                  Connect account
                </button>
              </EmptyState>
            </section>
          ) : (
            <div className="provider-grid">
              {accounts.map((account) => {
                const health = accountHealth(account);
                const total = account.quotaTotalBytes;
                const used = account.quotaUsedBytes;
                const pct = typeof total === 'number' && total > 0 && typeof used === 'number'
                  ? Math.min(100, (used / total) * 100)
                  : null;
                return (
                  <section className="provider-card" key={account.id}>
                    <div className="provider-card-head">
                      <span className="provider-id">
                        <ProviderTile provider={account.provider} />
                        <strong>{PROVIDER_LABELS[account.provider] ?? account.provider}</strong>
                      </span>
                      {account.provider === 'mega' && <Badge tone="warn">Experimental</Badge>}
                    </div>
                    <p className="small muted">
                      {pct === null
                        ? 'Capacity unknown — refresh the quota on Cloud Accounts.'
                        : `${formatBytes(used)} used of ${formatBytes(total)}`}
                    </p>
                    {pct !== null && <ProgressBar value={pct} tone={usageTone(account)} />}
                    <p className={`small provider-status status-text-${health.tone}`}>
                      <span className={`status-dot status-${health.tone === 'bad' ? 'down' : health.tone === 'ok' ? 'ok' : 'warn'}`} aria-hidden="true" />
                      {health.label}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary btn-block"
                      onClick={() => onNavigate('Cloud Accounts')}
                    >
                      Manage
                    </button>
                  </section>
                );
              })}
            </div>
          )}

          {/* ---- recent files ---- */}
          <section className="card">
            <div className="card-head">
              <h2>Recent Files</h2>
              <div className="card-tools">
                <input
                  type="search"
                  aria-label="Search files"
                  placeholder="Search files..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label="Sort files"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'modified' | 'name' | 'size')}
                >
                  <option value="modified">Sort by: Modified</option>
                  <option value="name">Sort by: Name</option>
                  <option value="size">Sort by: Size</option>
                </select>
                <button type="button" className="btn-secondary" onClick={() => onNavigate('Files')}>
                  View all
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            </div>

            {files.length === 0 ? (
              <EmptyState
                icon={Upload}
                title={search ? 'No files match your search' : 'No files yet'}
                body={search ? 'Clear the search to see the latest files.' : 'Upload a file and it will appear here as one logical file.'}
              >
                {!search && (
                  <button type="button" className="btn-primary" onClick={() => onNavigate('Uploads')}>
                    <Upload size={15} aria-hidden="true" />
                    Upload files
                  </button>
                )}
              </EmptyState>
            ) : (
              <table className="accounts-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Stored in</th>
                    <th>Last modified</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={file.id}>
                      <td>
                        <span className="file-name-cell">
                          <TypeIcon name={file.originalName} />
                          <span className="ellipsis">{file.originalName}</span>
                          <Badge tone={file.state === 'completed' ? 'ok' : file.state === 'deleted' ? 'muted' : 'warn'}>
                            {file.state}
                          </Badge>
                        </span>
                      </td>
                      <td>{formatBytes(file.sizeBytes)}</td>
                      <td>
                        <span className="file-name-cell">
                          {file.storedAcross.length === 0
                            ? <span className="muted small">Not yet placed</span>
                            : file.storedAcross.slice(0, 2).map((p) => <ProviderTile key={p} provider={p} size={20} />)}
                          {file.storedAcross.length > 2 && <span className="muted small">+{file.storedAcross.length - 2}</span>}
                        </span>
                      </td>
                      <td className="muted small">{formatDateTime(file.createdAt)}</td>
                      <td>
                        <span className="actions">
                          <button
                            type="button"
                            className="btn-inline"
                            disabled={file.state !== 'completed'}
                            onClick={() => void actions.share(file, load)}
                          >
                            <ShareIcon size={14} aria-hidden="true" />
                            Share
                          </button>
                          <button type="button" className="btn-inline" onClick={() => actions.rename(file, load)}>
                            <Pencil size={14} aria-hidden="true" />
                            Rename
                          </button>
                          <button
                            type="button"
                            className="btn-inline btn-inline-danger"
                            disabled={file.state === 'deleted'}
                            onClick={() => actions.remove(file, load)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Delete
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        {/* ---- right rail: real storage usage only ---- */}
        <aside className="dash-rail">
          <section className="card">
            <h2>Storage Usage</h2>
            <p className="small muted">Across all providers</p>
            {storageKnown ? (
              <div className="donut-row">
                <Donut percent={usedPct} />
                <div className="donut-stats">
                  <span className="muted small">Used</span>
                  <strong>{formatBytes(storage!.usedBytes)}</strong>
                  <span className="muted small">Total quota</span>
                  <strong>{formatBytes(storage!.totalBytes)}</strong>
                  <span className="muted small">Reserved</span>
                  <strong>{formatBytes(storage!.reservedBytes)}</strong>
                </div>
              </div>
            ) : (
              <p className="muted small">
                Unknown — no verified quota yet.
                {storage?.lastCheckedAt ? ` Last checked ${formatDateTime(storage.lastCheckedAt)}.` : ''}
              </p>
            )}
          </section>
          <section className="card">
            <h2>Uploads</h2>
            {summary && summary.activeJobs > 0 ? (
              <p className="small"><strong>{summary.activeJobs}</strong> active upload job(s)</p>
            ) : (
              <p className="muted small">No uploads in progress.</p>
            )}
            <button type="button" className="btn-secondary btn-block" onClick={() => onNavigate('Uploads')}>
              Open Uploads
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}

/** Token-coloured donut; the arc is real data, never decorative. */
function Donut({ percent }: { percent: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * circumference;
  return (
    <svg width="96" height="96" viewBox="0 0 88 88" role="img" aria-label={`${percent}% of quota used`}>
      <circle cx="44" cy="44" r={radius} fill="none" stroke="var(--cn-surface-muted)" strokeWidth="11" />
      <circle
        cx="44"
        cy="44"
        r={radius}
        fill="none"
        stroke="var(--cn-primary)"
        strokeWidth="11"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference - filled}`}
        transform="rotate(-90 44 44)"
      />
      <text x="44" y="42" textAnchor="middle" className="donut-value">{percent}%</text>
      <text x="44" y="58" textAnchor="middle" className="donut-label">used</text>
    </svg>
  );
}
