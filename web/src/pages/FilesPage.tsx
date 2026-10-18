import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight, Folder, FolderPlus, Pencil, RefreshCw, RotateCcw,
  Trash2, Upload,
} from 'lucide-react';
import { api } from '../api.js';
import { FileTable, type FileTableRow } from '../components/FileTable.js';
import { ConfirmDialog, Dialog, EmptyState, SkeletonRows, formatBytes, formatDateTime, pageList } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';
import { useUiMode } from '../ui-mode-context.js';

/**
 * Files (design pack §8, roadmap Phase 4 §4.4): a real folder tree with a
 * breadcrumb, plus the Trash tab. Folders are per-principal server state —
 * nothing here fakes a hierarchy. The trash is restorable for the retention
 * window the server reports; only a purge reaches the durable deletion engine.
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
  parentId?: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface FolderView {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  owned: boolean;
  counts: { folders: number; files: number };
}

interface TrashView {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
  storedAcross: string[];
  trashedAt: string;
}

interface Crumb { id: string; name: string }

const PAGE_SIZE = 100;

export function FilesPage({ initialSearch = '', onGoToCloudAccounts, onGoToUploads }: { initialSearch?: string; onGoToCloudAccounts?: () => void; onGoToUploads?: () => void } = {}) {
  const { t, tf, plural } = useI18n();
  // mode = complete context: this page never sees the other tier's rows
  const { uiMode } = useUiMode();
  const tier = uiMode ?? 'personal';
  const [view, setView] = useState<'files' | 'trash'>('files');
  const [files, setFiles] = useState<FileView[]>([]);
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [trashFiles, setTrashFiles] = useState<TrashView[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashRetentionDays, setTrashRetentionDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = useState(initialSearch.trim());
  const [detail, setDetail] = useState<FileView | null>(null);
  // The details panel renders at the end of the page; scrolling it into view
  // when it opens keeps the panel reachable from a row deep in the list.
  const detailsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (detail) detailsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [detail]);
  // FE-13: server-driven pagination so the library is not silently capped at
  // the first 100 rows.
  const [page, setPage] = useState(0);

  // folder dialogs
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderView | null>(null);
  const [renameFolderName, setRenameFolderName] = useState('');
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderView | null>(null);
  // trash confirmations
  const [purgeTarget, setPurgeTarget] = useState<TrashView | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);

  const searching = appliedSearch.trim().length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === 'trash') {
        const res = await api.listTrash(PAGE_SIZE, 0, tier);
        if (res.status === 200) {
          const data = res.data as { files: TrashView[]; total: number; retentionDays: number };
          setTrashFiles(data.files ?? []);
          setTrashTotal(data.total ?? 0);
          setTrashRetentionDays(data.retentionDays ?? 7);
        } else {
          setError(t.files.errorLoad);
        }
      } else if (searching) {
        // search stays global: it spans the whole (own) library, not one folder
        const res = await api.listFiles(PAGE_SIZE, page * PAGE_SIZE, appliedSearch, undefined, tier);
        if (res.status === 200) {
          const data = res.data as { files: FileView[]; total: number };
          setFiles(data.files ?? []);
          setTotal(data.total ?? 0);
          setFolders([]);
          setBreadcrumb([]);
        } else {
          setError(t.files.errorLoad);
        }
      } else {
        const [folderRes, filesRes] = await Promise.all([
          api.folderChildren(currentFolder === null ? 'root' : currentFolder, tier),
          api.listFiles(PAGE_SIZE, page * PAGE_SIZE, '', currentFolder === null ? 'root' : currentFolder, tier),
        ]);
        if (folderRes.status === 200 && filesRes.status === 200) {
          const folderData = folderRes.data as { folders: FolderView[]; breadcrumb: Crumb[] };
          const filesData = filesRes.data as { files: FileView[]; total: number };
          setFolders(folderData.folders ?? []);
          setBreadcrumb(folderData.breadcrumb ?? []);
          setFiles(filesData.files ?? []);
          setTotal(filesData.total ?? 0);
        } else {
          setError(t.files.errorLoad);
        }
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user-driven; a language change must not re-fetch
  }, [view, page, appliedSearch, currentFolder, searching, tier]);

  useEffect(() => {
    void load();
  }, [load]);

  // Search is global in the API; debounce it so typing doesn't issue a request
  // per keystroke or briefly show results for an older query.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(0);
      setAppliedSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  function onSearchChange(value: string): void {
    setSearch(value);
  }

  const rows: FileTableRow[] = files.map((f) => ({
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

  function openFolder(id: string | null): void {
    setCurrentFolder(id);
    setPage(0);
    setDetail(null);
  }

  async function createFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (name === '') { setNewFolderOpen(false); return; }
    setFolderBusy(true);
    setFolderError(null);
    try {
      const res = await api.createFolder(name, currentFolder, tier);
      if (res.status === 201) {
        setNewFolderOpen(false);
        setNewFolderName('');
        await load();
      } else {
        const body = res.data as { code?: string };
        setFolderError(tf(t.files.folders.nameError, { code: body.code ?? 'unknown' }));
      }
    } finally {
      setFolderBusy(false);
    }
  }

  async function renameFolder(): Promise<void> {
    const target = renameFolderTarget;
    if (!target) return;
    const name = renameFolderName.trim();
    if (name === '' || name === target.name) { setRenameFolderTarget(null); return; }
    setFolderBusy(true);
    setFolderError(null);
    try {
      const res = await api.renameFolder(target.id, name);
      if (res.status === 200) {
        setRenameFolderTarget(null);
        await load();
      } else {
        const body = res.data as { code?: string };
        setFolderError(tf(t.files.folders.nameError, { code: body.code ?? 'unknown' }));
      }
    } finally {
      setFolderBusy(false);
    }
  }

  async function deleteFolder(): Promise<void> {
    const target = deleteFolderTarget;
    if (!target) return;
    setFolderBusy(true);
    try {
      const res = await api.deleteFolder(target.id);
      if (res.status === 200) {
        setDeleteFolderTarget(null);
        await load();
      } else {
        const body = res.data as { code?: string };
        setFolderError(
          body.code === 'folder_not_empty'
            ? tf(t.files.folders.notEmpty, { name: target.name })
            : tf(t.files.folders.nameError, { code: body.code ?? 'unknown' }),
        );
        setDeleteFolderTarget(null);
      }
    } finally {
      setFolderBusy(false);
    }
  }

  async function restoreOne(file: TrashView): Promise<void> {
    const res = await api.restoreFile(file.id);
    if (res.status === 200) {
      await load();
    } else {
      const body = res.data as { code?: string };
      setError(tf(t.files.trash.restoreError, { code: body.code ?? 'unknown' }));
    }
  }

  async function purgeOne(): Promise<void> {
    const target = purgeTarget;
    if (!target) return;
    setPurgeTarget(null);
    const res = await api.purgeFile(target.id);
    if (res.status === 202) {
      // drive the durable job so the outcome is real, not just queued
      const jobId = (res.data as { jobId: string }).jobId;
      if (jobId) await api.retryDeletion(jobId);
      await load();
    } else {
      const body = res.data as { code?: string };
      setError(tf(t.files.trash.purgeError, { code: body.code ?? 'unknown' }));
    }
  }

  async function emptyTrash(): Promise<void> {
    setEmptyTrashOpen(false);
    const res = await api.emptyTrash();
    if (res.status === 200) {
      await load();
    } else {
      const body = res.data as { code?: string };
      setError(tf(t.files.trash.purgeError, { code: body.code ?? 'unknown' }));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t.files.title}</h1>
          <p className="muted">{t.files.subtitle}</p>
        </div>
        <div className="card-tools">
          {onGoToUploads && (
            <button type="button" className="btn-primary" onClick={onGoToUploads}>
              <Upload size={15} aria-hidden="true" />
              {t.dashboard.recent.uploadCta}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} aria-hidden="true" />
            {loading ? t.common.refreshing : t.common.refresh}
          </button>
        </div>
      </div>

      <div className="files-tabs" role="tablist" aria-label={t.files.viewAria}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'files'}
          className={`files-tab${view === 'files' ? ' active' : ''}`}
          onClick={() => { setView('files'); setPage(0); }}
        >
          {t.files.allFiles}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'trash'}
          className={`files-tab${view === 'trash' ? ' active' : ''}`}
          onClick={() => { setView('trash'); setPage(0); }}
        >
          {t.files.trash.tab}
        </button>
      </div>

      {view === 'files' ? (
        <section className="card">
          {!searching && (
            <nav className="breadcrumb" aria-label={t.files.folders.breadcrumbAria}>
              <button
                type="button"
                className={`crumb${currentFolder === null ? ' active' : ''}`}
                aria-current={currentFolder === null ? 'page' : undefined}
                onClick={() => openFolder(null)}
              >
                {t.files.folders.home}
              </button>
              {breadcrumb.map((crumb) => (
                <span key={crumb.id} className="crumb-segment">
                  <ChevronRight size={13} aria-hidden="true" className="muted" />
                  <button
                    type="button"
                    className={`crumb${currentFolder === crumb.id ? ' active' : ''}`}
                    aria-current={currentFolder === crumb.id ? 'page' : undefined}
                    onClick={() => openFolder(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
          )}

          <div className="card-head">
            <h2>{searching ? t.files.searchResultsTitle : currentFolder === null ? t.files.allFiles : breadcrumb[breadcrumb.length - 1]?.name ?? t.files.allFiles}</h2>
            <div className="card-tools">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => { setNewFolderName(''); setFolderError(null); setNewFolderOpen(true); }}
              >
                <FolderPlus size={15} aria-hidden="true" />
                {t.files.folders.newFolder}
              </button>
              <input
                type="search"
                aria-label={t.files.searchLabel}
                placeholder={t.files.searchPlaceholder}
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
          </div>

          {error ? (
            <div className="error-card" role="alert">
              <p>{error}</p>
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load()}>
                <RefreshCw size={15} aria-hidden="true" />
                {loading ? t.common.refreshing : t.common.refresh}
              </button>
            </div>
          ) : loading && files.length === 0 && folders.length === 0 ? (
            <SkeletonRows rows={4} />
          ) : !searching && folders.length === 0 && rows.length === 0 ? (
            <EmptyState
              icon={currentFolder === null ? Upload : Folder}
              title={currentFolder === null ? t.files.emptyTitle : t.files.folders.emptyTitle}
              body={currentFolder === null ? t.files.emptyBody : t.files.folders.emptyBody}
            >
              {currentFolder === null && onGoToUploads && (
                <button type="button" className="btn-primary" onClick={onGoToUploads}>
                  <Upload size={15} aria-hidden="true" />
                  {t.dashboard.recent.uploadCta}
                </button>
              )}
            </EmptyState>
          ) : (
            <>
              {folderError && <p className="form-error" role="alert">{folderError}</p>}
              {!searching && folders.length > 0 && (
                <ul className="folder-list">
                  {folders.map((folder) => (
                    <li key={folder.id} className="folder-row">
                      <button type="button" className="folder-open" onClick={() => openFolder(folder.id)}>
                        <Folder size={17} aria-hidden="true" />
                        <span className="ellipsis">{folder.name}</span>
                        <span className="muted small">
                          {tf(t.files.folders.itemCount, {
                            folders: plural(t.files.folders.foldersCount, folder.counts.folders),
                            files: plural(t.files.folders.filesCount, folder.counts.files),
                          })}
                        </span>
                      </button>
                      {folder.owned && (
                        <span className="actions">
                          <button
                            type="button"
                            className="btn-inline"
                            aria-label={tf(t.files.folders.renameAria, { name: folder.name })}
                            onClick={() => { setRenameFolderTarget(folder); setRenameFolderName(folder.name); }}
                          >
                            <Pencil size={14} aria-hidden="true" />
                            {t.table.rename}
                          </button>
                          <button
                            type="button"
                            className="btn-inline btn-inline-danger"
                            aria-label={tf(t.files.folders.deleteAria, { name: folder.name })}
                            onClick={() => setDeleteFolderTarget(folder)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            {t.table.delete}
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {rows.length > 0 && (
                <FileTable
                  rows={rows}
                  reload={load}
                  resetKey={`${view}|${page}|${appliedSearch}|${currentFolder}`}
                  onDetails={(row) => {
                    const found = files.find((f) => f.id === row.id);
                    if (found) setDetail(found);
                  }}
                  footer={
                    <div className="files-footer">
                      <span className="muted small">
                        {tf(t.common.showingRange, {
                          from: page * PAGE_SIZE + 1,
                          to: page * PAGE_SIZE + rows.length,
                          total,
                        })}
                      </span>
                      <nav className="pagination" aria-label={t.files.paginationAria}>
                        <button
                          type="button"
                          className="page-btn"
                          disabled={page === 0}
                          aria-label={t.common.previousPage}
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
                          aria-label={t.common.nextPage}
                          onClick={() => goTo(page + 1)}
                        >
                          ›
                        </button>
                      </nav>
                    </div>
                  }
                />
              )}
            </>
          )}

          <p className="muted small" style={{ marginTop: 12 }}>
            {t.files.footnote}
          </p>
        </section>
      ) : (
        <section className="card">
          <div className="card-head">
            <h2>{t.files.trash.tab}</h2>
            <div className="card-tools">
              <button
                type="button"
                className="btn-danger"
                disabled={trashTotal === 0}
                onClick={() => setEmptyTrashOpen(true)}
              >
                <Trash2 size={15} aria-hidden="true" />
                {t.files.trash.emptyTrash}
              </button>
            </div>
          </div>
          <p className="muted small">{tf(t.files.trash.retentionNote, { days: trashRetentionDays })}</p>

          {error ? (
            <div className="error-card" role="alert">
              <p>{error}</p>
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load()}>
                <RefreshCw size={15} aria-hidden="true" />
                {loading ? t.common.refreshing : t.common.refresh}
              </button>
            </div>
          ) : loading && trashFiles.length === 0 ? (
            <SkeletonRows rows={3} />
          ) : trashFiles.length === 0 ? (
            <EmptyState icon={Trash2} title={t.files.trash.emptyTitle} body={t.files.trash.emptyBody} />
          ) : (
            <table className="accounts-table">
              <thead>
                <tr>
                  <th>{t.table.name}</th>
                  <th>{t.table.size}</th>
                  <th>{t.files.trash.trashedAtColumn}</th>
                  <th>{t.table.actions}</th>
                </tr>
              </thead>
              <tbody>
                {trashFiles.map((file) => (
                  <tr key={file.id}>
                    <td>
                      <span className="file-name-cell">
                        <span className="ellipsis">{file.originalName}</span>
                      </span>
                    </td>
                    <td>{formatBytes(file.sizeBytes)}</td>
                    <td className="muted small">{formatDateTime(file.trashedAt)}</td>
                    <td>
                      <span className="actions">
                        <button type="button" className="btn-inline" onClick={() => void restoreOne(file)}>
                          <RotateCcw size={14} aria-hidden="true" />
                          {t.files.trash.restore}
                        </button>
                        <button
                          type="button"
                          className="btn-inline btn-inline-danger"
                          onClick={() => setPurgeTarget(file)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {t.files.trash.deleteForever}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {detail && view === 'files' && (
        <section className="card" ref={detailsRef}>
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

      {newFolderOpen && (
        <Dialog
          title={t.files.folders.newFolderTitle}
          description={t.files.folders.newFolderDesc}
          onClose={() => { if (!folderBusy) setNewFolderOpen(false); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={folderBusy} onClick={() => setNewFolderOpen(false)}>
                {t.dialog.cancel}
              </button>
              <button type="button" className="btn-primary" disabled={folderBusy} onClick={() => void createFolder()}>
                {t.files.folders.create}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <label htmlFor="folder-create-input">{t.files.folders.nameLabel}</label>
            <input
              id="folder-create-input"
              type="text"
              value={newFolderName}
              autoFocus
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFolder(); }}
            />
            {folderError && <p className="form-error" role="alert">{folderError}</p>}
          </div>
        </Dialog>
      )}
      {renameFolderTarget && (
        <Dialog
          title={t.files.folders.renameTitle}
          description={t.files.folders.renameDesc}
          onClose={() => { if (!folderBusy) setRenameFolderTarget(null); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={folderBusy} onClick={() => setRenameFolderTarget(null)}>
                {t.dialog.cancel}
              </button>
              <button type="button" className="btn-primary" disabled={folderBusy} onClick={() => void renameFolder()}>
                {t.fileActions.rename.save}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <label htmlFor="folder-rename-input">{t.files.folders.nameLabel}</label>
            <input
              id="folder-rename-input"
              type="text"
              value={renameFolderName}
              autoFocus
              onChange={(e) => setRenameFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void renameFolder(); }}
            />
            {folderError && <p className="form-error" role="alert">{folderError}</p>}
          </div>
        </Dialog>
      )}
      {deleteFolderTarget && (
        <ConfirmDialog
          title={t.files.folders.deleteTitle}
          lines={[tf(t.files.folders.deleteQuestion, { name: deleteFolderTarget.name }), t.files.folders.deleteDetail]}
          confirmLabel={t.table.delete}
          onConfirm={() => void deleteFolder()}
          onClose={() => { if (!folderBusy) setDeleteFolderTarget(null); }}
        />
      )}
      {purgeTarget && (
        <ConfirmDialog
          title={t.files.trash.purgeTitle}
          lines={[
            tf(t.files.trash.purgeQuestion, { name: purgeTarget.originalName }),
            t.files.trash.purgeDetail,
          ]}
          confirmLabel={t.files.trash.deleteForever}
          onConfirm={() => void purgeOne()}
          onClose={() => setPurgeTarget(null)}
        />
      )}
      {emptyTrashOpen && (
        <ConfirmDialog
          title={t.files.trash.emptyTitle}
          lines={[tf(t.files.trash.emptyQuestion, { count: trashTotal }), t.files.trash.purgeDetail]}
          confirmLabel={t.files.trash.emptyTrash}
          onConfirm={() => void emptyTrash()}
          onClose={() => setEmptyTrashOpen(false)}
        />
      )}
    </>
  );
}
