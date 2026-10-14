import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from '../api.js';
import { ConfirmDialog, Dialog, Spinner, useToast } from './ui.js';

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
  share: (file: ActionableFile, reload?: Reload) => Promise<void>;
  rename: (file: ActionableFile, reload?: Reload) => void;
  remove: (file: ActionableFile, reload?: Reload) => void;
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

  const [shareResult, setShareResult] = useState<{ url: string; name: string } | null>(null);
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);

  async function share(file: ActionableFile, reload?: Reload): Promise<void> {
    setShareBusyId(file.id);
    try {
      const res = await api.createShareLink({ fileIds: [file.id] });
      if (res.status === 201) {
        const url = (res.data as { url: string }).url;
        setShareResult({ url, name: file.originalName });
        toast.push({
          kind: 'success',
          title: 'Share link created',
          body: 'Copy it now — CloudNest stores only a hash, so the URL cannot be shown again.',
        });
        await reload?.();
      } else {
        const body = res.data as { code?: string };
        toast.push({
          kind: 'error',
          title: 'The link could not be created',
          body: body.code === 'share_password_required_by_policy'
            ? 'Your Sharing settings require a password for new links — create it from Shared Links, where you can set one.'
            : `Reason: ${body.code ?? 'unknown'}.`,
        });
      }
    } finally {
      setShareBusyId(null);
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

  const actions: FileActionsApi = { share, rename, remove };

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

      {shareBusyId && (
        <div className="toast-region">
          <div className="toast toast-info">
            <Spinner label="Creating the share link" />
            <p className="small muted" style={{ margin: 0 }}>Creating the share link…</p>
          </div>
        </div>
      )}
    </FileActionsContext.Provider>
  );
}
