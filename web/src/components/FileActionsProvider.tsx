import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from '../api.js';
import { ConfirmDialog, Dialog, useToast } from './ui.js';

/**
 * One place for the three file actions, so the Dashboard, the Files page and
 * any future screen behave identically (design pack §8, §13):
 * - Share   → creates a real link and shows the one-time URL
 * - Rename  → metadata-only, never moves provider objects
 * - Delete  → durable deletion with the exact destructive-confirmation copy
 * Nothing here reports success before the server confirms it.
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
          name: dialog.files.length > 1 ? `${dialog.files.length} files` : dialog.files[0]?.originalName ?? 'file',
        });
        toast.push({
          kind: 'success',
          title: 'Share link created',
          body: 'Copy it now — CloudNest stores only a hash, so the URL cannot be shown again.',
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
            ? 'Your Sharing settings require a password for new links. Set a password above and create the link again.'
            : `The link could not be created (${body.code ?? 'unknown'}). Nothing was created.`,
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
        toast.push({ kind: 'success', title: 'File renamed', body: 'Only the CloudNest name changed; provider objects were not moved.' });
        await renameTarget.reload?.();
        setRenameTarget(null);
      } else {
        const body = res.data as { code?: string; error?: string };
        setRenameError(`Could not rename this file (${body.code ?? body.error ?? 'unknown'}).`);
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
      if (completed > 0) parts.push(`${completed} deleted`);
      if (pending > 0) parts.push(`${pending} still pending (recorded, safe to retry)`);
      if (failed > 0) parts.push(`${failed} could not be queued`);
      toast.push({
        kind: failed > 0 ? 'error' : pending > 0 ? 'info' : 'success',
        title: `Bulk deletion finished for ${target.files.length} file(s)`,
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
        toast.push({ kind: 'error', title: 'Could not queue the deletion', body: 'Nothing was deleted.' });
        return;
      }
      const jobId = (res.data as { jobId: string }).jobId;
      // drive the durable job to a terminal state so the outcome is real
      const retry = await api.retryDeletion(jobId);
      const state = retry.status === 200
        ? (retry.data as { result?: { state?: string } }).result?.state ?? 'unknown'
        : 'unknown';
      if (state === 'completed') {
        toast.push({ kind: 'success', title: 'Deletion completed', body: 'Every CloudNest-owned chunk object is confirmed gone.' });
      } else {
        toast.push({
          kind: 'info',
          title: 'Deletion is still pending',
          body: 'Some objects could not be confirmed deleted. The obligation is recorded and can be retried; nothing unrelated was touched.',
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
          title="New link URL"
          description="This URL cannot be shown again — CloudNest stores only a hash of the token."
          onClose={() => setShareResult(null)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setShareResult(null)}>Dismiss</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(shareResult.url).then(
                    () => toast.push({ kind: 'success', title: 'URL copied to the clipboard' }),
                    () => toast.push({ kind: 'error', title: 'Copy failed', body: 'Select the URL and copy it manually.' }),
                  );
                }}
              >
                Copy link
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
          title="Rename file"
          description="Only the CloudNest name changes. Provider objects are never moved or renamed."
          onClose={() => { if (!renameBusy) setRenameTarget(null); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={renameBusy} onClick={() => setRenameTarget(null)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={renameBusy} onClick={() => void confirmRename()}>
                {renameBusy ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <label htmlFor="rename-input">File name</label>
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
          title="Delete File"
          lines={[
            `Are you sure you want to delete "${deleteTarget.file.originalName}"?`,
            "This will also delete the file's CloudNest-managed chunks across all connected accounts. This action cannot be undone.",
          ]}
          confirmLabel="Delete file"
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {bulkDeleteTarget && (
        <ConfirmDialog
          title={`Delete ${bulkDeleteTarget.files.length} files`}
          lines={[
            `Are you sure you want to delete these ${bulkDeleteTarget.files.length} files (${bulkDeleteTarget.files.slice(0, 3).map((f) => `"${f.originalName}"`).join(', ')}${bulkDeleteTarget.files.length > 3 ? '…' : ''})?`,
            'This will also delete each file\'s CloudNest-managed chunks across all connected accounts. This action cannot be undone; the result is reported per file.',
          ]}
          confirmLabel="Delete files"
          onConfirm={() => void confirmBulkDelete()}
          onClose={() => { if (!bulkBusy) setBulkDeleteTarget(null); }}
        />
      )}

      {shareDialog && (
        <Dialog
          title={shareDialog.files.length > 1 ? `Create shared link — ${shareDialog.files.length} files` : 'Create share link'}
          description={
            shareDialog.files.length > 1
              ? 'Anyone with the link can download the files in this collection individually until it expires or is revoked.'
              : 'Anyone with the link can download this file until it expires or is revoked.'
          }
          onClose={() => { if (!shareBusy) setShareDialog(null); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={shareBusy} onClick={() => setShareDialog(null)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={shareBusy} onClick={() => void confirmShare()}>
                {shareBusy ? 'Creating…' : 'Create link'}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <ul className="plain-list">
              {shareDialog.files.map((f) => <li key={f.id}>{f.originalName}</li>)}
            </ul>
            <label htmlFor="share-expiry">Expiry date</label>
            <select
              id="share-expiry"
              value={shareExpiry}
              disabled={shareBusy}
              onChange={(e) => setShareExpiry(e.target.value as '1' | '7' | '30' | 'never')}
            >
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="never">No expiry</option>
            </select>
            <label htmlFor="share-password">Password (optional)</label>
            <input
              id="share-password"
              type="password"
              value={sharePassword}
              placeholder="Set a password"
              autoComplete="new-password"
              disabled={shareBusy}
              onChange={(e) => setSharePassword(e.target.value)}
            />
            <label htmlFor="share-limit">Download limit (optional)</label>
            <input
              id="share-limit"
              type="number"
              min={1}
              value={shareLimit}
              placeholder="Unlimited"
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
