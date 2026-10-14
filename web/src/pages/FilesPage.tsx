import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { confirmDestructive } from '../confirm.js';

/**
 * Files (Step 4 / M9.e, completed in Step 6 / M12).
 *
 * One row per logical file — never one row per chunk. Download, rename, share
 * and delete all work from here; deletion follows the same durable,
 * verified-outcome flow as the Shared Links page.
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
  const [shareUrl, setShareUrl] = useState<string | null>(null);

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

  /**
   * Create a single-file share link with the saved Sharing defaults. The raw
   * URL is shown once; the server keeps only a hash of the token.
   */
  async function onShare(file: FileView): Promise<void> {
    setBusyId(file.id);
    setError(null);
    setNotice(null);
    setShareUrl(null);
    try {
      const res = await api.createShareLink({ fileIds: [file.id] });
      if (res.status === 201) {
        setShareUrl((res.data as { url: string }).url);
        setNotice('Link created with your saved Sharing defaults. The URL below is shown only once — copy it now.');
      } else {
        const body = res.data as { code?: string };
        setError(
          body.code === 'share_password_required_by_policy'
            ? 'Your Sharing settings require a password for new links. Create the link from the Shared Links page, where you can set one.'
            : `The link could not be created (${body.code ?? 'unknown'}).`,
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  /** Durable deletion: revokes shares, deletes only CloudNest-owned objects, reports the real outcome. */
  async function onDelete(file: FileView): Promise<void> {
    if (!(await confirmDestructive(
      `Delete "${file.originalName}"?\n\nThis removes the CloudNest-owned chunk objects from your connected accounts. ` +
      'Any share links for it are revoked first. Provider objects that cannot be confirmed deleted are reported as pending.',
    ))) return;
    setBusyId(file.id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.deleteFile(file.id);
      if (res.status === 202) {
        const jobId = (res.data as { jobId: string }).jobId;
        // drive it to a terminal state so the owner sees the real outcome
        const retry = await api.retryDeletion(jobId);
        const state = retry.status === 200
          ? (retry.data as { result?: { state?: string } }).result?.state ?? 'unknown'
          : 'unknown';
        setNotice(
          state === 'completed'
            ? 'Deletion completed: every CloudNest-owned chunk object is confirmed gone.'
            : 'Deletion is still pending: some objects could not be confirmed deleted. The obligation is recorded and can be retried.',
        );
        await load();
      } else {
        setError('Could not queue that deletion.');
      }
    } finally {
      setBusyId(null);
    }
  }

  const visible = files    .filter((f) => (search ? f.originalName.toLowerCase().includes(search.toLowerCase()) : true))
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

      {shareUrl && (
        <section className="card">
          <h2>New link URL</h2>
          <div className="copy-row">
            <code className="callback-uri">{shareUrl}</code>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl).then(
                  () => setNotice('URL copied.'),
                  () => setNotice('Copy failed; select the URL and copy it manually.'),
                );
              }}
            >
              Copy
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShareUrl(null)}>Dismiss</button>
          </div>
          <p className="muted small">
            This URL cannot be shown again — CloudNest stores only a hash of the token. Rotate or revoke links on the
            Shared Links page.
          </p>
        </section>
      )}

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
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={file.state !== 'completed' || busyId === file.id}
                      onClick={() => void onShare(file)}
                    >
                      Share
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={file.state === 'deleted' || busyId === file.id}
                      onClick={() => void onDelete(file)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Downloads verify every chunk's checksum before any bytes are sent. Renaming changes metadata only and
          never moves provider objects. Sharing creates a link with your saved defaults; deleting removes only the
          CloudNest-owned chunk objects and reports anything it could not confirm.
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
