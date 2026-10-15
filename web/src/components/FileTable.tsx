import { useEffect, useState } from 'react';
import { Info, Pencil, Share2 as ShareIcon, Trash2, X } from 'lucide-react';
import { useFileActions } from './FileActionsProvider.js';
import { Badge, TypeIcon, formatBytes, formatDateTime, PROVIDER_LABELS, fileTypeName, fileTypeDisplay } from './ui.js';
import { ProviderLogo } from './ProviderLogo.js';
import { useI18n } from '../i18n-context.js';

/**
 * The one file table used by Dashboard's Recent Files and the Files page
 * (design pack §7 "columns match the Files page", §8 columns + multi-select).
 * Selection lives here so both surfaces get identical, REAL bulk actions —
 * a checkbox that selects nothing would be a dead control. All copy resolves
 * through the app-wide i18n context.
 */

export interface FileTableRow {
  id: string;
  originalName: string;
  sizeBytes: number;
  state: string;
  storedAcross: string[];
  modifiedAt: string | null;
  /** Task §5.B: an account holding this file's chunks is not connected. */
  needsReconnect?: boolean;
  /** Labels of the affected accounts, for the honest tooltip. */
  unavailableLabels?: string[];
}

interface FileTableProps {
  rows: FileTableRow[];
  reload: () => void | Promise<void>;
  /** Rendered after the table (pagination / result-count footers). */
  footer?: React.ReactNode;
  /** Changing this clears the selection (search, filter, page changes). */
  resetKey?: string;
  /** When provided, each row gets a Details action opening the caller's panel. */
  onDetails?: (row: FileTableRow) => void;
}

export function FileTable({ rows, reload, footer, resetKey, onDetails }: FileTableProps) {
  const { t, tf, plural } = useI18n();
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
        <div className="bulk-bar" role="toolbar" aria-label={t.table.bulkAria}>
          <span className="bulk-count">{plural(t.table.selected, selectedFiles.length)}</span>
          <span className="actions">
            <button
              type="button"
              className="btn-primary btn-compact"
              disabled={!bulkShareable}
              title={bulkShareable ? undefined : t.table.shareDisabledTitle}
              onClick={() => actions.shareMany(selectedFiles, reload)}
            >
              <ShareIcon size={14} aria-hidden="true" />
              {t.table.shareSelected}
            </button>
            <button
              type="button"
              className="btn-danger btn-compact"
              disabled={!bulkDeletable}
              title={bulkDeletable ? undefined : t.table.deleteDisabledTitle}
              onClick={() => actions.removeMany(selectedFiles, reload)}
            >
              <Trash2 size={14} aria-hidden="true" />
              {t.table.deleteSelected}
            </button>
            <button type="button" className="btn-secondary btn-compact" onClick={() => setSelected([])}>
              <X size={14} aria-hidden="true" />
              {t.table.clearSelection}
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
                aria-label={t.table.selectAllAria}
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
              />
            </th>
            <th>{t.table.name}</th>
            <th>{t.table.type}</th>
            <th>{t.table.size}</th>
            <th>{t.table.storedIn}</th>
            <th>{t.table.lastModified}</th>
            <th>{t.table.actions}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((file) => (
            <tr key={file.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={tf(t.table.selectOneAria, { name: file.originalName })}
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
                  {file.needsReconnect && (
                    <span
                      title={tf(t.table.reconnectTooltip, {
                        accounts: (file.unavailableLabels ?? []).join(', '),
                      })}
                    >
                      <Badge tone="warn">{t.table.reconnectBadge}</Badge>
                    </span>
                  )}
                </span>
              </td>
              <td>{fileTypeDisplay(fileTypeName(file.originalName))}</td>
              <td>{formatBytes(file.sizeBytes)}</td>
              <td>
                <span className="file-name-cell">
                  {file.storedAcross.length === 0 ? (
                    <span className="muted small">{t.common.notPlaced}</span>
                  ) : (
                    <>
                      {file.storedAcross.slice(0, 2).map((p) => <ProviderLogo key={p} provider={p} size={18} />)}
                      <span className="muted small">
                        {file.storedAcross.length === 1
                          ? PROVIDER_LABELS[file.storedAcross[0]!] ?? file.storedAcross[0]
                          : file.storedAcross.length > 2
                            ? plural(t.table.storedMulti, file.storedAcross.length)
                            : file.storedAcross.map((p) => PROVIDER_LABELS[p] ?? p).join(' + ')}
                      </span>
                    </>
                  )}
                </span>
              </td>
              <td className="muted small">{formatDateTime(file.modifiedAt)}</td>
              <td>
                <span className="actions">
                  {onDetails && (
                    <button type="button" className="btn-inline" onClick={() => onDetails(file)}>
                      <Info size={14} aria-hidden="true" />
                      {t.table.details}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-inline"
                    disabled={file.state !== 'completed'}
                    onClick={() => actions.share(file, reload)}
                  >
                    <ShareIcon size={14} aria-hidden="true" />
                    {t.table.share}
                  </button>
                  <button type="button" className="btn-inline" onClick={() => actions.rename(file, reload)}>
                    <Pencil size={14} aria-hidden="true" />
                    {t.table.rename}
                  </button>
                  <button
                    type="button"
                    className="btn-inline btn-inline-danger"
                    disabled={file.state === 'deleted'}
                    onClick={() => actions.remove(file, reload)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t.table.delete}
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
