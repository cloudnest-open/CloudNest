import { useCallback, useEffect, useState } from 'react';
import { Folder, Pencil, RefreshCw, Share2 as ShareIcon, Trash2, Upload } from 'lucide-react';
import { api } from '../api.js';
import { useFileActions } from '../components/FileActionsProvider.js';
import {
  Badge, EmptyState, ProviderTile, SkeletonRows, TypeIcon, formatBytes, formatDateTime, PROVIDER_LABELS,
} from '../components/ui.js';

/**
 * Files (design pack §8): one row per logical file — never one per chunk.
 *
 * Every action is real: Share creates a link (one-time URL dialog), Rename
 * changes metadata only, Delete runs the durable deletion with the exact
 * destructive-confirmation copy. Nothing else is offered as a button.
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

export function FilesPage({ initialSearch = '' }: { initialSearch?: string } = {}) {
  const actions = useFileActions();
  const [files, setFiles] = useState<FileView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'size'>('modified');
  const [detail, setDetail] = useState<FileView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.listFiles(100, 0);
    if (res.status === 200) {
      const data = res.data as { files: FileView[]; total: number };
      setFiles(data.files ?? []);
      setTotal(data.total ?? 0);
      setError(null);
    } else {
      setError('Could not load the file list. Nothing is shown as an empty result while the API is failing.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = files
    .filter((f) => (search ? f.originalName.toLowerCase().includes(search.toLowerCase()) : true))
    .sort((a, b) => {
      if (sortBy === 'name') return a.originalName.localeCompare(b.originalName);
      if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    });

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
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Chunks</th>
                <th>Stored in</th>
                <th>Last modified</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((file) => (
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
                    {file.chunkCount}
                    <div className="muted small">{formatBytes(file.chunkSizeBytes)} each</div>
                  </td>
                  <td>
                    <span className="file-name-cell">
                      {file.storedAcross.length === 0 ? (
                        <span className="muted small">Not yet placed</span>
                      ) : (
                        <>
                          {file.storedAcross.slice(0, 2).map((p) => <ProviderTile key={p} provider={p} size={20} />)}
                          <span className="muted small">
                            {file.storedAcross.length === 1
                              ? PROVIDER_LABELS[file.storedAcross[0]!] ?? file.storedAcross[0]
                              : file.storedAcross.length > 2
                                ? `${file.storedAcross.length} cloud accounts`
                                : file.storedAcross.map((p) => PROVIDER_LABELS[p] ?? p).join(' + ')}
                          </span>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="muted small">{formatDateTime(file.completedAt ?? file.createdAt)}</td>
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
                      <button type="button" className="btn-inline" onClick={() => setDetail(file)}>
                        Details
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <li><strong>Stored across:</strong> {detail.storedAcross.length === 0 ? 'Not yet placed' : detail.storedAcross.map((p) => PROVIDER_LABELS[p] ?? p).join(', ')}</li>
            <li><strong>Created:</strong> {formatDateTime(detail.createdAt)}</li>
            <li><strong>Completed:</strong> {formatDateTime(detail.completedAt)}</li>
          </ul>
        </section>
      )}
    </>
  );
}
