/**
 * React bindings for the application UI mode (web/src/ui-mode.ts).
 *
 * One provider above the shell — exactly ONE mode preference, chosen in the
 * post-login chooser and changeable from the sidebar. Persisted in localStorage
 * (cloudnest.uiMode, UI preference, never a credential). `null` means "not
 * chosen yet" — the shell shows the chooser before rendering any page.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { readStoredUiMode, storeUiMode, type UiMode } from './ui-mode.js';

interface UiModeValue {
  /** null until the user has picked a mode (post-login chooser shows then). */
  uiMode: UiMode | null;
  setUiMode: (mode: UiMode) => void;
}

const UiModeContext = createContext<UiModeValue | null>(null);

export function UiModeProvider({ children }: { children: ReactNode }) {
  const [uiMode, setModeState] = useState<UiMode | null>(() => readStoredUiMode());

  const setUiMode = useCallback((mode: UiMode) => {
    storeUiMode(mode);
    setModeState(mode);
  }, []);

  const value = useMemo<UiModeValue>(() => ({ uiMode, setUiMode }), [uiMode, setUiMode]);

  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>;
}

export function useUiMode(): UiModeValue {
  const value = useContext(UiModeContext);
  if (!value) throw new Error('useUiMode must be used inside UiModeProvider');
  return value;
}
