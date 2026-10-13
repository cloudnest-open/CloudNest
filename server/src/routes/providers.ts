import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type Database from 'better-sqlite3';
import type { CredentialsStore } from '../providers/credentials-store.js';
import type { ProviderAccountService } from '../services/provider-account-service.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { getAdapter } from '../providers/registry.js';
import { PROVIDER_IDS, OAUTH_PROVIDER_IDS, ProviderError, type ProviderId, type ProviderCredentialBundle, type DecryptedProviderAppConfig } from '../providers/types.js';
import { callbackUri, oauthEndpoints, validatePcloudHost } from '../providers/oauth-endpoints.js';
import { startOAuthFlow, consumeOAuthState, makePkcePair } from '../providers/oauth-state.js';
import { providerFetch } from '../providers/types.js';

/** MEGA has no OAuth app config; every other provider does. */
function isOAuthProvider(value: string): value is Exclude<ProviderId, 'mega'> {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

export function providersRouter(deps: {
  db: Database.Database;
  queries: Queries;
  csrf: CsrfBundle;
  store: CredentialsStore;
  accounts: ProviderAccountService;
  appBaseUrl: string;
}): Router {
  const router = Router();
  const { db, queries, csrf, store, accounts, appBaseUrl } = deps;

  const connectLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
  const adminOnly = requireAdmin(queries);

  // ---- provider catalog ----
  router.get('/api/providers', adminOnly, (_req, res) => {
    const configs = store.listConfigSummaries();
    res.json({
      appBaseUrl,
      providers: PROVIDER_IDS.map((id) => {
        const adapter = getAdapter(id)!;
        const summary = configs.find((c) => c.provider === id) ?? null;
        return {
          id,
          displayName: adapter.displayName,
          experimental: adapter.experimental,
          requiresAppConfig: adapter.requiresAppConfig,
          callbackUri: adapter.requiresAppConfig ? callbackUri(appBaseUrl, id) : null,
          verificationStatus: summary?.verificationStatus ?? (adapter.requiresAppConfig ? 'not_configured' : 'n/a'),
          lastVerifiedAt: summary?.lastVerifiedAt ?? null,
          lastSafeErrorCode: summary?.lastSafeErrorCode ?? null,
        };
      }),
    });
  });

  // ---- provider app config ----
  router.put('/api/providers/:provider/config', adminOnly, csrf.doubleCsrfProtection, (req, res) => {
    const provider = String(req.params.provider);
    if (!isOAuthProvider(provider)) {
      res.status(400).json({ error: 'Unknown or unsupported provider.', code: 'provider_not_configured' });
      return;
    }
    const body = (req.body ?? {}) as { clientId?: unknown; clientSecret?: unknown; authority?: unknown; confirmReplace?: unknown };
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: 'Client ID and client secret are required.', code: 'provider_not_configured' });
      return;
    }
    if (provider === 'onedrive') {
      const authority = typeof body.authority === 'string' && body.authority.trim() ? body.authority.trim() : 'common';
      const valid = ['common', 'consumers', 'organizations'].includes(authority) || /^[0-9a-fA-F-]{36}$/.test(authority);
      if (!valid) {
        res.status(400).json({ error: 'Authority must be common, consumers, organizations, or a tenant ID.', code: 'provider_not_configured' });
        return;
      }
    }
    const existing = store.getConfigSummary(provider);
    const hasAccounts = accounts.list().some((a) => a.provider === provider && a.credential_ciphertext !== null);
    if (existing && hasAccounts && body.confirmReplace !== true) {
      res.status(409).json({
        error: 'Provider app credentials are already configured and accounts are connected. Changing them may require those accounts to reconnect.',
        code: 'provider_not_configured',
        requiresConfirmation: true,
      });
      return;
    }
    const config: DecryptedProviderAppConfig = {
      provider,
      clientId,
      clientSecret,
      ...(provider === 'onedrive' ? { extra: { authority: typeof body.authority === 'string' && body.authority.trim() ? body.authority.trim() : 'common' } } : {}),
    };
    store.saveAppConfig(provider, config, 'saved', null);
    queries.recordAudit('provider_config_saved', true, provider);
    res.json({ ok: true, verificationStatus: 'saved' });
  });

  // ---- OAuth start ----
  router.post('/api/providers/:provider/oauth/start', adminOnly, csrf.doubleCsrfProtection, connectLimiter, (req, res) => {
    const provider = String(req.params.provider);
    if (!isOAuthProvider(provider)) {
      res.status(400).json({ error: 'Provider does not support OAuth connection.', code: 'provider_not_configured' });
      return;
    }
    const cfg = store.getConfig(provider);
    if (!cfg) {
      res.status(409).json({ error: 'Provider setup is not configured. Open Settings → Provider Setup first.', code: 'provider_not_configured' });
      return;
    }
    const endpoints = oauthEndpoints(provider, cfg.config);
    const sessionId = req.sessionID;
    let pkce: { verifier: string; challengeS256: string } | null = null;
    if (endpoints.usesPkce) pkce = makePkcePair();
    let state: string;
    try {
      ({ state } = startOAuthFlow(provider, sessionId, pkce?.verifier));
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
    queries.recordAudit('provider_oauth_start', true, provider);
    res.json({ authorizationUrl: `${endpoints.authorizeUrl}?${params.toString()}` });
  });

  // ---- OAuth callback (GET; validated by one-time state + session, no CSRF token) ----
  router.get('/api/providers/:provider/oauth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const provider = String(req.params.provider);
    const redirectTo = (result: string) => res.redirect(303, `/cloud-accounts?connect=${encodeURIComponent(result)}`);

    if (!isOAuthProvider(provider)) return redirectTo('provider_not_configured');
    const session = req.session;
    if (!session?.adminId || typeof session.authVersion !== 'number') {
      // must be the same authenticated admin session that started the flow
      return redirectTo('oauth_state_invalid');
    }
    const admin = queries.getAdmin();
    if (!admin || session.authVersion !== admin.auth_version) return redirectTo('oauth_state_invalid');

    const stateRaw = typeof req.query.state === 'string' ? req.query.state : '';
    const consumed = stateRaw ? consumeOAuthState(stateRaw, provider, req.sessionID) : null;
    if (!consumed) return redirectTo('oauth_state_invalid');

    // provider-denial / error callbacks: consume state then fail safely, no account created
    if (typeof req.query.error === 'string') {
      queries.recordAudit('provider_oauth_callback', false, 'oauth_denied');
      return redirectTo('oauth_denied');
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return redirectTo('oauth_state_invalid');

    const cfg = store.getConfig(provider);
    if (!cfg) return redirectTo('provider_not_configured');
    const endpoints = oauthEndpoints(provider, cfg.config);

    try {
      let bundle: ProviderCredentialBundle;
      if (provider === 'pcloud') {
        // pCloud code flow: exchange then validate returned host/location pair
        const form = new URLSearchParams({ client_id: cfg.config.clientId, client_secret: cfg.config.clientSecret, code });
        const tokenRes = (await providerFetch('https://api.pcloud.com/oauth2_token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        })) as { access_token?: string; hostname?: string; locationid?: string | number; result?: number; error?: string };
        if (!tokenRes?.access_token) throw new ProviderError('token_exchange_failed', 502);
        const host = validatePcloudHost(tokenRes.hostname, String(tokenRes.locationid ?? ''));
        if (!host) throw new ProviderError('provider_unavailable', 502);
        bundle = { schemaVersion: 1, provider: 'pcloud', accessToken: tokenRes.access_token, apiHost: host, userId: '' };
      } else {
        const form = new URLSearchParams({
          code,
          client_id: cfg.config.clientId,
          client_secret: cfg.config.clientSecret,
          redirect_uri: callbackUri(appBaseUrl, provider),
          grant_type: 'authorization_code',
          ...(consumed.pkceVerifier ? { code_verifier: consumed.pkceVerifier } : {}),
        });
        const ex = endpoints.exchange(form);
        const tokenRes = (await providerFetch(ex.url, {
          method: 'POST',
          headers: { 'content-type': ex.contentType },
          body: ex.body,
        })) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
        if (!tokenRes?.access_token) throw new ProviderError('token_exchange_failed', 502);
        const grantedScopes = typeof tokenRes.scope === 'string' ? tokenRes.scope.split(/[\s,]+/).filter(Boolean) : endpoints.scopes;
        const expiresAt = typeof tokenRes.expires_in === 'number' ? Date.now() + tokenRes.expires_in * 1000 : undefined;
        if (provider === 'google_drive') {
          bundle = { schemaVersion: 1, provider: 'google_drive', accessToken: tokenRes.access_token, refreshToken: tokenRes.refresh_token, accessTokenExpiresAtMs: expiresAt, grantedScopes };
        } else if (provider === 'dropbox') {
          bundle = { schemaVersion: 1, provider: 'dropbox', accessToken: tokenRes.access_token, refreshToken: tokenRes.refresh_token, accessTokenExpiresAtMs: expiresAt, grantedScopes };
        } else {
          bundle = {
            schemaVersion: 1,
            provider: 'onedrive',
            accessToken: tokenRes.access_token,
            refreshToken: tokenRes.refresh_token,
            accessTokenExpiresAtMs: expiresAt,
            authority: cfg.config.extra?.['authority'] ?? 'common',
            grantedScopes,
          };
        }
        if (!tokenRes.refresh_token) {
          // no durable refresh path: do not claim a normal connected account
          const adapter = getAdapter(provider)!;
          let identity: NormalizedAccountLike | null = null;
          try {
            identity = await adapter.connectAndReadAccount(bundle, cfg.config);
          } catch {
            identity = null; // identity unavailable -> save no row
          }
          if (identity) {
            accounts.upsertConnection({ provider, account: { ...identity, safeErrorCode: 'refresh_token_missing' }, bundle });
            queries.recordAudit('provider_oauth_callback', false, 'refresh_token_missing');
            return redirectTo('refresh_token_missing');
          }
          queries.recordAudit('provider_oauth_callback', false, 'refresh_token_missing');
          return redirectTo('refresh_token_missing');
        }
      }

      const adapter = getAdapter(provider)!;
      const appConfig = provider === 'pcloud' ? undefined : cfg.config;
      const identity = await adapter.connectAndReadAccount(bundle, appConfig);
      if (provider === 'pcloud' && bundle.provider === 'pcloud') {
        bundle = { ...bundle, userId: identity.providerAccountId };
      }
      const { row } = accounts.upsertConnection({ provider, account: identity, bundle });
      store.markConfigVerified(provider);
      queries.recordAudit('provider_oauth_callback', true, provider, { accountId: row.id });
      return redirectTo('connected');
    } catch (err) {
      const code = err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      queries.recordAudit('provider_oauth_callback', false, code);
      return redirectTo(code);
    }
  });

  // ---- MEGA experimental connect ----
  router.post('/api/providers/mega/credentials', adminOnly, csrf.doubleCsrfProtection, connectLimiter, async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; secondFactorCode?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.', code: 'invalid_credentials' });
      return;
    }
    // secondFactorCode is accepted for the flow but never persisted or logged
    const bundle: ProviderCredentialBundle = { schemaVersion: 1, provider: 'mega', email, password };
    try {
      const adapter = getAdapter('mega')!;
      const identity = await adapter.connectAndReadAccount(bundle);
      const { row } = accounts.upsertConnection({ provider: 'mega', account: identity, bundle });
      queries.recordAudit('provider_mega_connect', true, 'mega', { accountId: row.id });
      res.status(201).json({ ok: true, accountId: row.id });
    } catch (err) {
      const code = err instanceof ProviderError ? err.safeCode : 'provider_unavailable';
      queries.recordAudit('provider_mega_connect', false, code);
      res.status(err instanceof ProviderError && err.httpStatus === 401 ? 401 : 502).json({ error: 'Could not connect the MEGA account.', code });
    } finally {
      // ensure no plaintext reference lingers longer than needed
      (req.body as Record<string, unknown>)['password'] = undefined;
    }
  });

  return router;
}

type NormalizedAccountLike = Awaited<ReturnType<NonNullable<ReturnType<typeof getAdapter>>['connectAndReadAccount']>>;
