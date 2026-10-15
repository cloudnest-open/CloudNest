/**
 * A plural-bearing catalog entry, shared by every locale file.
 *
 * `other` is mandatory (the fallback every language needs); the specific
 * categories are optional per language — zh-CN/ja only ever use `other`,
 * ru uses one/few/many/other, en/es/de/fr/pt-BR use one/other. Annotating the
 * English catalog's plural entries with this type keeps the AppStrings
 * contract permissive exactly where Intl plural rules decide the category at
 * runtime (i18n.ts plural()).
 */
export type Plural = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};
