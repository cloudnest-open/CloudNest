import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Entry-page catalog consistency (CloudNest-LOGIN-PAGE-REFERENCE-SPEC.md §17).
 *
 * The web source tree lives outside the server tsconfig rootDir, so the i18n
 * module is loaded at runtime from its file URL instead of a static import —
 * this keeps `tsc -p server/tsconfig.json` (the build step) unaware of web/.
 */

interface FlatStrings {
  [key: string]: string;
}

function flatten(prefix: string, value: unknown, into: FlatStrings): void {
  if (value === null || typeof value !== 'object') {
    into[prefix] = String(value);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(prefix ? `${prefix}.${key}` : key, child, into);
  }
}

async function loadI18n(): Promise<Record<string, unknown>> {
  const moduleUrl = new URL('../../web/src/i18n.ts', import.meta.url);
  return (await import(moduleUrl.href)) as Record<string, unknown>;
}

test('entry i18n ships the eight approved locales', async () => {
  const i18n = await loadI18n();
  assert.deepEqual(
    i18n.LOCALES,
    ['en', 'zh-CN', 'es', 'de', 'ru', 'fr', 'ja', 'pt-BR'],
    'the approved locale ids must stay exactly these eight',
  );
});

test('every locale covers the English key set with non-empty strings', async () => {
  const i18n = await loadI18n();
  const catalogs = i18n.entryStrings as Record<string, unknown>;
  const english: FlatStrings = {};
  flatten('', catalogs.en, english);
  assert.ok(Object.keys(english).length > 30, 'the English catalog should be substantive');

  for (const [locale, catalog] of Object.entries(catalogs)) {
    const flat: FlatStrings = {};
    flatten('', catalog, flat);
    assert.deepEqual(
      Object.keys(flat).sort(),
      Object.keys(english).sort(),
      `${locale} must define exactly the English leaf keys (spec §17: no missing keys)`,
    );
    for (const [key, value] of Object.entries(flat)) {
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${locale}.${key} must be a non-empty string (spec §17: no empty labels)`,
      );
    }
  }
});

test('placeholders survive translation and interpolate resolves them', async () => {
  const i18n = await loadI18n();
  const catalogs = i18n.entryStrings as Record<string, unknown>;
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const flat: FlatStrings = {};
    flatten('', catalog, flat);
    assert.match(
      flat['footer.rights'] ?? '',
      /\{year\}/,
      `${locale} footer.rights must keep the {year} placeholder`,
    );
  }
  const interpolate = i18n.interpolate as (template: string, vars: Record<string, string | number>) => string;
  assert.equal(interpolate('© {year} X', { year: 2026 }), '© 2026 X');
  assert.equal(interpolate('no vars', { year: 2026 }), 'no vars');
});

test('locale persistence helpers fall back to English safely', async () => {
  const i18n = await loadI18n();
  const isLocale = i18n.isLocale as (value: unknown) => boolean;
  const readStoredLocale = i18n.readStoredLocale as (storage?: Pick<Storage, 'getItem'>) => string;
  assert.equal(isLocale('de'), true);
  assert.equal(isLocale('xx-YY'), false);
  assert.equal(readStoredLocale(undefined), 'en', 'no storage → English default');
  assert.equal(
    readStoredLocale({ getItem: () => 'not-a-locale' }),
    'en',
    'invalid stored value → English fallback',
  );
  assert.equal(
    readStoredLocale({ getItem: () => 'pt-BR' }),
    'pt-BR',
    'valid stored value is honored',
  );
});
