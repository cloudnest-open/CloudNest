/**
 * Destructive-action confirmations (M12.a `security.confirmDestructive`).
 *
 * The preference is read from settings once and cached for the session. When it
 * cannot be read, the safe default is to ASK: an unreachable server must never
 * silently drop a guard rail. Turning the setting off suppresses the dialog for
 * an owner who has explicitly opted out, and never changes what an action does.
 */
import { api } from './api.js';

let preference: boolean | null = null;
let pending: Promise<boolean> | null = null;

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

/**
 * Gate one destructive action. Returns true when it may proceed: either the
 * owner opted out of confirmations, or they accepted the dialog.
 */
export async function confirmDestructive(message: string): Promise<boolean> {
  if (!(await resolvePreference())) return true;
  return window.confirm(message);
}
