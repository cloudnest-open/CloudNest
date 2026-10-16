import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { CredentialsStore } from '../providers/credentials-store.js';
import type { ProviderAccountService } from '../services/provider-account-service.js';
import type { ProviderAccountRow } from '../db/provider-queries.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import { startOAuthFlow, makePkcePair } from '../providers/oauth-state.js';
import { callbackUri, oauthEndpoints } from '../providers/oauth-endpoints.js';

/** Public shape: never includes tokens, ciphertext, or key material. */
function toPublic(row: ProviderAccountRow) {
  const adapter = getAdapter(row.provider);
  const total = row.quota_total_bytes;
  const used = row.used_bytes;
  const availableBytes =
    total !== null && used !== null
      ? Math.max(0, total - used - row.reserve_bytes - row.reserved_inflight_bytes)
      : null;
  return {
    id: row.id,
    provider: row.provider,
    displayName: adapter?.displayName ?? row.provider,
    experimental: adapter?.experimental ?? false,
    displayLabel: row.display_label,
    accountIdentifier: row.account_identifier,
    status: row.status,
    /** Storage tier (roadmap Phase 1): personal OAuth pools vs business S3 pools. */
    tier: row.tier ?? 'personal',
    quota: {
      totalBytes: total,
      usedBytes: used,
      availableBytes,
      status: row.quota_status,
      /** Provider-documented unlimited quota — shown as "Unlimited", never 0 B. */
      unlimited: row.quota_unlimited === 1,
      lastCheckedAt: row.last_quota_check_at,
      lastErrorCode: row.last_quota_error_code,
      lastErrorAt: row.last_quota_error_at,
    },
    /** Owner-confirmed shared-pool key (§6.2); null = independent quota. */
    quotaScopeKey: row.quota_scope,
    /** Owner-set per-bucket cap (S3-compatible accounts); null elsewhere. */
    capacityCapBytes: row.capacity_cap_bytes,
    reserveBytes: row.reserve_bytes,
    reservedInflightBytes: row.reserved_inflight_bytes,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    hasCredentials: row.credential_ciphertext !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Bounded concurrency helper (max 3 concurrent quota reads). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export function providerAccountsRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  store: CredentialsStore;
  accounts: ProviderAccountService;
  appBaseUrl: string;
}): Router {
  const router = Router();
  const { queries, csrf, store, accounts, appBaseUrl } = deps;
  const adminOnly = requireAdmin(queries);
  const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many refresh attempts. Try again later.' } });

  router.get('/api/provider-accounts', adminOnly, (_req, res) => {
    // Disconnect-warning data (task §5.A): how many live files reference each
    // account. One grouped query for the whole list — never per-row.
    const usage = accounts.trackedUsage();
    res.json({
      accounts: accounts.list().map((row) => ({
        ...toPublic(row),
        usage: usage.get(row.id) ?? { trackedFiles: 0, trackedChunks: 0 },
      })),
    });
  });

  async function refreshOne(row: ProviderAccountRow) {
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
      accounts.applyQuotaResult(row.id, quota);
      return { id: row.id, ok: true, status: quota.status, code: quota.safeErrorCode ?? null };
    } catch (err) {
      const code = err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      if (code === 'needs_reauth') accounts.markNeedsReauth(row.id, code);
      else accounts.applyQuotaResult(row.id, { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' });
      queries.recordAudit('provider_quota_refresh', false, code, { accountId: row.id });
      return { id: row.id, ok: false, code };
    }
  }

  router.post('/api/provider-accounts/:id/refresh-quota', adminOnly, csrf.doubleCsrfProtection, refreshLimiter, async (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const result = await refreshOne(row);
    queries.recordAudit('provider_quota_refresh', result.ok, result.code ?? 'ok', { accountId: row.id });
    res.json({ result });
  });

  router.post('/api/provider-accounts/refresh-quotas', adminOnly, csrf.doubleCsrfProtection, refreshLimiter, async (req, res) => {
    const rows = accounts.list().filter((r) => r.credential_ciphertext !== null);
    const results = await mapWithConcurrency(rows, 3, refreshOne);
    queries.recordAudit('provider_quota_refresh_all', true, 'batch', { count: results.length });
    res.json({ results });
  });

  router.patch('/api/provider-accounts/:id', adminOnly, csrf.doubleCsrfProtection, (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const body = (req.body ?? {}) as { displayLabel?: unknown; reserveBytes?: unknown };
    if (typeof body.displayLabel === 'string') {
      const label = body.displayLabel.trim();
      if (!label || label.length > 120) {
        res.status(400).json({ error: 'Label must be 1–120 characters.' });
        return;
      }
      accounts.rename(row.id, label);
    }
    if (typeof body.reserveBytes === 'number') {
      if (!Number.isInteger(body.reserveBytes) || body.reserveBytes < 0) {
        res.status(400).json({ error: 'Reserved space must be a non-negative integer in bytes.' });
        return;
      }
      accounts.updateReserve(row.id, body.reserveBytes);
    }
    res.json({ account: toPublic(accounts.get(row.id) as ProviderAccountRow) });
  });

  // §6.2: shared-quota grouping is ALWAYS an explicit owner confirmation — the
  // server never infers a shared pool from emails, domains, or identical
  // numbers. Grouping is per provider and replaces that provider's previous
  // grouping wholesale; `clear` restores independent quotas.
  router.post('/api/provider-accounts/quota-scope', adminOnly, csrf.doubleCsrfProtection, (req, res) => {
    const body = (req.body ?? {}) as { provider?: unknown; accountIds?: unknown; clear?: unknown };
    if (typeof body.provider !== 'string' || body.provider === '') {
      res.status(400).json({ error: 'provider is required', code: 'invalid_request' });
      return;
    }
    try {
      const updated = body.clear === true
        ? accounts.setQuotaScope(body.provider, null)
        : Array.isArray(body.accountIds) && body.accountIds.every((id) => typeof id === 'string')
          ? accounts.setQuotaScope(body.provider, body.accountIds as string[])
          : null;
      if (!updated) {
        res.status(400).json({ error: 'accountIds must be a list of account ids, or clear must be true', code: 'invalid_request' });
        return;
      }
      queries.recordAudit('provider_quota_scope_set', true, body.provider, { count: updated.filter((r) => r.quota_scope !== null).length });
      res.json({ accounts: updated.map(toPublic) });
    } catch (err) {
      if (err instanceof ProviderError) {
        res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
        return;
      }
      throw err;
    }
  });

  router.post('/api/provider-accounts/:id/reconnect', adminOnly, csrf.doubleCsrfProtection, refreshLimiter, (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    if (row.provider === 'mega') {
      res.json({ mode: 'credentials', message: 'Enter the MEGA account password again to reconnect.' });
      return;
    }
    if (row.provider === 's3') {
      res.json({ mode: 'credentials', message: 'Enter the S3-compatible access keys again to reconnect.' });
      return;
    }
    const cfg = store.getConfig(row.provider);
    if (!cfg) {
      res.status(409).json({ error: 'Provider setup is not configured.', code: 'provider_not_configured' });
      return;
    }
    const provider = row.provider as 'google_drive' | 'dropbox' | 'pcloud' | 'onedrive';
    const endpoints = oauthEndpoints(provider, cfg.config);
    const pkce = endpoints.usesPkce ? makePkcePair() : null;
    let state: string;
    try {
      ({ state } = startOAuthFlow(provider, req.sessionID, pkce?.verifier));
    } catch {
      res.status(503).json({ error: 'Too many pending authorization flows.', code: 'oauth_state_invalid' });
      return;
    }
    const params = new URLSearchParams({
      client_id: cfg.config.clientId,
      redirect_uri: callbackUri(appBaseUrl, provider),
      response_type: 'code',
      state,
      ...(endpoints.scopes.length > 0 ? { scope: endpoints.scopes.join(' ') } : {}),
      ...(pkce ? { code_challenge: pkce.challengeS256, code_challenge_method: 'S256' } : {}),
      ...(endpoints.extraAuthParams ?? {}),
    });
    queries.recordAudit('provider_reconnect_start', true, provider, { accountId: row.id });
    res.json({ mode: 'oauth', authorizationUrl: `${endpoints.authorizeUrl}?${params.toString()}` });
  });

  router.post('/api/provider-accounts/:id/disconnect', adminOnly, csrf.doubleCsrfProtection, async (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const result = await accounts.disconnect(row.id);
    queries.recordAudit('provider_disconnect', true, result.revokedRemotely ? 'revoked' : 'local_only', { accountId: row.id });
    res.json({
      ok: true,
      account: toPublic(accounts.get(row.id) as ProviderAccountRow),
      revokedRemotely: result.revokedRemotely,
      warning: result.revokedRemotely
        ? null
        : 'CloudNest removed the local credentials, but the provider authorization may still be active. Review the provider’s security settings to revoke access manually. No remote files were deleted.',
    });
  });

  return router;
}
