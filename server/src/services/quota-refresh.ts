import type { CredentialsStore } from '../providers/credentials-store.js';
import type { ProviderAccountRow } from '../db/provider-queries.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import { recordProviderCall } from '../metrics/provider-metrics.js';
import type { ProviderAccountService } from './provider-account-service.js';

/**
 * Roadmap Phase 5 — the ONE quota-refresh path, shared by the admin route and
 * the background scheduler. Extracted verbatim from the router so a scheduler
 * refresh and a manual refresh can never drift apart: same S3 local-math
 * branch, same coerce-expire handling, same quota/auth state separation, and
 * the same call metrics.
 */

export interface QuotaRefreshResult {
  id: string;
  ok: boolean;
  status?: string;
  code: string | null;
}

/** Run async work over items with a bounded number of concurrent workers. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function refreshOneAccountQuota(
  row: ProviderAccountRow,
  accounts: ProviderAccountService,
  store: CredentialsStore,
): Promise<QuotaRefreshResult> {
  // S3-compatible accounts have no provider quota API: the truthful numbers
  // are the owner-set cap plus CloudNest-tracked placement bytes, computed
  // locally (roadmap Phase 1). Adapter refresh simply does not apply.
  if (row.provider === 's3') {
    const tracked = accounts.s3QuotaOverrides().get(row.id);
    const quota = tracked && tracked.totalBytes !== null
      ? { totalBytes: tracked.totalBytes, usedBytes: tracked.usedBytes ?? 0, status: 'current' as const }
      : { totalBytes: null, usedBytes: null, status: 'unknown' as const, safeErrorCode: 'quota_unavailable' as const };
    accounts.applyQuotaResult(row.id, quota);
    return { id: row.id, ok: quota.status === 'current', status: quota.status, code: quota.safeErrorCode ?? null };
  }
  const adapter = getAdapter(row.provider);
  if (!adapter) return { id: row.id, ok: false, code: 'provider_unavailable' };
  try {
    const bundle = store.loadAccountBundle(row);
    if (!bundle) return { id: row.id, ok: false, code: 'needs_reauth' };
    // coerce-expire handling lives in the adapter
    const appConfig = row.provider === 'mega' || row.provider === 'pcloud' ? undefined : store.getConfig(row.provider)?.config;
    const refreshed = await adapter.ensureValidCredentials(bundle, appConfig);
    if (JSON.stringify(refreshed) !== JSON.stringify(bundle)) accounts.saveRefreshedBundle(row, refreshed);
    const quota = await adapter.getQuota(refreshed, appConfig);
    recordProviderCall(row.provider, true, null);
    accounts.applyQuotaResult(row.id, quota);
    return { id: row.id, ok: true, status: quota.status, code: quota.safeErrorCode ?? null };
  } catch (err) {
    const code = err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
    recordProviderCall(row.provider, false, code);
    if (code === 'needs_reauth') accounts.markNeedsReauth(row.id, code);
    else accounts.applyQuotaResult(row.id, { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' });
    return { id: row.id, ok: false, code };
  }
}

export async function refreshAllAccountQuotas(
  rows: ProviderAccountRow[],
  accounts: ProviderAccountService,
  store: CredentialsStore,
  concurrency = 3,
): Promise<QuotaRefreshResult[]> {
  return mapWithConcurrency(rows, concurrency, (row) => refreshOneAccountQuota(row, accounts, store));
}
