import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, RefreshCw, Upload } from 'lucide-react';
import { api } from '../api.js';
import { FileTable, type FileTableRow } from '../components/FileTable.js';
import { EmptyState, SkeletonRows, formatBytes, formatDateTime, fileTypeName, fileTypeDisplay, pageList } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Files (design pack §8): one row per logical file — never one per chunk.
 *
 * Every action is real: Share opens the link dialog, Rename changes metadata
 * only, Delete runs the durable deletion with the destructive-confirmation
 * copy. Pagination is server-driven; the numbered footer shows the real total.
 * All copy resolves through the app-wide i18n context.
 */

interface FileView {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string | null;
  chunkCount: number;
  chunkSizeBytes: number;
  state: string;
  storedAcross: string[];
  /** Task §5.B: which storage accounts currently make this file not fully usable. */
  storageHealth?: { status: 'ok' | 'account_unavailable'; unavailable: Array<{ accountId: string; label: string; accountStatus: string }> };
  createdAt: string;
  completedAt: string | null;
}

const PAGE_SIZE = 100;

export function FilesPage({ initialSearch = '', onGoToCloudAccounts }: { initialSearch?: string; onGoToCloudAccounts?: () => void } = {}) {
  const { t, tf } = useI18n();
  const [files, setFiles] = useState<FileView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'size'>('modified');
  const [detail, setDetail] = useState<FileView | null>(null);
  // "All types" filter over the loaded rows; the value is the locale-
  // independent type key, the label is localized.
  const [typeFilter, setTypeFilter] = useState('all');
  // FE-13: server-driven pagination so the library is not silently capped at
  // the first 100 rows.
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    // FE-04: a rejected fetch must surface a recoverable error, never a
    // permanent skeleton with no explanation.
    try {
      const res = await api.listFiles(PAGE_SIZE, page * PAGE_SIZE, search.trim());
      if (res.status === 200) {
        const data = res.data as { files: FileView[]; total: number };
        setFiles(data.files ?? []);
        setTotal(data.total ?? 0);
        setError(null);
      } else {
        setError(t.files.errorLoad);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user-driven; a language change must not re-fetch
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // FE-13: the search box now drives the SERVER-side search; going back to an
  // empty query shows the whole library again. Page resets on a new search.
  const searchTimer = useRef<number | null>(null);
  function onSearchChange(value: string): void {
    setSearch(value);
    setPage(0);
    setTypeFilter('all');
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => void load(), 250);
  }

  const typeOptions = Array.from(new Set(files.map((f) => fileTypeName(f.originalName)))).sort();
  const visible = files
    .filter((f) => (typeFilter === 'all' ? true : fileTypeName(f.originalName) === typeFilter))
    .sort((a, b) => {
      if (sortBy === 'name') return a.originalName.localeCompare(b.originalName);
      if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    });

  const rows: FileTableRow[] = visible.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    sizeBytes: f.sizeBytes,
    state: f.state,
    storedAcross: f.storedAcross,
    modifiedAt: f.completedAt ?? f.createdAt,
    needsReconnect: f.storageHealth?.status === 'account_unavailable',
    unavailableLabels: (f.storageHealth?.unavailable ?? []).map((u) => u.label),
  }));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function goTo(next: number): void {
    setPage(next);
    window.scrollTo({ top: 0 });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t.files.title}</h1>
          <p className="muted">{t.files.subtitle}</p>
        </div>
        <div className="card-tools">
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} aria-hidden="true" />
            {loading ? t.common.refreshing : t.common.refresh}
          </button>
        </div>
      </div>

      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <section className="card">
        <div className="card-head">
          <h2>{t.files.allFiles}</h2>
          <div className="card-tools">
            <input
              type="search"
              aria-label={t.files.searchLabel}
              placeholder={t.files.searchPlaceholder}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <select
              aria-label={t.files.filterLabel}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">{t.files.filterAll}</option>
              {typeOptions.map((key) => <option key={key} value={key}>{fileTypeDisplay(key)}</option>)}
            </select>
            <select
              aria-label={t.files.sortLabel}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'modified' | 'name' | 'size')}
            >
              <option value="modified">{t.files.sortModified}</option>
              <option value="name">{t.files.sortName}</option>
              <option value="size">{t.files.sortSize}</option>
            </select>
          </div>
        </div>

        {loading && files.length === 0 ? (
          <SkeletonRows rows={4} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={search ? Folder : Upload}
            title={search ? t.files.emptySearchTitle : t.files.emptyTitle}
            body={search ? t.files.emptySearchBody : t.files.emptyBody}
          />
        ) : (
          <FileTable
            rows={rows}
            reload={load}
            resetKey={`${page}|${typeFilter}`}
            onDetails={(row) => {
              const found = files.find((f) => f.id === row.id);
              if (found) setDetail(found);
            }}
            footer={
              <div className="files-footer">
                <span className="muted small">
                  {tf(t.common.showingRange, {
                    from: page * PAGE_SIZE + 1,
                    to: page * PAGE_SIZE + visible.length,
                    total,
                  })}
                </span>
                <nav className="pagination" aria-label={t.files.paginationAria}>
                  <button
                    type="button"
                    className="page-btn"
                    disabled={page === 0}
                    aria-label="‹"
                    onClick={() => goTo(page - 1)}
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
                        onClick={() => goTo(p - 1)}
                      >
                        {p}
                      </button>
                    ),
                  )}
                  <button
                    type="button"
                    className="page-btn"
                    disabled={page + 1 >= totalPages}
                    aria-label="›"
                    onClick={() => goTo(page + 1)}
                  >
                    ›
                  </button>
                </nav>
              </div>
            }
          />
        )}

        <p className="muted small" style={{ marginTop: 12 }}>
          {t.files.footnote}
        </p>
      </section>

      {detail && (
        <section className="card">
          <div className="page-head">
            <h2>{t.files.details.title}</h2>
            <button type="button" className="btn-secondary" onClick={() => setDetail(null)}>{t.common.close}</button>
          </div>
          <ul className="plain-list">
            <li><strong>{t.files.details.nameLabel}</strong> {detail.originalName}</li>
            <li><strong>{t.files.details.sizeLabel}</strong> {formatBytes(detail.sizeBytes)} ({detail.sizeBytes} bytes)</li>
            <li><strong>{t.files.details.typeLabel}</strong> {detail.mimeType ?? t.common.unknown}</li>
            <li><strong>{t.files.details.chunksLabel}</strong> {tf(t.files.details.chunksValue, { count: detail.chunkCount, size: formatBytes(detail.chunkSizeBytes) })}</li>
            <li><strong>{t.files.details.stateLabel}</strong> {detail.state}</li>
            <li><strong>{t.files.details.storedAcrossLabel}</strong> {detail.storedAcross.length === 0 ? t.common.notPlaced : detail.storedAcross.join(', ')}</li>
            <li>
              <strong>{t.files.details.availabilityLabel}</strong>{' '}
              {detail.storageHealth?.status === 'account_unavailable' ? (
                <>
                  {tf(t.files.details.reconnectRequired, {
                    accounts: detail.storageHealth.unavailable.map((u) => u.label).join(', '),
                  })}
                  {onGoToCloudAccounts && (
                    <button type="button" className="btn-inline" style={{ marginLeft: 8 }} onClick={onGoToCloudAccounts}>
                      {t.files.details.goToCloudAccounts}
                    </button>
                  )}
                </>
              ) : (
                t.files.details.allAccountsOk
              )}
            </li>
            <li><strong>{t.files.details.createdLabel}</strong> {formatDateTime(detail.createdAt)}</li>
            <li><strong>{t.files.details.completedLabel}</strong> {formatDateTime(detail.completedAt)}</li>
          </ul>
        </section>
      )}
    </>
  );
}
