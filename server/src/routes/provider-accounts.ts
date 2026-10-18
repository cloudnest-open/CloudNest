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
    /** M0019 (wizard §3): the owner's S3 provider name; null = generic label. */
    providerDisplayName: row.provider_display_name ?? null,
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
    const body = (req.body ?? {}) as { displayLabel?: unknown; reserveBytes?: unknown; participatesInUploads?: unknown; capacityCapBytes?: unknown; providerDisplayName?: unknown };
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
    // Wizard §4 (S3 special): the capacity-cap edit lives on the same surface.
    if (typeof body.capacityCapBytes === 'number' || body.capacityCapBytes === null) {
      const cap = body.capacityCapBytes;
      if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) {
        res.status(400).json({ error: 'Capacity cap must be a positive integer of bytes.' });
        return;
      }
      if (row.provider !== 's3') {
        res.status(400).json({ error: 'Only S3-compatible accounts take a capacity cap.', code: 'invalid_request' });
        return;
      }
      accounts.setCapacityCap(row.id, cap);
    }
    // M0019 (wizard §3): the owner's provider name; null restores the generic.
    if (typeof body.providerDisplayName === 'string' || body.providerDisplayName === null) {
      const name = body.providerDisplayName;
      if (name !== null && (name.trim().length === 0 || name.trim().length > 60)) {
        res.status(400).json({ error: 'Provider name must be 1–60 characters.' });
        return;
      }
      if (name !== null && row.provider !== 's3') {
        res.status(400).json({ error: 'Only S3-compatible accounts take a custom provider name.', code: 'invalid_request' });
        return;
      }
      accounts.setProviderDisplayName(row.id, name);
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

  router.post('/api/provider-accounts/:id/reconnect', adminOnly, csrf.doubleCsrfProtection, refreshLimiter, async (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const body = (req.body ?? {}) as { mode?: unknown };
    // Wizard §4: "Reconnect" on a live OAuth account first tries the silent
    // token refresh (the scheduler's own path); the browser flow stays the
    // honest fallback when the provider has revoked the grant.
    if (body.mode === 'refresh' && row.provider !== 'mega' && row.provider !== 's3') {
      if (!row.credential_ciphertext) {
        res.status(409).json({ error: 'No stored credentials to refresh.', code: 'account_needs_reauth' });
        return;
      }
      const result = await refreshOne(row);
      const updated = accounts.get(row.id) as ProviderAccountRow;
      res.json({ mode: 'refreshed', result, account: toPublic(updated) });
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
      // wizard §1: this flow re-authorizes THIS row — the state carries the
      // account id so the callback may upsert instead of refusing a duplicate
      ({ state } = startOAuthFlow(provider, req.sessionID, pkce?.verifier, row.id));
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

  // ---- wizard §4: Test/Verify on the one management surface ----
  // Proves the stored credential still works RIGHT NOW with the provider's
  // own cheapest identity call (S3 HeadBucket, OAuth refresh/validate, MEGA
  // login). Never mutates the account; failures carry the safe code.
  router.post('/api/provider-accounts/:id/verify', adminOnly, csrf.doubleCsrfProtection, refreshLimiter, async (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const adapter = getAdapter(row.provider);
    if (!adapter) {
      res.status(400).json({ error: 'Unknown provider.', code: 'invalid_request' });
      return;
    }
    const bundle = row.credential_ciphertext ? store.loadAccountBundle(row) : null;
    if (!bundle) {
      res.status(409).json({ error: 'No stored credentials to verify.', code: 'account_needs_reauth' });
      return;
    }
    try {
      const cfg = adapter.requiresAppConfig ? store.getConfig(row.provider)?.config : undefined;
      // refresh-or-validate first: an expiring token gets renewed, a revoked
      // grant surfaces as account_needs_reauth instead of a fake "ok"
      const validBundle = await adapter.ensureValidCredentials(bundle, cfg);
      if (validBundle !== bundle) accounts.saveRefreshedBundle(row, validBundle);
      const identity = await adapter.connectAndReadAccount(validBundle, cfg);
      const updated = accounts.get(row.id) as ProviderAccountRow;
      queries.recordAudit('provider_verify', true, row.provider, { accountId: row.id });
      res.json({
        ok: true,
        accountIdentifier: identity.providerAccountId,
        quotaStatus: (accounts.get(row.id) as ProviderAccountRow).quota_status,
        status: updated.status,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      const code = err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      const httpStatus = err instanceof ProviderError && err.httpStatus === 401 ? 401 : 502;
      queries.recordAudit('provider_verify', false, code, { accountId: row.id });
      res.status(httpStatus).json({ ok: false, error: 'Verification failed.', code });
    }
  });

  // ---- wizard §4: Edit/Replace credentials (S3/MEGA accounts, same surface)
  // The OAuth providers edit their APP config through PUT /api/providers/:p/config —
  // their account credential is a browser-granted token, never hand-typed.
  router.post('/api/provider-accounts/:id/credentials', adminOnly, csrf.doubleCsrfProtection, async (req, res) => {
    const row = accounts.get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const adapter = getAdapter(row.provider);
    if (!adapter) {
      res.status(400).json({ error: 'Unknown provider.', code: 'invalid_request' });
      return;
    }
    if (row.provider !== 's3' && row.provider !== 'mega') {
      res.status(409).json({
        error: 'OAuth accounts are re-authorized in the browser; edit the app config instead.',
        code: 'oauth_account',
      });
      return;
    }
    try {
      let bundle: import('../providers/types.js').ProviderCredentialBundle;
      let accountIdentifier: string | undefined;
      if (row.provider === 's3') {
        const endpoint = typeof body['endpoint'] === 'string' ? (body['endpoint'] as string).trim() : '';
        const region = typeof body['region'] === 'string' && (body['region'] as string).trim() ? (body['region'] as string).trim() : 'auto';
        const accessKeyId = typeof body['accessKeyId'] === 'string' ? (body['accessKeyId'] as string).trim() : '';
        const secretAccessKey = typeof body['secretAccessKey'] === 'string' ? (body['secretAccessKey'] as string) : '';
        const bucket = typeof body['bucket'] === 'string' ? (body['bucket'] as string).trim() : '';
        const prefixRaw = typeof body['prefix'] === 'string' && (body['prefix'] as string).trim() ? (body['prefix'] as string).trim() : 'cloudnest';
        if (!accessKeyId || !secretAccessKey || !bucket) {
          res.status(400).json({ error: 'Access key, secret key and bucket are required.', code: 'invalid_credentials' });
          return;
        }
        bundle = { schemaVersion: 1, provider: 's3', endpoint, region, accessKeyId, secretAccessKey, bucket, prefix: `${prefixRaw.replace(/\/+$/, '')}/` };
        const identity = await adapter.connectAndReadAccount(bundle);
        accountIdentifier = identity.providerAccountId;
        const { row: updated } = accounts.upsertConnection({ provider: 's3', account: identity, bundle, tier: 'business' });
        queries.recordAudit('provider_credentials_replaced', true, 's3', { accountId: updated.id });
        (req.body as Record<string, unknown>)['secretAccessKey'] = undefined;
        res.json({ ok: true, account: toPublic(updated) });
        return;
      }
      // mega
      const email = typeof body['email'] === 'string' ? (body['email'] as string).trim() : '';
      const password = typeof body['password'] === 'string' ? (body['password'] as string) : '';
      const secondFactorCode = typeof body['secondFactorCode'] === 'string' && (body['secondFactorCode'] as string).trim()
        ? (body['secondFactorCode'] as string).trim()
        : undefined;
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.', code: 'invalid_credentials' });
        return;
      }
      bundle = { schemaVersion: 1, provider: 'mega', email, password, ...(secondFactorCode ? { secondFactorCode } : {}) };
      const identity = await adapter.connectAndReadAccount(bundle);
      const { row: updated } = accounts.upsertConnection({ provider: 'mega', account: identity, bundle });
      queries.recordAudit('provider_credentials_replaced', true, 'mega', { accountId: updated.id });
      (req.body as Record<string, unknown>)['password'] = undefined;
      res.json({ ok: true, account: toPublic(updated) });
      void accountIdentifier;
    } catch (err) {
      const code = err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      const httpStatus = err instanceof ProviderError && err.httpStatus === 401 ? 401 : 502;
      queries.recordAudit('provider_credentials_replaced', false, code, { accountId: row.id });
      res.status(httpStatus).json({ error: 'The provider rejected these credentials.', code });
    }
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
