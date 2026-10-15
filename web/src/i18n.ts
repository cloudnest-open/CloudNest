/**
 * Application-wide i18n core (one system for the entry page AND the
 * authenticated app).
 *
 * Pure data + helpers, deliberately free of React/DOM side effects so the i18n
 * tests can import it under the server test runner. React bindings live in
 * i18n-context.tsx; the catalogs live in locales/ (per-locale files, typed so
 * TypeScript rejects any missing or extra leaf key versus English).
 *
 * Fallback rule: catalogs are complete per locale (compile-time enforced), so
 * a runtime English fallback should never trigger; when a *dynamic* value such
 * as a state code or error code is not in the catalog, callers render the raw
 * code as the diagnostic — never an empty label or a wrong-language guess.
 * Brands (CloudNest, provider names) and URLs stay untranslated.
 */
import { entryStrings, type EntryStrings } from './locales/entry.js';
import { appEn, type AppStrings } from './locales/app-en.js';
import type { Plural } from './locales/plural.js';
import { appZhCn } from './locales/app-zh-CN.js';
import { appEs } from './locales/app-es.js';
import { appDe } from './locales/app-de.js';
import { appRu } from './locales/app-ru.js';
import { appFr } from './locales/app-fr.js';
import { appJa } from './locales/app-ja.js';
import { appPtBr } from './locales/app-pt-BR.js';

export const LOCALES = ['en', 'zh-CN', 'es', 'de', 'ru', 'fr', 'ja', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Native names, shown in the selector itself; never translated. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  es: 'Español',
  de: 'Deutsch',
  ru: 'Русский',
  fr: 'Français',
  ja: '日本語',
  'pt-BR': 'Português (Brasil)',
};

export type { EntryStrings, AppStrings, Plural };
export { entryStrings };

export const appStrings: Record<Locale, AppStrings> = {
  en: appEn,
  'zh-CN': appZhCn,
  es: appEs,
  de: appDe,
  ru: appRu,
  fr: appFr,
  ja: appJa,
  'pt-BR': appPtBr,
};

const STORAGE_KEY = 'cloudnest.locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Read the persisted locale; default English when absent or invalid. */
export function readStoredLocale(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): Locale {
  if (!storage) return DEFAULT_LOCALE;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Persist the locale; a storage failure only loses persistence, not the choice. */
export function storeLocale(
  locale: Locale,
  storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, locale);
  } catch {
    // still applied for this session
  }
}

/** Minimal {placeholder} interpolation — no concatenation, so word order survives translation. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/** Pick the plural category exactly as Intl defines it for that locale. */
export function pluralCategory(locale: string, count: number): string {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

/** Select the right plural form for the locale and interpolate {count} into it. */
export function plural(locale: string, entry: Plural, count: number, vars: Record<string, string | number> = {}): string {
  const form = entry[pluralCategory(locale, count) as keyof Plural] ?? entry.other;
  return interpolate(form, { count, ...vars });
}

/* --- active locale & locale-aware formatting ------------------------------ */

/**
 * The locale formatting helpers use. React keeps its own state for rendering;
 * this module-level value (set by the provider on mount and on every change)
 * lets the shared format* helpers stay signature-compatible with the old
 * ones — the same pattern theme.ts uses for the theme.
 */
let activeLocale: Locale = typeof window === 'undefined' ? DEFAULT_LOCALE : readStoredLocale();

/** The locale currently in effect for the shared formatting helpers. */
export function currentLocale(): Locale {
  return activeLocale;
}

/** Called by the provider when the locale changes (and once at mount). */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

/** The catalog for a locale — used where React context is unavailable (confirm.tsx defaults). */
export function appStringsFor(locale: Locale): AppStrings {
  return appStrings[locale] ?? appStrings[DEFAULT_LOCALE];
}

function numberFormat(locale: string, value: number, fractionDigits: number): string {
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    return value.toFixed(fractionDigits);
  }
}

/** Locale-aware byte size with translated units, e.g. de → „1,5 MB“, ru → „1,5 МБ“, fr → « 1,5 Ko ». */
export function formatBytes(
  bytes: number | null | undefined,
  locale: Locale = activeLocale,
  units?: AppStrings['units'],
): string {
  const catalog = appStringsFor(locale);
  const u = units ?? catalog.units;
  if (bytes === null || bytes === undefined) return catalog.common.unknown;
  if (bytes < 1024) return `${bytes}\u00A0${u.b}`;
  const thresholds: Array<[number, keyof AppStrings['units']]> = [
    [1024 ** 4, 'tb'],
    [1024 ** 3, 'gb'],
    [1024 ** 2, 'mb'],
    [1024, 'kb'],
  ];
  for (const [threshold, unit] of thresholds) {
    if (bytes >= threshold) {
      const value = bytes / threshold;
      return `${numberFormat(locale, value, value >= 100 ? 0 : 1)}\u00A0${u[unit]}`;
    }
  }
  return `${numberFormat(locale, bytes / 1024, 1)}\u00A0${u.kb}`;
}

/** Locale-aware date-time for catalog dates, e.g. ja → 2026/10/14 10:24. */
export function formatDateTime(
  iso: string | null | undefined,
  locale: Locale = activeLocale,
): string {
  if (!iso) return '—';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  try {
    return when.toLocaleString(locale, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return when.toLocaleString();
  }
}

/** Locale-aware integer, e.g. de → 3.481. */
export function formatNumber(value: number, locale: Locale = activeLocale): string {
  return numberFormat(locale, value, 0);
}

/* --- file type keys ------------------------------------------------------- */

export type FileTypeKey = keyof AppStrings['fileTypes'] | (string & {});

/**
 * Stable, locale-independent type key derived from the real file name (never
 * invented data). Known families map to catalog keys; unknown extensions keep
 * their uppercase extension as the key — the extension is data, not English.
 */
export function fileTypeKey(name: string): FileTypeKey {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'excel';
  if (['docx', 'doc', 'odt', 'rtf'].includes(ext)) return 'word';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'powerpoint';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'zip';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (ext === 'fig') return 'figma';
  if (['txt', 'md'].includes(ext)) return 'text';
  if (ext === '') return 'file';
  return ext.toUpperCase();
}

/** Localized label for a type key; unknown keys render the key itself. */
export function fileTypeLabel(key: FileTypeKey, locale: Locale = activeLocale): string {
  const types = appStringsFor(locale).fileTypes as Record<string, string | undefined>;
  return types[key] ?? key;
}
