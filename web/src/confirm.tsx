/**
 * Destructive-action confirmation (M12.a `security.confirmDestructive`).
 *
 * The preference is read from settings once and cached for the session. When it
 * cannot be read, the safe default is to ASK: an unreachable server must never
 * silently drop a guard rail. Turning the setting off suppresses the dialog for
 * an owner who has explicitly opted out, and never changes what an action does.
 *
 * The dialog itself is rendered by the mounted ConfirmHost (a real, focus-trapped
 * modal per the design pack §13) — never `window.confirm`. If no host is mounted
 * the call falls back to `window.confirm` so a headless/test context still has a
 * working gate.
 *
 * Callers pass already-localized copy; the fallback defaults below resolve
 * through the app-wide i18n core (current locale, English catalog as ultimate
 * fallback) so they can never appear in the wrong language.
 */
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { appStringsFor, currentLocale } from './i18n.js';
import { ConfirmDialog } from './components/ui.js';

export interface ConfirmRequest {
  title: string;
  lines: [string, string];
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

let preference: boolean | null = null;
let pending: Promise<boolean> | null = null;
let host: ((request: ConfirmRequest | null) => void) | null = null;

/** Seed the cached value (App start-up and the Settings page both call this). */
export function setConfirmDestructivePreference(value: boolean): void {
  preference = value;
  pending = null;
}

/** Resolve the preference, defaulting to "ask" on any failure. */
function resolvePreference(): Promise<boolean> {
  if (preference !== null) return Promise.resolve(preference);
  if (!pending) {
    pending = (async (): Promise<boolean> => {
      try {
        const res = await api.getSettings();
        const payload = res.data as
          | { settings?: Record<string, unknown> }
          | null
          | undefined;
        const raw = res.status === 200 ? payload?.settings?.['security.confirmDestructive'] : undefined;
        preference = typeof raw === 'boolean' ? raw : true;
      } catch {
        preference = true;
      }
      return preference;
    })();
  }
  return pending;
}

/** Split a plain message into the dialog's one-line question and its detail. */
function splitMessage(message: string, title?: string, confirmLabel?: string): Omit<ConfirmRequest, 'resolve'> {
  const t = appStringsFor(currentLocale()).dialog;
  const [first = message, ...rest] = message.split('\n\n');
  const detail = rest.join(' ').replace(/\s+/g, ' ').trim();
  return {
    title: title ?? t.sureTitle,
    lines: [first.replace(/\s+/g, ' ').trim(), detail || t.irreversible],
    confirmLabel: confirmLabel ?? t.confirm,
  };
}

/**
 * Gate one destructive action. Returns true when it may proceed: either the
 * owner opted out of confirmations, or they accepted the dialog.
 */
export async function confirmDestructive(
  message: string,
  options?: { title?: string; confirmLabel?: string },
): Promise<boolean> {
  if (!(await resolvePreference())) return true;
  if (!host) return window.confirm(message);
  const request = splitMessage(message, options?.title, options?.confirmLabel);
  return new Promise<boolean>((resolve) => host?.({ ...request, resolve }));
}

/** Mount once (App shell): renders the real confirmation dialog on demand. */
export function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    host = setRequest;
    return () => {
      host = null;
    };
  }, []);

  if (!request) return null;
  return (
    <ConfirmDialog
      title={request.title}
      lines={request.lines}
      confirmLabel={request.confirmLabel}
      onConfirm={() => {
        request.resolve(true);
        setRequest(null);
      }}
      onClose={() => {
        request.resolve(false);
        setRequest(null);
      }}
    />
  );
}
