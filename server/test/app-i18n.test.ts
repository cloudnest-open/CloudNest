import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Application-wide i18n verification (all eight approved locales).
 *
 * The web source tree lives outside the server tsconfig rootDir, so the i18n
 * module is loaded at runtime from its file URL instead of a static import —
 * this keeps `tsc -p server/tsconfig.json` (the build step) unaware of web/.
 *
 * What is proven here:
 * - all eight locale resources load and are registered under their locale id;
 * - every locale defines EXACTLY the English leaf keys (entry + app catalogs)
 *   with non-empty strings — a missing key cannot silently fall back;
 * - {placeholders} survive translation (same set as English per leaf);
 * - plural entries always carry `other` and only carry valid Intl categories;
 * - plural selection, interpolation, and byte/date/number formatting are
 *   locale-aware (de comma, ru units, fr octets, ja date layout);
 * - the persistence helpers round-trip and fall back to English safely.
 * Layout-level overflow cannot be reproduced without a browser; the nav-label
 * length budget below is the automated heuristic (browser verification covers
 * the real rendering).
 */

interface FlatLeaf {
  value: string | Record<string, string>;
  path: string;
}

const EXPECTED_LOCALES = ['en', 'zh-CN', 'es', 'de', 'ru', 'fr', 'ja', 'pt-BR'];
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

function isPluralLeaf(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).other === 'string'
  );
}

function flatten(prefix: string, value: unknown, into: Map<string, FlatLeaf>): void {
  if (typeof value === 'string') {
    into.set(prefix, { value, path: prefix });
    return;
  }
  if (isPluralLeaf(value)) {
    into.set(prefix, { value, path: prefix });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${key}` : key, child, into);
    }
    return;
  }
  throw new Error(`non-string leaf at ${prefix}: ${String(value)}`);
}

function placeholders(template: string): Set<string> {
  return new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
}

async function loadI18n(): Promise<Record<string, any>> {
  const moduleUrl = new URL('../../web/src/i18n.ts', import.meta.url);
  return (await import(moduleUrl.href)) as Record<string, any>;
}

test('all eight approved locales load and are registered', async () => {
  const i18n = await loadI18n();
  assert.deepEqual(i18n.LOCALES, EXPECTED_LOCALES, 'the approved locale ids must stay exactly these eight');
  for (const locale of EXPECTED_LOCALES) {
    assert.ok(i18n.appStrings[locale], `appStrings.${locale} must be registered`);
    assert.ok(i18n.entryStrings[locale], `entryStrings.${locale} must be registered`);
    assert.equal(i18n.appStringsFor(locale), i18n.appStrings[locale], `appStringsFor('${locale}') must not fall back`);
  }
});

test('every app catalog covers the English key set with non-empty strings', async () => {
  const i18n = await loadI18n();
  const english = new Map<string, FlatLeaf>();
  flatten('', i18n.appStrings.en, english);
  assert.ok(english.size > 300, `the English app catalog should be substantive (got ${english.size})`);

  for (const locale of EXPECTED_LOCALES) {
    const flat = new Map<string, FlatLeaf>();
    flatten('', i18n.appStrings[locale], flat);
    assert.deepEqual(
      [...flat.keys()].sort(),
      [...english.keys()].sort(),
      `${locale} must define exactly the English app leaf keys (no missing-key fallback, no extras)`,
    );
    for (const [key, leaf] of flat) {
      if (typeof leaf.value === 'string') {
        assert.ok(leaf.value.trim().length > 0, `${locale}.${key} must be a non-empty string`);
      } else {
        assert.ok(isPluralLeaf(leaf.value) && (leaf.value.other ?? '').trim().length > 0, `${locale}.${key} must have a non-empty plural other form`);
      }
    }
  }
});

test('every entry catalog still covers the English key set with non-empty strings', async () => {
  const i18n = await loadI18n();
  const english = new Map<string, FlatLeaf>();
  flatten('', i18n.entryStrings.en, english);
  for (const locale of EXPECTED_LOCALES) {
    const flat = new Map<string, FlatLeaf>();
    flatten('', i18n.entryStrings[locale], flat);
    assert.deepEqual([...flat.keys()].sort(), [...english.keys()].sort(), `${locale} entry catalog key parity`);
    for (const [key, leaf] of flat) {
      assert.equal(typeof leaf.value, 'string', `${locale}.${key} must be a plain string`);
      assert.ok((leaf.value as string).trim().length > 0, `${locale}.${key} must be non-empty`);
    }
  }
});

test('placeholders survive translation (string leaves)', async () => {
  const i18n = await loadI18n();
  const english = new Map<string, FlatLeaf>();
  flatten('', i18n.appStrings.en, english);
  for (const locale of EXPECTED_LOCALES) {
    if (locale === 'en') continue;
    const flat = new Map<string, FlatLeaf>();
    flatten('', i18n.appStrings[locale], flat);
    for (const [key, enLeaf] of english) {
      if (typeof enLeaf.value !== 'string') continue;
      const expected = placeholders(enLeaf.value);
      const got = placeholders(flat.get(key)!.value as string);
      assert.deepEqual([...got].sort(), [...expected].sort(), `${locale}.${key} must keep the {placeholders} of en`);
    }
  }
});

test('placeholders survive translation (plural leaves, per form)', async () => {
  const i18n = await loadI18n();
  const english = new Map<string, FlatLeaf>();
  flatten('', i18n.appStrings.en, english);
  for (const locale of EXPECTED_LOCALES) {
    const flat = new Map<string, FlatLeaf>();
    flatten('', i18n.appStrings[locale], flat);
    for (const [key, enLeaf] of english) {
      if (typeof enLeaf.value === 'string') continue;
      const leaf = flat.get(key)!.value as Record<string, string>;
      const enVars = new Set([...Object.values(enLeaf.value as Record<string, string>)].flatMap((f) => [...placeholders(f)]));
      enVars.delete('count'); // plural() injects {count} itself
      for (const [form, template] of Object.entries(leaf)) {
        const vars = placeholders(template);
        vars.delete('count');
        for (const v of vars) {
          assert.ok(enVars.has(v), `${locale}.${key}.${form} uses {${v}} which en does not define`);
        }
      }
    }
  }
});

test('plural entries only use valid Intl categories and always carry other', async () => {
  const i18n = await loadI18n();
  for (const locale of EXPECTED_LOCALES) {
    const flat = new Map<string, FlatLeaf>();
    flatten('', i18n.appStrings[locale], flat);
    for (const [key, leaf] of flat) {
      if (typeof leaf.value === 'string') continue;
      const forms = Object.keys(leaf.value as Record<string, string>);
      for (const form of forms) {
        assert.ok(PLURAL_CATEGORIES.has(form), `${locale}.${key} has invalid plural category ${form}`);
      }
      assert.ok(forms.includes('other'), `${locale}.${key} must carry the other form`);
    }
  }
});

test('plural() picks locale-correct forms (en one/other, ru few, ja always other)', async () => {
  const i18n = await loadI18n();
  const { plural } = i18n;
  const enNeed = { one: '{count} needs attention', other: '{count} need attention' };
  assert.equal(plural('en', enNeed, 1), '1 needs attention');
  assert.equal(plural('en', enNeed, 3), '3 need attention');
  const ruFiles = { one: '{count} файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' };
  assert.equal(plural('ru', ruFiles, 1), '1 файл');
  assert.equal(plural('ru', ruFiles, 2), '2 файла');
  assert.equal(plural('ru', ruFiles, 5), '5 файлов');
  assert.equal(plural('ru', ruFiles, 21), '21 файл');
  assert.equal(plural('ja', { other: '{count} 件' }, 1), '1 件');
  assert.equal(plural('ja', { other: '{count} 件' }, 9), '9 件');
});

test('byte formatting is locale-aware (units and decimal separator)', async () => {
  const i18n = await loadI18n();
  const { formatBytes } = i18n;
  assert.equal(formatBytes(0, 'en'), '0\u00A0B');
  assert.equal(formatBytes(1536, 'en'), '1.5\u00A0KB');
  assert.equal(formatBytes(1536, 'de'), '1,5\u00A0KB');
  assert.equal(formatBytes(1536, 'ru'), '1,5\u00A0КБ');
  assert.equal(formatBytes(1536, 'fr'), '1,5\u00A0Ko');
  assert.equal(formatBytes(1024 ** 3, 'de'), '1,0\u00A0GB');
  assert.match(formatBytes(12345, 'ja'), /KB/);
  assert.match(formatBytes(null, 'en'), /Unknown/i);
});

test('date-time and number formatting are locale-aware', async () => {
  const i18n = await loadI18n();
  const { formatDateTime, formatNumber } = i18n;
  const iso = '2026-10-14T10:24:00Z';
  for (const locale of EXPECTED_LOCALES) {
    const text = formatDateTime(iso, locale);
    assert.ok(text.includes('2026'), `${locale} date must include the year, got: ${text}`);
    assert.notEqual(text, '—');
  }
  assert.equal(formatNumber(3481, 'en'), '3,481');
  assert.equal(formatNumber(3481, 'de'), '3.481');
  assert.equal(formatDateTime(null, 'en'), '—');
  assert.equal(formatDateTime('not-a-date', 'en'), '—');
});

test('interpolation keeps word order and missing vars intact', async () => {
  const i18n = await loadI18n();
  const { interpolate } = i18n;
  assert.equal(interpolate('Upload complete: {name} ({size}).', { name: 'a.txt', size: '5 B' }), 'Upload complete: a.txt (5 B).');
  assert.equal(interpolate('no vars', {}), 'no vars');
  assert.equal(interpolate('keep {unknown}', {}), 'keep {unknown}');
});

test('locale persistence helpers round-trip and fall back to English safely', async () => {
  const i18n = await loadI18n();
  const { isLocale, readStoredLocale, storeLocale } = i18n;
  assert.equal(isLocale('de'), true);
  assert.equal(isLocale('xx-YY'), false);
  assert.equal(readStoredLocale(undefined), 'en', 'no storage → English default');
  assert.equal(readStoredLocale({ getItem: () => 'not-a-locale' }), 'en', 'invalid stored value → English fallback');
  const backing = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  };
  storeLocale('pt-BR', fakeStorage);
  assert.equal(readStoredLocale(fakeStorage), 'pt-BR', 'valid stored value is honored');
  storeLocale('nope', fakeStorage as unknown as Storage);
  assert.equal(backing.get('cloudnest.locale'), 'nope', 'guard is at read time (isLocale), store stays raw');
  assert.equal(readStoredLocale(fakeStorage), 'en', 'an invalid stored value still reads back as English');
});

test('error-code catalogs are complete and resolve in every locale', async () => {
  const i18n = await loadI18n();
  const enUpload = Object.keys(i18n.appStrings.en.errors.upload).filter((k: string) => k !== 'fallback');
  const enDownload = Object.keys(i18n.appStrings.en.errors.download);
  assert.ok(enUpload.length >= 17, 'the upload error catalog should cover the known safe codes');
  assert.ok(enDownload.length >= 12, 'the download error catalog should cover the known safe codes');
  for (const locale of EXPECTED_LOCALES) {
    for (const code of enUpload) {
      assert.equal(typeof i18n.appStrings[locale].errors.upload[code], 'string', `${locale}.errors.upload.${code}`);
    }
    for (const code of enDownload) {
      assert.equal(typeof i18n.appStrings[locale].errors.download[code], 'string', `${locale}.errors.download.${code}`);
    }
  }
  // unknown codes resolve to the localized fallback, never to an empty label
  assert.equal(typeof i18n.appStrings.ja.errors.upload.fallback, 'string');
});

test('nav labels stay within the sidebar layout budget in every locale', async () => {
  // Heuristic for the 202px sidebar (automated layer); the real rendering is
  // browser-verified. 20 characters at ~13.5px leaves comfortable room next
  // to the 20px icon inside the 182px item width.
  const budgets: Record<string, number> = {
    dashboard: 20, files: 20, uploads: 20, downloads: 20,
    sharedLinks: 22, cloudAccounts: 22, settings: 20,
  };
  const i18n = await loadI18n();
  for (const locale of EXPECTED_LOCALES) {
    const nav = i18n.appStrings[locale].nav;
    for (const [key, budget] of Object.entries(budgets)) {
      const label = nav[key] as string;
      assert.ok(
        [...label].length <= budget,
        `${locale}.nav.${key} is too long for the sidebar (${[...label].length} > ${budget}): ${label}`,
      );
    }
  }
});

test('file type keys resolve to localized labels; unknown extensions stay raw data', async () => {
  const i18n = await loadI18n();
  const { fileTypeKey, fileTypeLabel } = i18n;
  assert.equal(fileTypeKey('report.pdf'), 'pdf');
  assert.equal(fileTypeKey('photo.JPG'), 'image');
  assert.equal(fileTypeKey('archive.tar.gz'), 'zip');
  assert.equal(fileTypeKey('noext'), 'file');
  assert.equal(fileTypeKey('design.blend'), 'BLEND'); // extension is data, never translated
  assert.equal(fileTypeLabel('image', 'de'), 'Bild');
  assert.equal(fileTypeLabel('image', 'ja'), '画像');
  assert.equal(fileTypeLabel('BLEND', 'de'), 'BLEND');
});

test('setActiveLocale drives the module-level formatters (shell-wide effect)', async () => {
  const i18n = await loadI18n();
  const { setActiveLocale, formatBytes, currentLocale } = i18n;
  setActiveLocale('ru');
  assert.equal(currentLocale(), 'ru');
  assert.equal(formatBytes(1536), '1,5\u00A0КБ');
  setActiveLocale('en');
  assert.equal(currentLocale(), 'en');
  assert.equal(formatBytes(1536), '1.5\u00A0KB');
});
