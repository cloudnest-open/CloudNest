/**
 * Application UI mode (personal vs business) — pure data + storage, free of
 * React. The mode is a per-browser UI preference (like the theme and the
 * language): it decides WHICH provider surfaces the UI shows (personal OAuth
 * accounts vs business S3 accounts) — it is never a security boundary, the
 * server already routes every upload by its own tier rules.
 *
 * Chosen once in the post-login chooser, changeable anytime from the sidebar;
 * persisted in localStorage (cloudnest.uiMode, UI preference, never a
 * credential).
 */

export type UiMode = 'personal' | 'business';

const STORAGE_KEY = 'cloudnest.uiMode';

export function isUiMode(value: unknown): value is UiMode {
  return value === 'personal' || value === 'business';
}

export function readStoredUiMode(): UiMode | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isUiMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeUiMode(mode: UiMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private browsing etc.: the mode simply does not persist
  }
}

/** Which storage tier a provider belongs to — the same split the server uses. */
export function providerTier(providerId: string): UiMode {
  return providerId === 's3' ? 'business' : 'personal';
}
