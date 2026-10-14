import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cloud, Database, FileText, Link as LinkIcon, Plus, Upload, RefreshCw, Activity,
} from 'lucide-react';
import { api } from '../api.js';
import { FileTable, type FileTableRow } from '../components/FileTable.js';
import { ProviderLogo } from '../components/ProviderLogo.js';
import {
  Badge, EmptyState, ProgressBar, SkeletonRows, pageList,
  formatBytes, formatDateTime, PROVIDER_LABELS, typeLabel,
} from '../components/ui.js';

/**
 * Dashboard (reference spec §5): Reference 01's primary hierarchy — heading,
 * four real summary cards, the five always-present provider slots, the Recent
 * Files table with real server-side pagination, and a right rail with Recent
 * Activity (truthful empty state) above Storage Usage.
 *
 * Honesty rules enforced here: every number comes from the API, unknown/stale
 * quota renders as "Unknown"/"Not connected" (never 0 or invented), and an
 * unhealthy account can never be labelled "Connected".
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
  recentFileList: Array<{
    id: string;
    originalName: string;
    sizeBytes: number;
    state: string;
    storedAcross: string[];
    createdAt: string;
  }>;
}

/** Reference 01's five provider slots, always present, in this exact order. */
const PROVIDER_ORDER = ['google_drive', 'dropbox', 'pcloud', 'mega', 'onedrive'] as const;

interface ProviderSlot {
  provider: string;
  label: string;
  status: 'ok' | 'warn' | 'bad' | 'muted';
  statusLabel: string;
  usedBytes: number | null;
  totalBytes: number | null;
  experimental: boolean;
  action: 'connect' | 'manage';
}

function buildProviderSlots(accounts: AccountDetail[]): ProviderSlot[] {
  return PROVIDER_ORDER.map((provider) => {
    const label = PROVIDER_LABELS[provider] ?? provider;
    const list = accounts.filter((a) => a.provider === provider);
    if (list.length === 0) {
      return {
        provider, label,
        status: 'muted', statusLabel: 'Not connected',
        usedBytes: null, totalBytes: null,
        experimental: provider === 'mega',
        action: 'connect',
      };
    }
    const hasError = list.some((a) => a.status === 'error');
    const needsReauth = list.some((a) => a.status === 'needs_reauth');
    const allDisconnected = list.every((a) => a.status === 'disconnected');
    let status: ProviderSlot['status'] = 'ok';
    let statusLabel = 'Connected';
    if (hasError) { status = 'bad'; statusLabel = 'Error — check account'; }
    else if (needsReauth) { status = 'warn'; statusLabel = 'Needs attention'; }
    else if (allDisconnected) { status = 'muted'; statusLabel = 'Not connected'; }
    else if (list.some((a) => a.quotaStatus !== 'current')) { status = 'warn'; statusLabel = 'Quota not refreshed'; }
    // Aggregate the provider's accounts only when every quota figure is known;
    // partial data must never be presented as a complete quota.
    const fullyKnown = list.every(
      (a) => typeof a.quotaTotalBytes === 'number' && typeof a.quotaUsedBytes === 'number',
    );
    const usedBytes = fullyKnown ? list.reduce((sum, a) => sum + (a.quotaUsedBytes ?? 0), 0) : null;
    const totalBytes = fullyKnown ? list.reduce((sum, a) => sum + (a.quotaTotalBytes ?? 0), 0) : null;
    return {
      provider, label, status, statusLabel,
      usedBytes, totalBytes,
      experimental: provider === 'mega',
      action: allDisconnected ? 'connect' : 'manage',
    };
  });
}

interface RecentFile {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
  storedAcross: string[];
  createdAt: string;
  completedAt: string | null;
}

const RECENT_PAGE_SIZE = 5;

export function DashboardPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Recent Files: a real, server-paged window over the whole library.
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [fileSearch, setFileSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'size'>('modified');

  const loadSummary = useCallback(async () => {
    setLoading(true);
    // FE-04: network failures become a visible, recoverable error state
    try {
      const res = await api.dashboardSummary();
      if (res.status === 200) {
        setSummary(res.data as Summary);
        setError(null);
      } else {
        setError('Could not load the dashboard. The server did not answer with real data.');
      }
    } catch {
      setError('Could not reach the server. Check that CloudNest is running, then retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await api.listFiles(RECENT_PAGE_SIZE, page * RECENT_PAGE_SIZE, fileSearch.trim());
      if (res.status === 200) {
        const data = res.data as { files: RecentFile[]; total: number };
        setFiles(data.files ?? []);
        setFilesTotal(data.total ?? 0);
      } else {
        setFiles([]);
        setFilesTotal(0);
      }
    } catch {
      setFiles([]);
      setFilesTotal(0);
    } finally {
      setFilesLoading(false);
    }
  }, [page, fileSearch]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const reloadAll = useCallback(() => {
    void loadSummary();
    void loadFiles();
  }, [loadSummary, loadFiles]);

  const searchTimer = useRef<number | null>(null);
  function onSearchChange(value: string): void {
    setFileSearch(value);
    setPage(0);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => void loadFiles(), 250);
  }

  const storage = summary?.storage;
  const accounts = summary?.accountsDetailed ?? [];
  const healthy = accounts.filter((a) => a.status === 'connected' && a.quotaStatus === 'current').length;
  const attention = accounts.length - healthy;
  const slots = buildProviderSlots(accounts);

  const typeOptions = Array.from(new Set(files.map((f) => typeLabel(f.originalName)))).sort();
  const visible = files
    .filter((f) => (typeFilter === 'all' ? true : typeLabel(f.originalName) === typeFilter))
    .sort((a, b) => {
      if (sortBy === 'name') return a.originalName.localeCompare(b.originalName);
      if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
      return ((b.completedAt ?? b.createdAt) ?? '').localeCompare((a.completedAt ?? a.createdAt) ?? '');
    });

  const fileRows: FileTableRow[] = visible.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    sizeBytes: f.sizeBytes,
    state: f.state,
    storedAcross: f.storedAcross,
    modifiedAt: f.completedAt ?? f.createdAt,
  }));

  const totalPages = Math.max(1, Math.ceil(filesTotal / RECENT_PAGE_SIZE));

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
        <button type="button" className="btn-secondary" onClick={reloadAll} disabled={loading || filesLoading}>
          <RefreshCw size={15} aria-hidden="true" />
          {loading || filesLoading ? 'Refreshing…' : 'Refresh'}
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

          {/* ---- provider slots: five cards, always present (reference 01) ---- */}
          <h2 className="section-title">Cloud Provider Accounts</h2>
          {loading && accounts.length === 0 ? (
            <section className="card"><SkeletonRows rows={2} /></section>
          ) : (
            <div className="provider-grid">
              {slots.map((slot) => {
                const known = slot.usedBytes !== null && slot.totalBytes !== null && slot.totalBytes > 0;
                return (
                  <section className="provider-card" key={slot.provider}>
                    <div className="provider-card-head">
                      <span className="provider-id">
                        <ProviderLogo provider={slot.provider} size={24} />
                        <strong>{slot.label}</strong>
                      </span>
                      {slot.experimental && <Badge tone="warn">Experimental</Badge>}
                    </div>
                    <p className="small muted">
                      {known
                        ? `${formatBytes(slot.usedBytes)} used of ${formatBytes(slot.totalBytes)}`
                        : slot.action === 'connect'
                          ? 'Not connected yet'
                          : 'Capacity unknown — refresh the quota on Cloud Accounts.'}
                    </p>
                    {known && (
                      <ProgressBar
                        value={Math.min(100, ((slot.usedBytes ?? 0) / (slot.totalBytes ?? 1)) * 100)}
                        tone="success"
                      />
                    )}
                    <p className={`small provider-status status-text-${slot.status}`}>
                      <span
                        className={`status-dot status-${slot.status === 'bad' ? 'down' : slot.status === 'ok' ? 'ok' : slot.status === 'warn' ? 'warn' : 'muted'}`}
                        aria-hidden="true"
                      />
                      {slot.statusLabel}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary btn-block"
                      onClick={() => onNavigate('Cloud Accounts')}
                    >
                      {slot.action === 'connect' ? 'Connect' : 'Manage'}
                    </button>
                  </section>
                );
              })}
            </div>
          )}

          {/* ---- recent files: real server-paged table ---- */}
          <section className="card">
            <div className="card-head">
              <h2>Recent Files</h2>
              <div className="card-tools">
                <input
                  type="search"
                  aria-label="Search files"
                  placeholder="Search files..."
                  value={fileSearch}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
                <select
                  aria-label="Filter by type"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="all">All Types</option>
                  {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select
                  aria-label="Sort files"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'modified' | 'name' | 'size')}
                >
                  <option value="modified">Sort by: Modified (Newest)</option>
                  <option value="name">Sort by: Name</option>
                  <option value="size">Sort by: Size</option>
                </select>
                <button type="button" className="btn-secondary" onClick={() => onNavigate('Files')}>
                  View all
                </button>
              </div>
            </div>

            {filesLoading && files.length === 0 ? (
              <SkeletonRows rows={4} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Upload}
                title={fileSearch || typeFilter !== 'all' ? 'No files match your filters' : 'No files yet'}
                body={fileSearch || typeFilter !== 'all'
                  ? 'Clear the search or type filter to see more files.'
                  : 'Upload a file and it will appear here as one logical file.'}
              >
                {!fileSearch && typeFilter === 'all' && (
                  <button type="button" className="btn-primary" onClick={() => onNavigate('Uploads')}>
                    <Upload size={15} aria-hidden="true" />
                    Upload files
                  </button>
                )}
              </EmptyState>
            ) : (
              <FileTable
                rows={fileRows}
                reload={reloadAll}
                resetKey={`${page}|${typeFilter}|${fileSearch}`}
                footer={
                  <div className="files-footer">
                    <span className="muted small">
                      {typeFilter === 'all'
                        ? `Showing ${page * RECENT_PAGE_SIZE + 1}–${page * RECENT_PAGE_SIZE + visible.length} of ${filesTotal} files`
                        : `${visible.length} of ${filesTotal} files match “${typeFilter}” on this page`}
                    </span>
                    <nav className="pagination" aria-label="Recent files pagination">
                      <button
                        type="button"
                        className="page-btn"
                        disabled={page === 0 || filesLoading}
                        aria-label="Previous page"
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                      >
                        ‹
                      </button>
                      {pageList(page + 1, totalPages).map((p, i) =>
                        p === 'gap' ? (
                          <span key={`gap-${i}`} className="pagination-gap" aria-hidden="true">…</span>
                        ) : (
                          <button
                            key={p}
                            type="button"
                            className={`page-btn${p === page + 1 ? ' active' : ''}`}
                            aria-current={p === page + 1 ? 'page' : undefined}
                            onClick={() => setPage(p - 1)}
                          >
                            {p}
                          </button>
                        ),
                      )}
                      <button
                        type="button"
                        className="page-btn"
                        disabled={page + 1 >= totalPages || filesLoading}
                        aria-label="Next page"
                        onClick={() => setPage((p) => p + 1)}
                      >
                        ›
                      </button>
                    </nav>
                  </div>
                }
              />
            )}
          </section>
        </div>

        {/* ---- right rail: Recent Activity above Storage Usage (reference 01) ---- */}
        <aside className="dash-rail">
          <section className="card">
            <div className="card-head">
              <h2>Recent Activity</h2>
            </div>
            {/* No activity/audit event source exists yet; the card and its slot
                stay present with a truthful empty state (reference spec §1.5). */}
            <EmptyState
              icon={Activity}
              title="No recent activity yet"
              body="Uploads, downloads and account events will appear here."
            />
          </section>
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
      <circle cx="44" cy="44" r={radius} fill="none" stroke="var(--cn-surface-muted)" strokeWidth="9" />
      <circle
        cx="44"
        cy="44"
        r={radius}
        fill="none"
        stroke="var(--cn-primary)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference - filled}`}
        transform="rotate(-90 44 44)"
      />
      <text x="44" y="42" textAnchor="middle" className="donut-value">{percent}%</text>
      <text x="44" y="58" textAnchor="middle" className="donut-label">used</text>
    </svg>
  );
}
