/**
 * React bindings for the application-wide i18n core (web/src/i18n.ts).
 *
 * One provider above the whole tree — entry page, shell and every page — so
 * there is exactly ONE language preference and ONE translation instance. The
 * choice persists in localStorage (cloudnest.locale, UI preference, never a
 * credential), so it survives navigation, refresh, logout and the next login
 * without touching authentication state in any way. Invalid or unavailable
 * stored values fall back safely to English (readStoredLocale).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  appStrings, entryStrings, interpolate, plural, readStoredLocale, setActiveLocale,
  storeLocale,
  type AppStrings, type EntryStrings, type Locale, type Plural,
} from './i18n.js';

interface I18nValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** Catalog for the authenticated application. */
  t: AppStrings;
  /** Catalog for the entry page (login / first-run). */
  e: EntryStrings;
  /** Interpolate {placeholders} with locale-aware number formatting applied to numbers. */
  tf: (template: string, vars?: Record<string, string | number>) => string;
  /** Locale-aware plural selection: plural(t.key, count, vars). */
  plural: (entry: Plural, count: number, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());

  useEffect(() => {
    // Formatting helpers outside React (shared formatBytes/formatDateTime)
    // follow the same locale; <html lang> follows it for screen readers.
    setActiveLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: appStrings[locale],
    e: entryStrings[locale],
    tf: (template, vars = {}) => interpolate(template, vars),
    plural: (entry, count, vars = {}) => plural(locale, entry, count, vars),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The single source of language state for every page and shared component. */
export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
