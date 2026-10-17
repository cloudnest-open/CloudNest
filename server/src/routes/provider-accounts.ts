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
// Roadmap Phase 5: the ONE quota-refresh path, shared with the background
// scheduler — the router keeps the audit trail, the module owns the logic.
import { refreshOneAccountQuota, refreshAllAccountQuotas } from '../services/quota-refresh.js';

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
    /** M0016: false = the account takes no NEW placements (plan/reassign/mirror). */
    participatesInUploads: row.participates_in_uploads !== 0,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    hasCredentials: row.credential_ciphertext !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    const result = await refreshOneAccountQuota(row, accounts, store);
    // same audit shape as before the extraction: the failure lands here, the
    // single-account route adds its own success/failure row on top
    if (!result.ok) {
      queries.recordAudit('provider_quota_refresh', false, result.code ?? 'provider_unavailable', { accountId: row.id });
    }
    return result;
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
    const results = await refreshAllAccountQuotas(rows, accounts, store);
    queries.recordAudit('provider_quota_refresh_all', true, 'batch', { count: results.length });
    res.json({ results });
  });

  router.patch('/api/provider-accounts/:id', adminOnly, csrf.doubleCsrfProtection, (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const body = (req.body ?? {}) as { displayLabel?: unknown; reserveBytes?: unknown; participatesInUploads?: unknown };
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
    // M0016: marking out of participation never deletes anything — it only
    // stops NEW placements; existing chunks stay readable.
    if (typeof body.participatesInUploads === 'boolean') {
      accounts.setParticipation(row.id, body.participatesInUploads);
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
