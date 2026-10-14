/**
 * Theme mechanism (FRONTEND_DESIGN.md §15 Light/Dark contract).
 *
 * The approved contract is explicit:
 * - light and dark only (no third mode);
 * - default light;
 * - one state source: `data-theme="light|dark"` on the document root, with CSS
 *   design tokens carrying the palette;
 * - the selection is persisted client-side and falls back to light when that
 *   storage is unavailable;
 * - `color-scheme` is set so native controls and scrollbars match;
 * - no flash of the wrong theme on reload.
 *
 * Persistence is deliberately client-side (localStorage): it works before the
 * server answers, which is what makes a no-flash first paint possible, and the
 * theme is a presentation preference with no server-side effect.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cloudnest.theme';
const DEFAULT_THEME: Theme = 'light';

function readStored(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : DEFAULT_THEME;
  } catch {
    // storage unavailable (private mode, blocked cookies): default safely
    return DEFAULT_THEME;
  }
}

function paint(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

let current: Theme = typeof window === 'undefined' ? DEFAULT_THEME : readStored();

/** The theme in effect right now. */
export function currentTheme(): Theme {
  return current;
}

/** Apply a theme now and remember it for the next load. */
export function applyTheme(theme: Theme): void {
  current = theme;
  paint(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // the theme still applies for this session; only persistence is lost
  }
}

/** Flip light ↔ dark and return the new value. */
export function toggleTheme(): Theme {
  applyTheme(current === 'dark' ? 'light' : 'dark');
  return current;
}

// Resolve before the first paint: this module is evaluated before React renders,
// so a dark-mode owner never sees a light flash.
paint(current);
