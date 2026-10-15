import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from '../api.js';
import { ConfirmDialog, Dialog, useToast } from './ui.js';
import { useI18n } from '../i18n-context.js';

/**
 * One place for the three file actions, so the Dashboard, the Files page and
 * any future screen behave identically (design pack §8, §13):
 * - Share   → creates a real link and shows the one-time URL
 * - Rename  → metadata-only, never moves provider objects
 * - Delete  → durable deletion with the exact destructive-confirmation copy
 * Nothing here reports success before the server confirms it. All copy
 * resolves through the app-wide i18n context; safe error codes from the
 * server stay as diagnostics inside the localized message.
 */

export interface ActionableFile {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
}

type Reload = (() => void | Promise<void>) | undefined;

interface FileActionsApi {
  /** Opens the share-link dialog with the file preselected (design pack §8). */
  share: (file: ActionableFile, reload?: Reload) => void;
  /** Same dialog for a collection of files (one link, files listed individually). */
  shareMany: (files: ActionableFile[], reload?: Reload) => void;
  rename: (file: ActionableFile, reload?: Reload) => void;
  remove: (file: ActionableFile, reload?: Reload) => void;
  /** One destructive confirmation, then a durable delete per selected file. */
  removeMany: (files: ActionableFile[], reload?: Reload) => void;
}

const FileActionsContext = createContext<FileActionsApi | null>(null);

export function useFileActions(): FileActionsApi {
  const value = useContext(FileActionsContext);
  if (!value) throw new Error('useFileActions must be used inside FileActionsProvider');
  return value;
}

interface Pending { file: ActionableFile; reload: Reload }

export function FileActionsProvider({ children }: { children: ReactNode }) {
  const { t, tf, plural } = useI18n();
  const toast = useToast();

  const [renameTarget, setRenameTarget] = useState<Pending | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Pending | null>(null);

  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<{ files: ActionableFile[]; reload: Reload } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [shareResult, setShareResult] = useState<{ url: string; name: string } | null>(null);

  // Share-link dialog state (expiry/password/limit), preselected file(s) inside.
  const [shareDialog, setShareDialog] = useState<{ files: ActionableFile[]; reload: Reload } | null>(null);
  const [shareExpiry, setShareExpiry] = useState<'1' | '7' | '30' | 'never'>('7');
  const [sharePassword, setSharePassword] = useState('');
  const [shareLimit, setShareLimit] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  function share(file: ActionableFile, reload?: Reload): void {
    setShareError(null);
    setShareDialog({ files: [file], reload });
  }

  function shareMany(files: ActionableFile[], reload?: Reload): void {
    setShareError(null);
    setShareDialog({ files, reload });
  }

  /** Creates the link exactly as configured in the dialog; never fakes success. */
  async function confirmShare(): Promise<void> {
    const dialog = shareDialog;
    if (!dialog) return;
    setShareBusy(true);
    setShareError(null);
    try {
      // An explicit null really means "no expiry"; the server only applies its
      // own default when the field is absent.
      const expiresAt = shareExpiry === 'never' ? null : new Date(Date.now() + Number(shareExpiry) * 86400000).toISOString();
      const res = await api.createShareLink({
        fileIds: dialog.files.map((f) => f.id),
        ...(sharePassword ? { password: sharePassword } : {}),
        expiresAt,
        downloadLimit: shareLimit ? Number(shareLimit) : null,
      });
      if (res.status === 201) {
        const url = (res.data as { url: string }).url;
        setShareResult({
          url,
          name: dialog.files.length > 1
            ? plural(t.fileActions.result.fileCount, dialog.files.length)
            : dialog.files[0]?.originalName ?? t.fileTypes.file,
        });
        toast.push({
          kind: 'success',
          title: t.fileActions.share.successTitle,
          body: t.fileActions.share.successBody,
        });
        setShareDialog(null);
        setSharePassword('');
        setShareLimit('');
        setShareExpiry('7');
        await dialog.reload?.();
      } else {
        const body = res.data as { code?: string };
        setShareError(
          body.code === 'share_password_required_by_policy'
            ? t.fileActions.share.policyError
            : tf(t.fileActions.share.error, { code: body.code ?? 'unknown' }),
        );
      }
    } finally {
      setShareBusy(false);
    }
  }

  function rename(file: ActionableFile, reload?: Reload): void {
    setRenameValue(file.originalName);
    setRenameError(null);
    setRenameTarget({ file, reload });
  }

  async function confirmRename(): Promise<void> {
    if (!renameTarget) return;
    const next = renameValue.trim();
    if (next === '' || next === renameTarget.file.originalName) {
      setRenameTarget(null);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      const res = await api.renameFile(renameTarget.file.id, next);
      if (res.status === 200) {
        toast.push({ kind: 'success', title: t.fileActions.rename.successTitle, body: t.fileActions.rename.successBody });
        await renameTarget.reload?.();
        setRenameTarget(null);
      } else {
        const body = res.data as { code?: string; error?: string };
        setRenameError(tf(t.fileActions.rename.error, { code: body.code ?? body.error ?? 'unknown' }));
      }
    } finally {
      setRenameBusy(false);
    }
  }

  function remove(file: ActionableFile, reload?: Reload): void {
    setDeleteTarget({ file, reload });
  }

  function removeMany(files: ActionableFile[], reload?: Reload): void {
    if (files.length === 0) return;
    if (files.length === 1) { remove(files[0]!, reload); return; }
    setBulkDeleteTarget({ files, reload });
  }

  /**
   * Bulk deletion: one confirmation, then the same durable per-file delete the
   * single-file flow uses, with an honest per-file outcome tally afterwards.
   */
  async function confirmBulkDelete(): Promise<void> {
    const target = bulkDeleteTarget;
    if (!target) return;
    setBulkBusy(true);
    try {
      let completed = 0;
      let pending = 0;
      let failed = 0;
      for (const file of target.files) {
        try {
          const res = await api.deleteFile(file.id);
          if (res.status !== 202) { failed += 1; continue; }
          const jobId = (res.data as { jobId: string }).jobId;
          const retry = await api.retryDeletion(jobId);
          const state = retry.status === 200
            ? (retry.data as { result?: { state?: string } }).result?.state ?? 'unknown'
            : 'unknown';
          if (state === 'completed') completed += 1;
          else pending += 1;
        } catch {
          failed += 1;
        }
      }
      const parts: string[] = [];
      if (completed > 0) parts.push(tf(t.fileActions.bulkResult.deleted, { count: completed }));
      if (pending > 0) parts.push(tf(t.fileActions.bulkResult.pending, { count: pending }));
      if (failed > 0) parts.push(tf(t.fileActions.bulkResult.failed, { count: failed }));
      toast.push({
        kind: failed > 0 ? 'error' : pending > 0 ? 'info' : 'success',
        title: plural(t.fileActions.bulkResult.title, target.files.length),
        body: parts.join(' · '),
      });
      await target.reload?.();
    } finally {
      setBulkBusy(false);
      setBulkDeleteTarget(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target) return;
    try {
      const res = await api.deleteFile(target.file.id);
      if (res.status !== 202) {
        toast.push({ kind: 'error', title: t.fileActions.deleteToast.queueErrorTitle, body: t.fileActions.deleteToast.queueErrorBody });
        return;
      }
      const jobId = (res.data as { jobId: string }).jobId;
      // drive the durable job to a terminal state so the outcome is real
      const retry = await api.retryDeletion(jobId);
      const state = retry.status === 200
        ? (retry.data as { result?: { state?: string } }).result?.state ?? 'unknown'
        : 'unknown';
      if (state === 'completed') {
        toast.push({ kind: 'success', title: t.fileActions.deleteToast.completedTitle, body: t.fileActions.deleteToast.completedBody });
      } else {
        toast.push({
          kind: 'info',
          title: t.fileActions.deleteToast.pendingTitle,
          body: t.fileActions.deleteToast.pendingBody,
        });
      }
      await target.reload?.();
    } finally {
      setDeleteTarget(null);
    }
  }

  const actions: FileActionsApi = { share, shareMany, rename, remove, removeMany };

  return (
    <FileActionsContext.Provider value={actions}>
      {children}

      {shareResult && (
        <Dialog
          title={t.fileActions.result.title}
          description={t.fileActions.result.desc}
          onClose={() => setShareResult(null)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setShareResult(null)}>{t.common.dismiss}</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(shareResult.url).then(
                    () => toast.push({ kind: 'success', title: t.fileActions.result.copiedToast }),
                    () => toast.push({ kind: 'error', title: t.fileActions.result.copyFailedTitle, body: t.fileActions.result.copyFailedBody }),
                  );
                }}
              >
                {t.fileActions.result.copy}
              </button>
            </>
          }
        >
          <p className="small muted">{shareResult.name}</p>
          <code className="callback-uri">{shareResult.url}</code>
        </Dialog>
      )}

      {renameTarget && (
        <Dialog
          title={t.fileActions.rename.title}
          description={t.fileActions.rename.desc}
          onClose={() => { if (!renameBusy) setRenameTarget(null); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={renameBusy} onClick={() => setRenameTarget(null)}>{t.dialog.cancel}</button>
              <button type="button" className="btn-primary" disabled={renameBusy} onClick={() => void confirmRename()}>
                {renameBusy ? t.fileActions.rename.saving : t.fileActions.rename.save}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <label htmlFor="rename-input">{t.fileActions.rename.label}</label>
            <input
              id="rename-input"
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmRename(); }}
            />
            {renameError && <p className="form-error" role="alert">{renameError}</p>}
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t.fileActions.deleteOne.title}
          lines={[
            tf(t.fileActions.deleteOne.question, { name: deleteTarget.file.originalName }),
            t.fileActions.deleteOne.detail,
          ]}
          confirmLabel={t.fileActions.deleteOne.confirm}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {bulkDeleteTarget && (
        <ConfirmDialog
          title={tf(t.fileActions.deleteMany.title, { count: bulkDeleteTarget.files.length })}
          lines={[
            tf(t.fileActions.deleteMany.question, {
              count: bulkDeleteTarget.files.length,
              names: `${bulkDeleteTarget.files.slice(0, 3).map((f) => `“${f.originalName}”`).join(', ')}${bulkDeleteTarget.files.length > 3 ? '…' : ''}`,
            }),
            t.fileActions.deleteMany.detail,
          ]}
          confirmLabel={t.fileActions.deleteMany.confirm}
          onConfirm={() => void confirmBulkDelete()}
          onClose={() => { if (!bulkBusy) setBulkDeleteTarget(null); }}
        />
      )}

      {shareDialog && (
        <Dialog
          title={shareDialog.files.length > 1
            ? tf(t.fileActions.share.titleMany, { count: shareDialog.files.length })
            : t.fileActions.share.title}
          description={shareDialog.files.length > 1 ? t.fileActions.share.descMany : t.fileActions.share.descOne}
          onClose={() => { if (!shareBusy) setShareDialog(null); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={shareBusy} onClick={() => setShareDialog(null)}>
                {t.dialog.cancel}
              </button>
              <button type="button" className="btn-primary" disabled={shareBusy} onClick={() => void confirmShare()}>
                {shareBusy ? t.fileActions.share.creating : t.fileActions.share.create}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <ul className="plain-list">
              {shareDialog.files.map((f) => <li key={f.id}>{f.originalName}</li>)}
            </ul>
            <label htmlFor="share-expiry">{t.fileActions.share.expiry}</label>
            <select
              id="share-expiry"
              value={shareExpiry}
              disabled={shareBusy}
              onChange={(e) => setShareExpiry(e.target.value as '1' | '7' | '30' | 'never')}
            >
              <option value="1">{t.fileActions.share.expiry1}</option>
              <option value="7">{t.fileActions.share.expiry7}</option>
              <option value="30">{t.fileActions.share.expiry30}</option>
              <option value="never">{t.fileActions.share.expiryNever}</option>
            </select>
            <label htmlFor="share-password">{t.fileActions.share.password}</label>
            <input
              id="share-password"
              type="password"
              value={sharePassword}
              placeholder={t.fileActions.share.passwordPlaceholder}
              autoComplete="new-password"
              disabled={shareBusy}
              onChange={(e) => setSharePassword(e.target.value)}
            />
            <label htmlFor="share-limit">{t.fileActions.share.limit}</label>
            <input
              id="share-limit"
              type="number"
              min={1}
              value={shareLimit}
              placeholder={t.fileActions.share.limitPlaceholder}
              disabled={shareBusy}
              onChange={(e) => setShareLimit(e.target.value)}
            />
            {shareError && <p className="form-error" role="alert">{shareError}</p>}
          </div>
        </Dialog>
      )}
    </FileActionsContext.Provider>
  );
}
