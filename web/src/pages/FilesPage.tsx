import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, RefreshCw, Upload } from 'lucide-react';
import { api } from '../api.js';
import { FileTable, type FileTableRow } from '../components/FileTable.js';
import { EmptyState, SkeletonRows, formatBytes, formatDateTime, pageList, typeLabel } from '../components/ui.js';

/**
 * Files (design pack §8): one row per logical file — never one per chunk.
 *
 * Every action is real: Share opens the link dialog, Rename changes metadata
 * only, Delete runs the durable deletion with the destructive-confirmation
 * copy. Pagination is server-driven; the numbered footer shows the real total.
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
  createdAt: string;
  completedAt: string | null;
}

const PAGE_SIZE = 100;

export function FilesPage({ initialSearch = '' }: { initialSearch?: string } = {}) {
  const [files, setFiles] = useState<FileView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'size'>('modified');
  const [detail, setDetail] = useState<FileView | null>(null);
  // "All types" filter over the loaded rows; the label comes from real names.
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
        setError('Could not load the file list. Nothing is shown as an empty result while the API is failing.');
      }
    } catch {
      setError('Could not reach the server. Check that CloudNest is running, then retry.');
    } finally {
      setLoading(false);
    }
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

  const typeOptions = Array.from(new Set(files.map((f) => typeLabel(f.originalName)))).sort();
  const visible = files
    .filter((f) => (typeFilter === 'all' ? true : typeLabel(f.originalName) === typeFilter))
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
          <h1 className="page-title">Files</h1>
          <p className="muted">One row per CloudNest file. Chunk objects inside your providers are never listed as files.</p>
        </div>
        <div className="card-tools">
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} aria-hidden="true" />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <section className="card">
        <div className="card-head">
          <h2>All files</h2>
          <div className="card-tools">
            <input
              type="search"
              aria-label="Search files"
              placeholder="Search files..."
              value={search}
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
              <option value="modified">Sort by: Modified</option>
              <option value="name">Sort by: Name</option>
              <option value="size">Sort by: Size</option>
            </select>
          </div>
        </div>

        {loading && files.length === 0 ? (
          <SkeletonRows rows={4} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={search ? Folder : Upload}
            title={search ? 'No files match your search' : 'No files yet'}
            body={search ? 'Clear the search to see every file.' : 'Upload a file and it appears here as one logical file.'}
          />
        ) : (
          <FileTable
            rows={rows}
            reload={load}
            resetKey={`${page}|${typeFilter}`}
            footer={
              <div className="files-footer">
                <span className="muted small">
                  Showing {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + visible.length} of {total} files
                </span>
                <nav className="pagination" aria-label="Files pagination">
                  <button
                    type="button"
                    className="page-btn"
                    disabled={page === 0}
                    aria-label="Previous page"
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
                    aria-label="Next page"
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
          Downloads verify every chunk's checksum before any bytes are sent. Renaming changes metadata only and never
          moves provider objects. Deleting removes only the CloudNest-owned chunk objects and reports anything it could
          not confirm.
        </p>
      </section>

      {detail && (
        <section className="card">
          <div className="page-head">
            <h2>File details</h2>
            <button type="button" className="btn-secondary" onClick={() => setDetail(null)}>Close</button>
          </div>
          <ul className="plain-list">
            <li><strong>Name:</strong> {detail.originalName}</li>
            <li><strong>Size:</strong> {formatBytes(detail.sizeBytes)} ({detail.sizeBytes} bytes)</li>
            <li><strong>Type:</strong> {detail.mimeType ?? 'Unknown'}</li>
            <li><strong>Chunks:</strong> {detail.chunkCount} × {formatBytes(detail.chunkSizeBytes)}</li>
            <li><strong>State:</strong> {detail.state}</li>
            <li><strong>Stored across:</strong> {detail.storedAcross.length === 0 ? 'Not yet placed' : detail.storedAcross.join(', ')}</li>
            <li><strong>Created:</strong> {formatDateTime(detail.createdAt)}</li>
            <li><strong>Completed:</strong> {formatDateTime(detail.completedAt)}</li>
          </ul>
        </section>
      )}
    </>
  );
}
