import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { confirmDestructive } from '../confirm.js';
import { useFileActions } from '../components/FileActionsProvider.js';
import { Badge, formatBytes, formatDateTime } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * Shared Links (Step 5 / M11.e).
 *
 * The raw URL is shown exactly once at creation — the server keeps only a hash,
 * so it can never be displayed again. Revoking a link never deletes the file.
 * All copy resolves through the app-wide i18n context.
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

export function SharedLinksPage() {
  const { t, tf } = useI18n();
  const actions = useFileActions();
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

  const shareStateLabel = (state: string): string =>
    (t.states.share as Record<string, string | undefined>)[state] ?? state;

  const load = useCallback(async () => {
    // FE-04: surface a real error instead of leaving the page half-empty
    try {
      const [l, f] = await Promise.all([api.listShareLinks(), api.listFiles(100, 0)]);
      if (l.status === 200) setLinks((l.data as { links: LinkView[] }).links ?? []);
      if (f.status === 200) setFiles((f.data as { files: FileView[] }).files ?? []);
      if (l.status !== 200 && f.status !== 200) {
        setError(t.shares.errorLoad);
      } else {
        setError(null);
      }
    } catch {
      setError(t.common.errorNetwork);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user-driven; a language change must not re-fetch
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
      setError(t.shares.create.selectOne);
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
        setNotice(t.shares.create.success);
        setPassword('');
        setSelected([]);
        setExpiresAt('');
        setDownloadLimit('');
        await load();
      } else {
        setError(t.shares.create.failed);
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    const ok = await confirmDestructive(
      t.shares.revoke.message,
      { title: t.shares.revoke.title, confirmLabel: t.shares.revoke.confirmLabel },
    );
    if (!ok) return;
    const res = await api.revokeShareLink(id);
    if (res.status === 200) {
      setNotice(t.shares.revoke.success);
      await load();
    } else {
      setError(t.shares.revoke.failed);
    }
  }

  async function rotate(id: string): Promise<void> {
    const ok = await confirmDestructive(
      t.shares.rotate.message,
      { title: t.shares.rotate.title, confirmLabel: t.shares.rotate.confirmLabel },
    );
    if (!ok) return;
    const res = await api.rotateShareLink(id);
    if (res.status === 200) {
      setCreatedUrl((res.data as { url: string }).url);
      setNotice(t.shares.rotate.success);
      await load();
    } else {
      setError(t.shares.rotate.failed);
    }
  }

  function removeFile(file: FileView): void {
    // the shared provider owns the exact destructive copy and the durable job
    actions.remove(
      { id: file.id, originalName: file.originalName, sizeBytes: file.sizeBytes, state: file.state },
      load,
    );
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t.shares.title}</h1>
        <button type="button" className="btn-secondary" onClick={() => void load()}>{t.common.refresh}</button>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      {createdUrl && (
        <section className="card">
          <h2>{t.shares.newUrl}</h2>
          <div className="copy-row">
            <code className="callback-uri">{createdUrl}</code>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(createdUrl).then(
                  () => setNotice(t.shares.urlCopied),
                  () => setNotice(t.shares.copyFailed),
                );
              }}
            >
              {t.common.copy}
            </button>
          </div>
          <p className="muted small">{t.shares.shownOnce}</p>
        </section>
      )}

      <section className="card">
        <h2>{t.shares.create.title}</h2>
        <p className="muted">{t.shares.create.desc}</p>
        {shareable.length === 0 ? (
          <p className="muted">{t.shares.create.noneAvailable}</p>
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
              <label htmlFor="share-password">{t.shares.create.password}</label>
              <input id="share-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <label htmlFor="share-expiry">{t.shares.create.expiry}</label>
              <input id="share-expiry" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              <label htmlFor="share-limit">{t.shares.create.limit}</label>
              <input id="share-limit" type="number" min={1} value={downloadLimit} onChange={(e) => setDownloadLimit(e.target.value)} />
            </div>
            <div className="actions">
              <button type="button" className="btn-primary" disabled={busy || selected.length === 0} onClick={() => void create()}>
                {busy ? t.shares.create.creating : t.shares.create.submit}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>{t.shares.list.title}</h2>
        {links.length === 0 ? (
          <p className="muted">{t.shares.list.none}</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>{t.shares.list.state}</th>
                <th>{t.shares.list.files}</th>
                <th>{t.shares.list.usage}</th>
                <th>{t.shares.list.policy}</th>
                <th>{t.shares.list.actions}</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td><Badge tone={link.state === 'active' ? 'ok' : 'muted'}>{shareStateLabel(link.state)}</Badge></td>
                  <td>{link.fileCount}</td>
                  <td>
                    {link.downloadLimit !== null
                      ? tf(t.shares.list.withLimit, { count: link.downloadCount, limit: link.downloadLimit })
                      : tf(t.shares.list.unlimited, { count: link.downloadCount })}
                  </td>
                  <td className="muted small">
                    {link.hasPassword ? t.shares.list.passwordProtected : t.shares.list.noPassword}
                    {link.expiresAt ? ` · ${tf(t.shares.list.expires, { when: formatDateTime(link.expiresAt) })}` : ''}
                  </td>
                  <td className="actions">
                    <button type="button" className="btn-secondary" disabled={link.state !== 'active'} onClick={() => void rotate(link.id)}>{t.shares.list.rotate}</button>
                    <button type="button" className="btn-danger" disabled={link.state !== 'active'} onClick={() => void revoke(link.id)}>{t.shares.list.revoke}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{t.shares.footnote}</p>
      </section>

      <section className="card">
        <h2>{t.shares.deleteSection.title}</h2>
        <p className="muted">{t.shares.deleteSection.desc}</p>
        {files.length === 0 ? (
          <p className="muted">{t.shares.deleteSection.none}</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>{t.shares.deleteSection.file}</th>
                <th>{t.shares.deleteSection.size}</th>
                <th>{t.shares.deleteSection.state}</th>
                <th>{t.shares.deleteSection.actions}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td className="ellipsis">{file.originalName}</td>
                  <td>{formatBytes(file.sizeBytes)}</td>
                  <td><Badge tone={file.state === 'completed' ? 'ok' : file.state === 'deleted' ? 'muted' : 'warn'}>{shareStateLabel(file.state)}</Badge></td>
                  <td className="actions">
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={file.state === 'deleted'}
                      onClick={() => void removeFile(file)}
                    >
                      {t.shares.deleteSection.delete}
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
