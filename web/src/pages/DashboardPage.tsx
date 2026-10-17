import { useCallback, useEffect, useState } from 'react';
import {
  Cloud, CloudUpload, Database, FileText, Link as LinkIcon, Plus, Upload, RefreshCw, Activity,
} from 'lucide-react';
import { api } from '../api.js';
import { FileTable, type FileTableRow } from '../components/FileTable.js';
import { ProviderLogo } from '../components/ProviderLogo.js';
import {
  Badge, EmptyState, ProgressBar, SkeletonRows, pageList,
  formatBytes, formatDateTime, PROVIDER_LABELS,
} from '../components/ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Dashboard (reference spec §5): Reference 01's primary hierarchy — heading,
 * four real summary cards, the five always-present provider slots, the Recent
 * Files table with real server-side pagination, and a right rail with Recent
 * Activity (truthful empty state) above Storage Usage.
 *
 * Honesty rules enforced here: every number comes from the API, unknown/stale
 * quota renders as "Unknown"/"Not connected" (never 0 or invented), and an
 * unhealthy account can never be labelled "Connected". All copy resolves
 * through the app-wide i18n context.
 */

type Page = 'Files' | 'Uploads' | 'Cloud Accounts' | 'Shared Links';

interface AccountDetail {
  id: string;
  provider: string;
  displayLabel: string;
  status: string;
  quotaStatus: string;
  quotaUnlimited: boolean;
  quotaScopeKey: string | null;
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
  /** Phase 3: present only in the member-scoped summary response. */
  userUsage?: { usedBytes: number; allowanceBytes: number | null } | null;
}

interface DisplayStorage {
  totalBytes: number | null;
  usedBytes: number | null;
  reservedBytes: number;
  usableBytes: number | null;
  lastCheckedAt: string | null;
}

/** Collapse owner-confirmed quota pools to one conservative observation. */
function buildDisplayStorage(accounts: AccountDetail[], lastCheckedAt: string | null): DisplayStorage {
  const known = accounts.filter((account) =>
    account.status === 'connected' && account.quotaStatus === 'current' && account.usableBytes !== null &&
    account.quotaTotalBytes !== null && account.quotaUsedBytes !== null
  );
  const rows: Array<{ total: number; used: number; reserve: number; usable: number }> = known
    .filter((account) => account.quotaScopeKey === null)
    .map((account) => ({
      total: account.quotaTotalBytes!,
      used: account.quotaUsedBytes!,
      reserve: account.reserveBytes,
      usable: account.usableBytes!,
    }));

  const scopes = new Map<string, AccountDetail[]>();
  for (const account of accounts) {
    if (!account.quotaScopeKey) continue;
    const key = `${account.provider}:${account.quotaScopeKey}`;
    scopes.set(key, [...(scopes.get(key) ?? []), account]);
  }
  for (const members of scopes.values()) {
    const observations = members.filter((account) => known.includes(account));
    if (observations.length === 0) continue;
    const observation = observations.reduce((leastFree, account) =>
      account.quotaTotalBytes! - account.quotaUsedBytes! < leastFree.quotaTotalBytes! - leastFree.quotaUsedBytes!
        ? account
        : leastFree
    );
    const free = Math.max(0, observation.quotaTotalBytes! - observation.quotaUsedBytes!);
    const reserve = Math.max(...members.map((account) => account.reserveBytes));
    const outstanding = members.reduce((sum, account) => sum + account.outstandingBytes, 0);
    rows.push({
      total: observation.quotaTotalBytes!,
      used: observation.quotaUsedBytes!,
      reserve,
      usable: Math.max(0, free - reserve - outstanding),
    });
  }

  const sum = (pick: (row: (typeof rows)[number]) => number): number | null =>
    rows.length === 0 ? null : rows.reduce((total, row) => total + pick(row), 0);
  const checks = known.map((account) => account.lastQuotaCheckAt).filter((value): value is string => value !== null).sort();
  return {
    totalBytes: sum((row) => row.total),
    usedBytes: sum((row) => row.used),
    reservedBytes: sum((row) => row.reserve) ?? 0,
    usableBytes: sum((row) => row.usable),
    lastCheckedAt: checks.at(-1) ?? lastCheckedAt,
  };
}

/** Reference 01's five provider slots, always present, in this exact order. */
const PROVIDER_ORDER = ['google_drive', 'dropbox', 'pcloud', 'mega', 'onedrive'] as const;

interface ProviderSlot {
  provider: string;
  label: string;
  status: 'ok' | 'warn' | 'bad' | 'muted';
  statusKey: 'connected' | 'error' | 'needsAttention' | 'notConnected' | 'quotaStale';
  usedBytes: number | null;
  totalBytes: number | null;
  unlimited: boolean;
  experimental: boolean;
  action: 'connect' | 'manage';
  /** Phase 5 §4.5: derived reliability badge + the latest quota check. */
  health?: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  lastCheckAt?: string | null;
}

function buildProviderSlots(accounts: AccountDetail[]): ProviderSlot[] {
  return PROVIDER_ORDER.map((provider) => {
    const label = PROVIDER_LABELS[provider] ?? provider;
    const list = accounts.filter((a) => a.provider === provider);
    if (list.length === 0) {
      return {
        provider, label,
        status: 'muted', statusKey: 'notConnected',
        usedBytes: null, totalBytes: null,
        unlimited: false,
        experimental: provider === 'mega',
        action: 'connect',
      } as ProviderSlot;
    }
    const hasError = list.some((a) => a.status === 'error');
    const needsReauth = list.some((a) => a.status === 'needs_reauth');
    const allDisconnected = list.every((a) => a.status === 'disconnected');
    let status: ProviderSlot['status'] = 'ok';
    let statusKey: ProviderSlot['statusKey'] = 'connected';
    if (hasError) { status = 'bad'; statusKey = 'error'; }
    else if (needsReauth) { status = 'warn'; statusKey = 'needsAttention'; }
    else if (allDisconnected) { status = 'muted'; statusKey = 'notConnected'; }
    else if (list.some((a) => a.quotaStatus !== 'current')) { status = 'warn'; statusKey = 'quotaStale'; }
    // Only show a provider total when every account has a fresh, numeric quota.
    // Owner-confirmed shared scopes count once; the least-free fresh observation
    // is used when members report slightly different values.
    const unlimited = list.some((a) => a.status === 'connected' && a.quotaStatus === 'current' && a.quotaUnlimited);
    const fullyKnown = !unlimited && list.every((a) =>
      a.status === 'connected' && a.quotaStatus === 'current' &&
      typeof a.quotaTotalBytes === 'number' && typeof a.quotaUsedBytes === 'number'
    );
    const uniqueQuotas = new Map<string, AccountDetail>();
    if (fullyKnown) {
      for (const account of list) {
        const key = account.quotaScopeKey ? `scope:${account.quotaScopeKey}` : `account:${account.id}`;
        const current = uniqueQuotas.get(key);
        const free = (account.quotaTotalBytes ?? 0) - (account.quotaUsedBytes ?? 0);
        const currentFree = current
          ? (current.quotaTotalBytes ?? 0) - (current.quotaUsedBytes ?? 0)
          : Number.POSITIVE_INFINITY;
        if (!current || free < currentFree) uniqueQuotas.set(key, account);
      }
    }
    const quotaRows = [...uniqueQuotas.values()];
    const usedBytes = fullyKnown ? quotaRows.reduce((sum, a) => sum + (a.quotaUsedBytes ?? 0), 0) : null;
    const totalBytes = fullyKnown ? quotaRows.reduce((sum, a) => sum + (a.quotaTotalBytes ?? 0), 0) : null;
    return {
      provider, label, status, statusKey,
      usedBytes, totalBytes,
      unlimited,
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

export function DashboardPage({ onNavigate, isMember = false }: { onNavigate: (page: Page) => void; isMember?: boolean }) {
  const { t, tf, plural } = useI18n();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Recent Files: a real, server-paged window over the whole library.
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [fileSearch, setFileSearch] = useState('');
  const [appliedFileSearch, setAppliedFileSearch] = useState('');
  // Roadmap Phase 5 (§4.5): per-provider health behind the provider cards.
  // Admin-only data — members never fetch (or see) it.
  const [providerHealth, setProviderHealth] = useState<Record<string, { health: string; lastCheckAt: string | null }> | null>(null);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    // FE-04: network failures become a visible, recoverable error state
    try {
      const res = await api.dashboardSummary();
      if (res.status === 200) {
        setSummary(res.data as Summary);
        setError(null);
      } else {
        setError(t.dashboard.errorLoad);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user-driven; a language change must not re-fetch
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const res = await api.providerHealth();
      if (res.status !== 200) {
        setProviderHealth(null);
        return;
      }
      const body = res.data as { providers: Array<{ provider: string; health: string; lastCheckAt: string | null }> };
      const map: Record<string, { health: string; lastCheckAt: string | null }> = {};
      for (const row of body.providers ?? []) map[row.provider] = { health: row.health, lastCheckAt: row.lastCheckAt };
      setProviderHealth(map);
    } catch {
      // the badge is additive: a failed read just hides it
      setProviderHealth(null);
    }
  }, []);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);
    setFiles([]);
    setFilesTotal(0);
    try {
      const res = await api.listFiles(RECENT_PAGE_SIZE, page * RECENT_PAGE_SIZE, appliedFileSearch);
      if (res.status === 200) {
        const data = res.data as { files: RecentFile[]; total: number };
        setFiles(data.files ?? []);
        setFilesTotal(data.total ?? 0);
      } else {
        setFilesError(t.files.errorLoad);
      }
    } catch {
      setFilesError(t.common.errorNetwork);
    } finally {
      setFilesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads follow page/search changes
  }, [page, appliedFileSearch]);

  useEffect(() => {
    void loadSummary();
    // §4.5: the health badge rides the same reload cycle (admin only)
    if (!isMember) void loadHealth();
  }, [loadSummary, loadHealth, isMember]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(0);
      setAppliedFileSearch(fileSearch.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [fileSearch]);

  const reloadAll = useCallback(() => {
    void loadSummary();
    void loadFiles();
  }, [loadSummary, loadFiles]);

  function onSearchChange(value: string): void {
    setFileSearch(value);
  }

  const accounts = summary?.accountsDetailed ?? [];
  // the member-scoped summary omits pool-level fields entirely — optional
  // chaining keeps their dashboard rendering without them
  const storage = summary ? buildDisplayStorage(accounts, summary.storage?.lastCheckedAt ?? null) : undefined;
  const storageUnlimited = accounts.some((account) =>
    account.provider !== 'mega' && account.status === 'connected' && account.quotaStatus === 'current' && account.quotaUnlimited
  );
  const connected = accounts.filter((a) => a.status === 'connected').length;
  const attention = accounts.filter((a) => a.status !== 'connected' || a.quotaStatus !== 'current').length;
  const slots = buildProviderSlots(accounts).map((slot) => {
    const health = providerHealth?.[slot.provider];
    return health
      ? { ...slot, health: health.health as ProviderSlot['health'], lastCheckAt: health.lastCheckAt }
      : slot;
  });

  const fileRows: FileTableRow[] = files.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    sizeBytes: f.sizeBytes,
    state: f.state,
    storedAcross: f.storedAcross,
    modifiedAt: f.completedAt ?? f.createdAt,
  }));

  const totalPages = Math.max(1, Math.ceil(filesTotal / RECENT_PAGE_SIZE));

  const storageKnown = !storageUnlimited && Boolean(storage) && storage!.usableBytes !== null && storage!.totalBytes !== null;
  const usedPct = storageKnown && (storage!.totalBytes ?? 0) > 0
    ? Math.min(100, Math.round(((storage!.usedBytes ?? 0) / storage!.totalBytes!) * 100))
    : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t.dashboard.title}</h1>
          <p className="muted">{t.dashboard.subtitle}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={reloadAll} disabled={loading || filesLoading}>
          <RefreshCw size={15} aria-hidden="true" />
          {loading || filesLoading ? t.common.refreshing : t.common.refresh}
        </button>
      </div>

      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <div className="dash-grid">
        <div className="dash-main">
          {/* ---- summary cards ---- */}
          <div className="metric-grid">
            {!isMember && (
            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><Cloud size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">{t.dashboard.metric.accounts}</span>
                <span className="metric-value">{accounts.length === 0 ? '—' : `${connected} / ${accounts.length}`}</span>
                {accounts.length === 0 ? (
                  <span className="small muted">{t.dashboard.metric.accountsNone}</span>
                ) : attention === 0 ? (
                  <span className="metric-sub ok"><span className="status-dot status-ok" aria-hidden="true" />{t.dashboard.metric.allConnected}</span>
                ) : (
                  <span className="metric-sub warn"><span className="status-dot status-warn" aria-hidden="true" />{plural(t.dashboard.metric.needAttention, attention)}</span>
                )}
              </div>
            </section>
            )}

            {!isMember ? (
            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><Database size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">{t.dashboard.metric.storage}</span>
                <span className="metric-value">
                  {storageUnlimited
                    ? t.accounts.sharedPool.unlimitedLabel
                    : storageKnown
                      ? formatBytes(storage!.usableBytes)
                      : t.common.unknown}
                </span>
                {storageKnown ? (
                  <>
                    <span className="metric-row">
                      <span className="muted">{tf(t.dashboard.metric.ofTotal, { total: formatBytes(storage!.totalBytes) })}</span>
                      <span className="muted">{tf(t.dashboard.metric.pctFree, { pct: Math.max(0, 100 - usedPct) })}</span>
                    </span>
                    <ProgressBar value={usedPct} />
                  </>
                ) : (
                  <span className="small muted">
                    {accounts.length === 0
                      ? t.dashboard.metric.connectHint
                      : storage?.lastCheckedAt
                        ? tf(t.dashboard.metric.quotaUnverifiedWithTime, { when: formatDateTime(storage.lastCheckedAt) })
                        : t.dashboard.metric.quotaUnverified}
                  </span>
                )}
              </div>
            </section>
            ) : (
            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><Database size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">{t.memberUsage.used}</span>
                <span className="metric-value">
                  {formatBytes(summary?.userUsage?.usedBytes ?? 0)}
                </span>
                <span className="small muted">
                  {summary?.userUsage?.allowanceBytes == null
                    ? t.memberUsage.unlimited
                    : tf(t.memberUsage.usedOf, {
                        used: formatBytes(summary.userUsage.usedBytes),
                        allowance: formatBytes(summary.userUsage.allowanceBytes),
                      })}
                </span>
              </div>
            </section>
            )}

            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><FileText size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">{t.dashboard.metric.files}</span>
                <span className="metric-value">{summary?.totalFiles ?? 0}</span>
                <span className="small muted">{t.dashboard.metric.filesSub}</span>
              </div>
            </section>

            {isMember ? (
            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><CloudUpload size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">{t.memberUsage.uploadsActive}</span>
                <span className="metric-value">{summary?.activeJobs ?? 0}</span>
                <span className="small muted">{t.memberUsage.uploadsActiveSub}</span>
              </div>
            </section>
            ) : (
            <section className="card metric-card">
              <span className="metric-icon" aria-hidden="true"><LinkIcon size={20} /></span>
              <div className="metric-text">
                <span className="metric-label">{t.dashboard.metric.links}</span>
                <span className="metric-value">{summary?.activeShareLinks ?? 0}</span>
                <span className="small muted">{t.dashboard.metric.linksSub}</span>
              </div>
            </section>
            )}
          </div>

          {/* ---- provider slots: five cards, always present (reference 01).
              Members never see the pool view: accounts and quotas are the
              owner's knowledge (roadmap Phase 3). ---- */}
          {!isMember && (
          <>
          <h2 className="section-title">{t.dashboard.providersTitle}</h2>
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
                      {slot.experimental && <Badge tone="warn">{t.dashboard.experimental}</Badge>}
                    </div>
                    <p className="small muted">
                      {known
                        ? tf(t.dashboard.slot.usedOf, { used: formatBytes(slot.usedBytes), total: formatBytes(slot.totalBytes) })
                        : slot.unlimited
                          ? t.accounts.sharedPool.unlimitedLabel
                          : slot.action === 'connect'
                            ? t.dashboard.slot.notConnectedYet
                            : t.dashboard.slot.capacityUnknown}
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
                      {t.dashboard.slot[slot.statusKey]}
                    </p>
                    {/* Phase 5 §4.5: the honest reliability badge — derived from
                        real error counters and account states, never invented. */}
                    {slot.health && slot.health !== 'unconfigured' && (
                      <p className="small muted provider-health">
                        <span
                          className={`status-dot status-${slot.health === 'healthy' ? 'ok' : slot.health === 'degraded' ? 'warn' : 'down'}`}
                          aria-hidden="true"
                        />
                        {t.dashboard.health[slot.health]}
                        {slot.lastCheckAt && (
                          <span> · {tf(t.dashboard.health.lastCheck, { when: formatDateTime(slot.lastCheckAt) })}</span>
                        )}
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn-secondary btn-block"
                      onClick={() => onNavigate('Cloud Accounts')}
                    >
                      {slot.action === 'connect' ? t.dashboard.slot.connect : t.dashboard.slot.manage}
                    </button>
                  </section>
                );
              })}
            </div>
          )}
          </>
          )}

          {/* ---- recent files: real server-paged table ---- */}
          <section className="card">
            <div className="card-head">
              <h2>{t.dashboard.recent.title}</h2>
              <div className="card-tools">
                <input
                  type="search"
                  aria-label={t.dashboard.recent.searchLabel}
                  placeholder={t.dashboard.recent.searchPlaceholder}
                  value={fileSearch}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
                <button type="button" className="btn-secondary" onClick={() => onNavigate('Files')}>
                  {t.dashboard.recent.viewAll}
                </button>
              </div>
            </div>

            {filesError ? (
              <div className="error-card" role="alert">
                <p>{filesError}</p>
                <button type="button" className="btn-secondary" onClick={() => void loadFiles()} disabled={filesLoading}>
                  <RefreshCw size={15} aria-hidden="true" />
                  {filesLoading ? t.common.refreshing : t.common.refresh}
                </button>
              </div>
            ) : filesLoading && files.length === 0 ? (
              <SkeletonRows rows={4} />
            ) : fileRows.length === 0 ? (
              <EmptyState
                icon={Upload}
                title={appliedFileSearch ? t.dashboard.recent.emptyFilteredTitle : t.dashboard.recent.emptyTitle}
                body={appliedFileSearch
                  ? t.dashboard.recent.emptyFilteredBody
                  : t.dashboard.recent.emptyBody}
              >
                {!appliedFileSearch && (
                  <button type="button" className="btn-primary" onClick={() => onNavigate('Uploads')}>
                    <Upload size={15} aria-hidden="true" />
                    {t.dashboard.recent.uploadCta}
                  </button>
                )}
              </EmptyState>
            ) : (
              <FileTable
                rows={fileRows}
                reload={reloadAll}
                resetKey={`${page}|${appliedFileSearch}`}
                footer={
                  <div className="files-footer">
                    <span className="muted small">
                      {tf(t.common.showingRange, {
                        from: page * RECENT_PAGE_SIZE + 1,
                        to: page * RECENT_PAGE_SIZE + fileRows.length,
                        total: filesTotal,
                      })}
                    </span>
                    <nav className="pagination" aria-label={t.dashboard.recent.paginationAria}>
                      <button
                        type="button"
                        className="page-btn"
                        disabled={page === 0 || filesLoading}
                        aria-label={t.common.previousPage}
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
                        aria-label={t.common.nextPage}
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
              <h2>{t.dashboard.activity.title}</h2>
            </div>
            {/* No activity/audit event source exists yet; the card and its slot
                stay present with a truthful empty state (reference spec §1.5). */}
            <EmptyState
              icon={Activity}
              title={t.dashboard.activity.emptyTitle}
              body={t.dashboard.activity.emptyBody}
            />
          </section>
          <section className="card">
            <h2>{t.dashboard.storage.title}</h2>
            <p className="small muted">{t.dashboard.storage.acrossProviders}</p>
            {storageKnown ? (
              <div className="donut-row">
                <Donut percent={usedPct} />
                <div className="donut-stats">
                  <span className="muted small">{t.dashboard.storage.used}</span>
                  <strong>{formatBytes(storage!.usedBytes)}</strong>
                  <span className="muted small">{t.dashboard.storage.totalQuota}</span>
                  <strong>{formatBytes(storage!.totalBytes)}</strong>
                  <span className="muted small">{t.dashboard.storage.reserved}</span>
                  <strong>{formatBytes(storage!.reservedBytes)}</strong>
                </div>
              </div>
            ) : (
              <p className="muted small">
                {storageUnlimited ? t.accounts.sharedPool.unlimitedLabel : t.dashboard.storage.unknown}
                {!storageUnlimited && storage?.lastCheckedAt ? ` ${tf(t.dashboard.storage.lastChecked, { when: formatDateTime(storage.lastCheckedAt) })}` : ''}
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
  const { t, tf } = useI18n();
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * circumference;
  return (
    <svg width="96" height="96" viewBox="0 0 88 88" role="img" aria-label={tf(t.dashboard.donut.aria, { pct: percent })}>
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
      <text x="44" y="58" textAnchor="middle" className="donut-label">{t.dashboard.donut.used}</text>
    </svg>
  );
}
