import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { confirmDestructive } from '../confirm.js';
import { Badge, RowMenu, RowMenuItem, formatBytes, formatDateTime, pageList, SkeletonRows } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';
import { useUiMode } from '../ui-mode-context.js';

/**
 * Shared Links (Step 5 / M11.e).
 *
 * The raw URL is shown exactly once at creation — the server keeps only a hash,
 * so it can never be displayed again. File selection uses the same global
 * server search and pagination as Files; file deletion stays in Files.
 */

interface LinkView {
  id: string;
  state: string;
  expiresAt: string | null;
  downloadLimit: number | null;
  downloadCount: number;
  hasPassword: boolean;
  fileCount: number;
  firstFileName: string | null;
  createdAt: string;
}

interface FileView {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
}

const FILE_PAGE_SIZE = 10;

export function SharedLinksPage() {
  const { t, tf, plural } = useI18n();
  // mode = complete context: links and the shareable file picker follow the
  // active tier (a link shows where it carries at least one tier-matching file)
  const { uiMode } = useUiMode();
  const tier = uiMode ?? 'personal';
  const [links, setLinks] = useState<LinkView[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileView[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [appliedFileSearch, setAppliedFileSearch] = useState('');
  const [filePage, setFilePage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [downloadLimit, setDownloadLimit] = useState('');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdUrlContext, setCreatedUrlContext] = useState<'create' | 'rotate' | null>(null);
  const createdUrlRef = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);

  const shareStateLabel = (state: string): string =>
    (t.states.share as Record<string, string | undefined>)[state] ?? state;

  const loadLinks = useCallback(async () => {
    setLinksLoading(true);
    setLinksError(null);
    try {
      const res = await api.listShareLinks(tier);
      if (res.status === 200) {
        setLinks((res.data as { links: LinkView[] }).links ?? []);
      } else {
        setLinksError(t.shares.errorLoad);
      }
    } catch {
      setLinksError(t.common.errorNetwork);
    } finally {
      setLinksLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- user-triggered reloads need not refetch on locale changes
  }, [tier]);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);
    setFiles([]);
    setFilesTotal(0);
    try {
      const res = await api.listFiles(FILE_PAGE_SIZE, filePage * FILE_PAGE_SIZE, appliedFileSearch, undefined, tier);
      if (res.status === 200) {
        const data = res.data as { files: FileView[]; total: number };
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
  }, [filePage, appliedFileSearch, tier]);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilePage(0);
      setAppliedFileSearch(fileSearch.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [fileSearch]);

  const totalPages = Math.max(1, Math.ceil(filesTotal / FILE_PAGE_SIZE));

  useEffect(() => {
    if (!createdUrl || !createdUrlContext) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = createdUrlRef.current;
      if (!panel) return;
      panel.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'nearest',
      });
      panel.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [createdUrl, createdUrlContext]);

  function toggle(fileId: string): void {
    setSelected((prev) => (prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]));
  }

  async function copyUrl(url: string): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setNotice(t.shares.urlCopied);
    } catch {
      setNotice(t.shares.copyFailed);
    }
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
    setCreatedUrlContext(null);
    try {
      const res = await api.createShareLink({
        fileIds: selected,
        ...(password ? { password } : {}),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        downloadLimit: downloadLimit ? Number(downloadLimit) : null,
      });
      if (res.status === 201) {
        setCreatedUrl((res.data as { url: string }).url);
        setCreatedUrlContext('create');
        setPassword('');
        setSelected([]);
        setExpiresAt('');
        setDownloadLimit('');
        await loadLinks();
      } else {
        setError(t.shares.create.failed);
      }
    } catch {
      setError(t.common.errorNetwork);
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
    setLinkBusyId(id);
    setError(null);
    try {
      const res = await api.revokeShareLink(id);
      if (res.status === 200) {
        setNotice(t.shares.revoke.success);
        await loadLinks();
      } else {
        setError(t.shares.revoke.failed);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLinkBusyId(null);
    }
  }

  async function rotate(id: string): Promise<void> {
    const ok = await confirmDestructive(
      t.shares.rotate.message,
      { title: t.shares.rotate.title, confirmLabel: t.shares.rotate.confirmLabel },
    );
    if (!ok) return;
    setLinkBusyId(id);
    setError(null);
    setNotice(null);
    setCreatedUrl(null);
    setCreatedUrlContext(null);
    try {
      const res = await api.rotateShareLink(id);
      if (res.status === 200) {
        setCreatedUrl((res.data as { url: string }).url);
        setCreatedUrlContext('rotate');
        await loadLinks();
      } else {
        setError(t.shares.rotate.failed);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLinkBusyId(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t.shares.title}</h1>
        <button
          type="button"
          className="btn-secondary"
          disabled={linksLoading || filesLoading}
          onClick={() => { void loadLinks(); void loadFiles(); }}
        >
          {linksLoading || filesLoading ? t.common.refreshing : t.common.refresh}
        </button>
      </div>

      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>{t.shares.create.title}</h2>
            <p className="muted">{t.shares.create.desc}</p>
          </div>
          <input
            type="search"
            aria-label={t.files.searchLabel}
            placeholder={t.files.searchPlaceholder}
            value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)}
          />
        </div>

        {filesError && <div className="error-card" role="alert"><p>{filesError}</p></div>}
        {filesError ? null : filesLoading && files.length === 0 ? (
          <SkeletonRows rows={3} />
        ) : files.length === 0 ? (
          <p className="muted">{appliedFileSearch ? t.files.emptySearchBody : t.shares.create.noneAvailable}</p>
        ) : (
          <>
            {selected.length > 0 && <p className="muted small">{plural(t.table.selected, selected.length)}</p>}
            <ul className="plain-list share-file-picker">
              {files.map((file) => {
                const canShare = file.state === 'completed';
                const stateLabel = (t.states.file as Record<string, string | undefined>)[file.state] ?? file.state;
                return (
                  <li key={file.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(file.id)}
                        disabled={!canShare}
                        aria-label={tf(t.table.selectOneAria, { name: file.originalName })}
                        onChange={() => toggle(file.id)}
                      />
                      <span className="share-file-name" title={file.originalName}>{file.originalName}</span>
                      <span className="muted small">{formatBytes(file.sizeBytes)}</span>
                      {!canShare && <Badge tone={file.state === 'deleted' ? 'muted' : 'warn'}>{stateLabel}</Badge>}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="files-footer">
              <span className="muted small">
                {tf(t.common.showingRange, {
                  from: filePage * FILE_PAGE_SIZE + 1,
                  to: filePage * FILE_PAGE_SIZE + files.length,
                  total: filesTotal,
                })}
              </span>
              <nav className="pagination" aria-label={t.files.paginationAria}>
                <button
                  type="button"
                  className="page-btn"
                  disabled={filePage === 0 || filesLoading}
                  aria-label={t.common.previousPage}
                  onClick={() => setFilePage((p) => Math.max(0, p - 1))}
                >‹</button>
                {pageList(filePage + 1, totalPages).map((page, i) => page === 'gap' ? (
                  <span key={`gap-${i}`} className="pagination-gap" aria-hidden="true">…</span>
                ) : (
                  <button
                    key={page}
                    type="button"
                    className={`page-btn${page === filePage + 1 ? ' active' : ''}`}
                    aria-current={page === filePage + 1 ? 'page' : undefined}
                    disabled={filesLoading}
                    onClick={() => setFilePage(page - 1)}
                  >{page}</button>
                ))}
                <button
                  type="button"
                  className="page-btn"
                  disabled={filePage + 1 >= totalPages || filesLoading}
                  aria-label={t.common.nextPage}
                  onClick={() => setFilePage((p) => Math.min(totalPages - 1, p + 1))}
                >›</button>
              </nav>
            </div>
          </>
        )}

        <div className="share-rules-form">
          <div className="share-rule-field">
            <label htmlFor="share-password">{t.shares.create.password}</label>
            <input id="share-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="share-rule-field">
            <label htmlFor="share-expiry">{t.shares.create.expiry}</label>
            <input id="share-expiry" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="share-rule-field">
            <label htmlFor="share-limit">{t.shares.create.limit}</label>
            <input id="share-limit" type="number" min={1} value={downloadLimit} onChange={(e) => setDownloadLimit(e.target.value)} />
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn-primary" disabled={busy || selected.length === 0} onClick={() => void create()}>
            {busy ? t.shares.create.creating : t.shares.create.submit}
          </button>
        </div>
        {createdUrl && createdUrlContext === 'create' && (
          <section ref={createdUrlRef} className="share-created-url" tabIndex={-1} aria-labelledby="share-created-url-title">
            <h3 id="share-created-url-title">{t.shares.newUrl}</h3>
            <div className="copy-row">
              <code className="callback-uri">{createdUrl}</code>
              <button type="button" className="btn-secondary" onClick={() => void copyUrl(createdUrl)}>{t.common.copy}</button>
            </div>
            <p className="muted small">{t.shares.shownOnce}</p>
          </section>
        )}
      </section>

      <section className="card">
        <h2>{t.shares.list.title}</h2>
        {linksError && <div className="error-card" role="alert"><p>{linksError}</p></div>}
        {linksError ? null : linksLoading && links.length === 0 ? (
          <SkeletonRows rows={2} />
        ) : links.length === 0 ? (
          <p className="muted">{t.shares.list.none}</p>
        ) : (
          <div className="table-scroll-container">
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
                  <td>
                    <span className="ellipsis" title={link.firstFileName ?? undefined}>
                      {link.firstFileName ?? t.common.unknown}
                      {link.fileCount > 1 ? ` ${tf(t.shares.list.moreFiles, { count: link.fileCount - 1 })}` : ''}
                    </span>
                  </td>
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
                    <RowMenu label={t.shares.list.actions}>
                      <RowMenuItem disabled={link.state !== 'active' || linkBusyId !== null} onSelect={() => void rotate(link.id)}>{t.shares.list.rotate}</RowMenuItem>
                      <RowMenuItem danger disabled={link.state !== 'active' || linkBusyId !== null} onSelect={() => void revoke(link.id)}>{t.shares.list.revoke}</RowMenuItem>
                    </RowMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {createdUrl && createdUrlContext === 'rotate' && (
          <section ref={createdUrlRef} className="share-created-url" tabIndex={-1} aria-labelledby="share-rotated-url-title">
            <h3 id="share-rotated-url-title">{t.shares.newUrl}</h3>
            <div className="copy-row">
              <code className="callback-uri">{createdUrl}</code>
              <button type="button" className="btn-secondary" onClick={() => void copyUrl(createdUrl)}>{t.common.copy}</button>
            </div>
            <p className="muted small">{t.shares.shownOnce}</p>
          </section>
        )}
        <p className="muted small">{t.shares.footnote}</p>
      </section>
    </>
  );
}
