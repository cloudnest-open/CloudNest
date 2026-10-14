import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  AlertTriangle, CheckCircle2, Info, X, Cloud, Folder, FileText, FileArchive,
  FileSpreadsheet, FileImage, Presentation, File, Trash2, type LucideIcon,
} from 'lucide-react';

/**
 * Shared UI kit (design pack §20): Button styles live in CSS, this file holds
 * the reusable behaviour-bearing pieces — dialog, toasts, badges, tiles and the
 * formatting helpers every page needs. All of it reads semantic tokens only.
 */

/* --- formatting ---------------------------------------------------------- */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)}\u00A0${units[i]}`;
}

/** Locale date-time, e.g. "Oct 14, 2026, 10:24 AM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/* --- provider identity --------------------------------------------------- */

export const PROVIDER_LABELS: Record<string, string> = {
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  pcloud: 'pCloud',
  mega: 'MEGA',
};

/** Brand colour is used ONLY inside the small identity tile (spec §5). */
const PROVIDER_COLORS: Record<string, string> = {
  google_drive: '#1A73E8',
  dropbox: '#0061FF',
  onedrive: '#0364B8',
  pcloud: '#14A5E5',
  mega: '#D9272E',
};

/** Neutral fallback tile: initial + brand tint. No unlicensed logo artwork. */
export function ProviderTile({ provider, size = 28 }: { provider: string; size?: number }) {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return (
    <span
      className="provider-tile"
      style={{ width: size, height: size, background: PROVIDER_COLORS[provider] ?? 'var(--cn-text-muted)', fontSize: size * 0.46 }}
      aria-hidden="true"
      title={label}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* --- file type icon ------------------------------------------------------ */

/**
 * Friendly type word derived from the real file name (never invented data):
 * the Files table and Dashboard's Recent Files show this in a Type column.
 */
export function typeLabel(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'Excel';
  if (['docx', 'doc', 'odt', 'rtf'].includes(ext)) return 'Word';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'PowerPoint';
  if (ext === 'pdf') return 'PDF';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'Zip';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return 'Image';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'Video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'Audio';
  if (ext === 'fig') return 'Figma';
  if (['txt', 'md'].includes(ext)) return 'Text';
  if (ext === '') return 'File';
  return ext.toUpperCase();
}

export function TypeIcon({ name, size = 18 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  const pick = (Icon: LucideIcon, color: string) => (
    <Icon size={size} strokeWidth={1.9} color={color} aria-hidden="true" className="type-icon" />
  );
  if (lower.endsWith('.zip') || lower.endsWith('.rar') || lower.endsWith('.7z') || lower.endsWith('.tar') || lower.endsWith('.gz')) {
    return pick(FileArchive, '#B45309');
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) return pick(FileSpreadsheet, '#15803D');
  if (lower.endsWith('.docx') || lower.endsWith('.doc') || lower.endsWith('.txt') || lower.endsWith('.md')) return pick(FileText, '#2563EB');
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) return pick(Presentation, '#C2410C');
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || lower.endsWith('.gif')) {
    return pick(FileImage, '#7C3AED');
  }
  if (lower.endsWith('.pdf')) return pick(FileText, '#B91C1C');
  if (lower.endsWith('.fig')) return pick(File, '#0F766E');
  return pick(File, 'var(--cn-text-muted)');
}

/** Amber folder mark, used where the API really reports a folder-like entry. */
export function FolderIcon({ size = 18 }: { size?: number }) {
  return <Folder size={size} strokeWidth={1.9} color="#D97706" aria-hidden="true" className="type-icon" />;
}

/* --- progress ------------------------------------------------------------ */

export function ProgressBar({ value, tone = 'primary' }: { value: number; tone?: 'primary' | 'success' | 'warning' | 'danger' }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill progress-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* --- badge / empty state ------------------------------------------------- */

export function Badge({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; children: ReactNode }) {
  const cls = tone === 'info' ? 'tag' : `state state-${tone}`;
  return <span className={cls}>{children}</span>;
}

export function EmptyState({ icon: Icon = Cloud, title, body, children }: {
  icon?: LucideIcon; title: string; body?: string; children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={22} strokeWidth={1.9} aria-hidden="true" /></span>
      <strong>{title}</strong>
      {body && <span className="small">{body}</span>}
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ))}
    </div>
  );
}

/** Compact numbered page window like the reference: 1 … p-1 p p+1 … N. */
export function pageList(current: number, count: number): Array<number | 'gap'> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const pages: Array<number | 'gap'> = [1];
  const lo = Math.max(2, current - 1);
  const hi = Math.min(count - 1, current + 1);
  if (lo > 2) pages.push('gap');
  for (let p = lo; p <= hi; p++) pages.push(p);
  if (hi < count - 1) pages.push('gap');
  pages.push(count);
  return pages;
}

/* --- dialog (focus-trapped, Escape closes) ------------------------------- */

export function Dialog({ title, description, children, footer, onClose, role = 'dialog' }: {
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  role?: 'dialog' | 'alertdialog';
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const focusables = panel.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="dialog"
        role={role}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onKeyDown={trap}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close dialog">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {description && <p>{description}</p>}
        {children}
        {footer && <div className="actions">{footer}</div>}
      </div>
    </div>
  );
}

/** The destructive-confirmation shell: pale-red icon circle + danger actions. */
export function ConfirmDialog({ title, lines, confirmLabel, onConfirm, onClose }: {
  title: string;
  lines: [string, string];
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      role="alertdialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-danger-solid" onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">
        <span className="confirm-icon" aria-hidden="true"><Trash2 size={16} /></span>
        <div>
          <p className="confirm-line">{lines[0]}</p>
          <p className="small">{lines[1]}</p>
        </div>
      </div>
    </Dialog>
  );
}

export function Spinner({ label = 'Working…' }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/* --- toasts -------------------------------------------------------------- */

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; title: string; body?: string }

const ToastContext = createContext<{ push: (t: Omit<ToastItem, 'id'>) => void }>({ push: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_ICONS: Record<ToastKind, LucideIcon> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Errors stay until dismissed; success/info self-dismiss after 6 s.
  useEffect(() => {
    const timers = items
      .filter((t) => t.kind !== 'error')
      .map((t) => setTimeout(() => dismiss(t.id), 6000));
    return () => timers.forEach(clearTimeout);
  }, [items, dismiss]);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-region" aria-live="polite">
        {items.map((t) => {
          const Icon = TOAST_ICONS[t.kind];
          return (
            <div className={`toast toast-${t.kind}`} role="status" key={t.id}>
              <Icon size={18} aria-hidden="true" className="toast-icon" />
              <div>
                <strong className="toast-title">{t.title}</strong>
                {t.body && <p className="small muted">{t.body}</p>}
              </div>
              <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
