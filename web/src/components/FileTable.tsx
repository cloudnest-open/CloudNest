import { useEffect, useState } from 'react';
import { Pencil, Share2 as ShareIcon, Trash2, X } from 'lucide-react';
import { useFileActions } from './FileActionsProvider.js';
import { TypeIcon, formatBytes, formatDateTime, PROVIDER_LABELS, typeLabel } from './ui.js';
import { ProviderLogo } from './ProviderLogo.js';

/**
 * The one file table used by Dashboard's Recent Files and the Files page
 * (design pack §7 "columns match the Files page", §8 columns + multi-select).
 * Selection lives here so both surfaces get identical, REAL bulk actions —
 * a checkbox that selects nothing would be a dead control.
 */

export interface FileTableRow {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
  storedAcross: string[];
  modifiedAt: string | null;
}

interface FileTableProps {
  rows: FileTableRow[];
  reload: () => void | Promise<void>;
  /** Rendered after the table (pagination / result-count footers). */
  footer?: React.ReactNode;
  /** Changing this clears the selection (search, filter, page changes). */
  resetKey?: string;
}

export function FileTable({ rows, reload, footer, resetKey }: FileTableProps) {
  const actions = useFileActions();
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setSelected([]);
  }, [resetKey]);

  function toggleOne(id: string): void {
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  const allVisibleSelected = rows.length > 0 && rows.every((f) => selected.includes(f.id));
  function toggleAllVisible(): void {
    setSelected((prev) => (allVisibleSelected
      ? prev.filter((id) => !rows.some((f) => f.id === id))
      : Array.from(new Set([...prev, ...rows.map((f) => f.id)]))));
  }

  const selectedFiles = rows.filter((f) => selected.includes(f.id));
  const bulkShareable = selectedFiles.length > 0 && selectedFiles.every((f) => f.state === 'completed');
  const bulkDeletable = selectedFiles.some((f) => f.state !== 'deleted');

  return (
    <>
      {selectedFiles.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions for selected files">
          <span className="bulk-count">{selectedFiles.length} selected</span>
          <span className="actions">
            <button
              type="button"
              className="btn-primary btn-compact"
              disabled={!bulkShareable}
              title={bulkShareable ? undefined : 'Every selected file must be completed before it can be shared.'}
              onClick={() => actions.shareMany(selectedFiles, reload)}
            >
              <ShareIcon size={14} aria-hidden="true" />
              Share selected
            </button>
            <button
              type="button"
              className="btn-danger btn-compact"
              disabled={!bulkDeletable}
              title={bulkDeletable ? undefined : 'The selected files are already deleted.'}
              onClick={() => actions.removeMany(selectedFiles, reload)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete selected
            </button>
            <button type="button" className="btn-secondary btn-compact" onClick={() => setSelected([])}>
              <X size={14} aria-hidden="true" />
              Clear
            </button>
          </span>
        </div>
      )}

      <table className="accounts-table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>
              <input
                type="checkbox"
                aria-label="Select all files on this page"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
              />
            </th>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
            <th>Stored in</th>
            <th>Last modified</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((file) => (
            <tr key={file.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${file.originalName}`}
                  checked={selected.includes(file.id)}
                  onChange={() => toggleOne(file.id)}
                />
              </td>
              <td>
                {/* Reference rows show only icon + name; the state stays in
                    File details and the uploads views rather than narrowing
                    the Actions column. */}
                <span className="file-name-cell">
                  <TypeIcon name={file.originalName} />
                  <span className="ellipsis">{file.originalName}</span>
                </span>
              </td>
              <td>{typeLabel(file.originalName)}</td>
              <td>{formatBytes(file.sizeBytes)}</td>
              <td>
                <span className="file-name-cell">
                  {file.storedAcross.length === 0 ? (
                    <span className="muted small">Not yet placed</span>
                  ) : (
                    <>
                      {file.storedAcross.slice(0, 2).map((p) => <ProviderLogo key={p} provider={p} size={18} />)}
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
              <td className="muted small">{formatDateTime(file.modifiedAt)}</td>
              <td>
                <span className="actions">
                  <button
                    type="button"
                    className="btn-inline"
                    disabled={file.state !== 'completed'}
                    onClick={() => actions.share(file, reload)}
                  >
                    <ShareIcon size={14} aria-hidden="true" />
                    Share
                  </button>
                  <button type="button" className="btn-inline" onClick={() => actions.rename(file, reload)}>
                    <Pencil size={14} aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn-inline btn-inline-danger"
                    disabled={file.state === 'deleted'}
                    onClick={() => actions.remove(file, reload)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </>
  );
}
