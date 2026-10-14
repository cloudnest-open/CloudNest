import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { confirmDestructive } from '../confirm.js';

/**
 * Shared Links (Step 5 / M11.e).
 *
 * The raw URL is shown exactly once at creation — the server keeps only a hash,
 * so it can never be displayed again. Revoking a link never deletes the file.
 */

interface LinkView {
  id: string;
  state: string;
  expiresAt: string | null;
  downloadLimit: number | null;
  downloadCount: number;
  hasPassword: boolean;
  fileCount: number;
  createdAt: string;
}

interface FileView {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
}

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

export function SharedLinksPage() {
  const [links, setLinks] = useState<LinkView[]>([]);
  const [files, setFiles] = useState<FileView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [downloadLimit, setDownloadLimit] = useState('');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletion, setDeletion] = useState<{ fileId: string; jobId: string; state: string } | null>(null);

  const load = useCallback(async () => {
    const [l, f] = await Promise.all([api.listShareLinks(), api.listFiles(100, 0)]);
    if (l.status === 200) setLinks((l.data as { links: LinkView[] }).links ?? []);
    if (f.status === 200) setFiles((f.data as { files: FileView[] }).files ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shareable = files.filter((f) => f.state === 'completed');

  function toggle(fileId: string): void {
    setSelected((prev) => (prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]));
  }

  async function create(): Promise<void> {
    if (selected.length === 0) {
      setError('Select at least one completed file to share.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setCreatedUrl(null);
    try {
      const res = await api.createShareLink({
        fileIds: selected,
        ...(password ? { password } : {}),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        downloadLimit: downloadLimit ? Number(downloadLimit) : null,
      });
      if (res.status === 201) {
        setCreatedUrl((res.data as { url: string }).url);
        setNotice('Link created. The URL below is shown only once — copy it now.');
        setPassword('');
        setSelected([]);
        setExpiresAt('');
        setDownloadLimit('');
        await load();
      } else {
        setError('The link could not be created.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    if (!(await confirmDestructive('Revoke this link? Anyone holding the URL will lose access immediately. The files are not deleted.'))) return;
    const res = await api.revokeShareLink(id);
    if (res.status === 200) {
      setNotice('Link revoked. The stored files were not deleted.');
      await load();
    } else {
      setError('Could not revoke that link.');
    }
  }

  async function rotate(id: string): Promise<void> {
    if (!(await confirmDestructive('Rotate this link? The old URL stops working immediately and a new URL is issued once.'))) return;
    const res = await api.rotateShareLink(id);
    if (res.status === 200) {
      setCreatedUrl((res.data as { url: string }).url);
      setNotice('Link rotated. The previous URL no longer works.');
      await load();
    } else {
      setError('Could not rotate that link.');
    }
  }

  async function removeFile(file: FileView): Promise<void> {
    if (!(await confirmDestructive(
      `Delete "${file.originalName}"?\n\nThis removes the CloudNest-owned chunk objects from your connected accounts. ` +
      'Any share links for it are revoked first. Provider objects that cannot be confirmed deleted are reported as pending.',
    ))) return;
    setError(null);
    const res = await api.deleteFile(file.id);
    if (res.status === 202) {
      const jobId = (res.data as { jobId: string }).jobId;
      setDeletion({ fileId: file.id, jobId, state: 'queued' });
      // drive it to a terminal state so the owner sees the real outcome
      const retry = await api.retryDeletion(jobId);
      if (retry.status === 200) {
        const state = (retry.data as { result?: { state?: string } }).result?.state ?? 'unknown';
        setDeletion({ fileId: file.id, jobId, state });
        setNotice(
          state === 'completed'
            ? 'Deletion completed: every CloudNest-owned chunk object is confirmed gone.'
            : 'Deletion is still pending: some objects could not be confirmed deleted. The obligation is recorded and can be retried.',
        );
      }
      await load();
    } else {
      setError('Could not queue that deletion.');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Shared Links</h1>
        <button type="button" className="btn-secondary" onClick={() => void load()}>Refresh</button>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      {createdUrl && (
        <section className="card">
          <h2>New link URL</h2>
          <div className="copy-row">
            <code className="callback-uri">{createdUrl}</code>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(createdUrl).then(
                  () => setNotice('URL copied.'),
                  () => setNotice('Copy failed; select the URL and copy it manually.'),
                );
              }}
            >
              Copy
            </button>
          </div>
          <p className="muted small">
            This URL cannot be shown again — CloudNest stores only a hash of the token. If you lose it, rotate the link.
          </p>
        </section>
      )}

      <section className="card">
        <h2>Create a link</h2>
        <p className="muted">Select one or more completed files. A collection link lists them individually; ZIP bundles are not part of V1.</p>
        {shareable.length === 0 ? (
          <p className="muted">No completed files are available to share yet.</p>
        ) : (
          <>
            <ul className="plain-list">
              {shareable.map((file) => (
                <li key={file.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(file.id)}
                      onChange={() => toggle(file.id)}
                    />{' '}
                    {file.originalName} — {formatBytes(file.sizeBytes)}
                  </label>
                </li>
              ))}
            </ul>
            <div className="upload-form">
              <label htmlFor="share-password">Optional password (min 12 characters)</label>
              <input id="share-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <label htmlFor="share-expiry">Optional expiry</label>
              <input id="share-expiry" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              <label htmlFor="share-limit">Optional download limit</label>
              <input id="share-limit" type="number" min={1} value={downloadLimit} onChange={(e) => setDownloadLimit(e.target.value)} />
            </div>
            <div className="actions">
              <button type="button" className="btn-primary" disabled={busy || selected.length === 0} onClick={() => void create()}>
                {busy ? 'Creating…' : 'Create link'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Existing links</h2>
        {links.length === 0 ? (
          <p className="muted">No share links yet.</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Files</th>
                <th>Usage</th>
                <th>Policy</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td><span className={`state state-${link.state === 'active' ? 'ok' : 'muted'}`}>{link.state}</span></td>
                  <td>{link.fileCount}</td>
                  <td>
                    {link.downloadCount}
                    {link.downloadLimit !== null ? ` / ${link.downloadLimit}` : ' (unlimited)'}
                  </td>
                  <td className="muted small">
                    {link.hasPassword ? 'Password protected' : 'No password'}
                    {link.expiresAt ? ` · expires ${new Date(link.expiresAt).toLocaleString()}` : ''}
                  </td>
                  <td className="actions">
                    <button type="button" className="btn-secondary" disabled={link.state !== 'active'} onClick={() => void rotate(link.id)}>Rotate</button>
                    <button type="button" className="btn-danger" disabled={link.state !== 'active'} onClick={() => void revoke(link.id)}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Revoking or rotating a link never deletes your stored files.</p>
      </section>

      <section className="card">
        <h2>Delete a file</h2>
        <p className="muted">
          Deletion removes only the chunk objects CloudNest placed, inside its own provider folder. Share links for the
          file are revoked first. Anything that cannot be confirmed deleted stays recorded as pending.
        </p>
        {deletion && (
          <p className="muted small">
            Last deletion: job {deletion.jobId.slice(0, 8)}… — state <strong>{deletion.state}</strong>
          </p>
        )}
        {files.length === 0 ? (
          <p className="muted">No files recorded.</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td className="ellipsis">{file.originalName}</td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td><span className={`state state-${file.state === 'completed' ? 'ok' : file.state === 'deleted' ? 'muted' : 'warn'}`}>{file.state}</span></td>
                  <td className="actions">
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={file.state === 'deleted'}
                      onClick={() => void removeFile(file)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
