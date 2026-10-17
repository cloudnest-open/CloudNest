/**
 * Transfer-dock collapse preference (roadmap session-21 batch-B) — pure data
 * + storage, free of React, in the same convention as ui-mode.ts. The dock
 * starts collapsed as a small pill (it used to be a permanently-expanded
 * overlay that ate interactions); the preference is a per-browser UI choice
 * persisted in localStorage (cloudnest.dockCollapsed, never a credential).
 */

const STORAGE_KEY = 'cloudnest.dockCollapsed';

export function readStoredDockCollapsed(): boolean {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === '0') return false;
    if (value === '1') return true;
  } catch {
    // private browsing etc.: fall through to the default
  }
  return true;
}

export function storeDockCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // private browsing etc.: the preference simply does not persist
  }
}
