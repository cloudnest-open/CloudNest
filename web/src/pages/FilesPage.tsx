import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Files (Step 4 / M9.e).
 *
 * One row per logical file — never one row per chunk. Download, share and
 * delete are deliberately disabled here: they belong to Step 5 and the UI must
 * not offer controls that do not work yet.
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

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unknown';
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

const PROVIDER_LABELS: Record<string, string> = {
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  pcloud: 'pCloud',
  mega: 'MEGA',
};

export function FilesPage() {
  const [files, setFiles] = useState<FileView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'created'>('created');
  const [detail, setDetail] = useState<FileView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.listFiles(100, 0);
    if (res.status === 200) {
      const data = res.data as { files: FileView[]; total: number };
      setFiles(data.files ?? []);
      setTotal(data.total ?? 0);
      setError(null);
    } else {
      setError('Could not load the file list.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRename(file: FileView): Promise<void> {
    const next = window.prompt('New file name:', file.originalName);
    if (!next || next === file.originalName) return;
    setBusyId(file.id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.renameFile(file.id, next);
      if (res.status === 200) {
        setNotice(`Renamed to ${next}. Only the CloudNest metadata changed; provider objects were not moved.`);
        await load();
      } else {
        setError('The file could not be renamed.');
      }
    } finally {
      setBusyId(null);
    }
  }

  const visible = files
    .filter((f) => (search ? f.originalName.toLowerCase().includes(search.toLowerCase()) : true))
    .sort((a, b) => {
      if (sortBy === 'name') return a.originalName.localeCompare(b.originalName);
      if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
      return b.createdAt.localeCompare(a.createdAt);
    });

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Files</h1>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <section className="card">
        <div className="files-toolbar">
          <label htmlFor="files-search">Search</label>
          <input
            id="files-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by file name"
          />
          <label htmlFor="files-sort">Sort</label>
          <select id="files-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as 'name' | 'size' | 'created')}>
            <option value="created">Newest first</option>
            <option value="name">Name</option>
            <option value="size">Largest first</option>
          </select>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="muted">
            {total === 0 ? 'No files yet. Upload a file to see it here.' : 'No files match your search.'}
          </p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Chunks</th>
                <th>State</th>
                <th>Stored across</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((file) => (
                <tr key={file.id}>
                  <td className="ellipsis">{file.originalName}</td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td>
                    {file.chunkCount}
                    <div className="muted small">{formatBytes(file.chunkSizeBytes)} each</div>
                  </td>
                  <td>
                    <span className={`state state-${file.state === 'completed' ? 'ok' : file.state === 'failed' ? 'bad' : 'warn'}`}>
                      {file.state}
                    </span>
                  </td>
                  <td>
                    {file.storedAcross.length === 0 ? (
                      <span className="muted small">Not yet placed</span>
                    ) : (
                      file.storedAcross.map((p) => PROVIDER_LABELS[p] ?? p).join(', ')
                    )}
                  </td>
                  <td className="actions">
                    <button type="button" className="btn-secondary" onClick={() => setDetail(file)}>Details</button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={file.state !== 'completed' || busyId === file.id}
                      onClick={() => {
                        setNotice(`Starting download of ${file.originalName}. Your browser manages the transfer and resume.`);
                        window.location.assign(api.downloadUrl(file.id));
                      }}
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busyId === file.id}
                      onClick={() => void onRename(file)}
                    >
                      Rename
                    </button>
                    {/* still later-step features, shown as unavailable rather than faked */}
                    <button type="button" className="btn-secondary" disabled title="Available in a later step">Share</button>
                    <button type="button" className="btn-danger" disabled title="Available in a later step">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Downloads verify every chunk's checksum before any bytes are sent. Renaming changes metadata only and
          never moves provider objects. Sharing and deletion arrive in a later step and stay disabled here.
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
            <li><strong>Created:</strong> {new Date(detail.createdAt).toLocaleString()}</li>
            <li><strong>Completed:</strong> {detail.completedAt ? new Date(detail.completedAt).toLocaleString() : '—'}</li>
          </ul>
        </section>
      )}
    </>
  );
}
