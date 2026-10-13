import { providerFetch, ProviderError, type ProviderAdapter, type ProviderCredentialBundle, type NormalizedAccount, type NormalizedQuota, type DecryptedProviderAppConfig } from './types.js';

const REQUIRED_SCOPES = ['files.metadata.read', 'files.metadata.write', 'files.content.write', 'files.content.read'];

function isDropboxBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'dropbox' }> {
  return b.provider === 'dropbox';
}

async function ensureFresh(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<Extract<ProviderCredentialBundle, { provider: 'dropbox' }>> {
  if (!isDropboxBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  if (bundle.accessTokenExpiresAtMs === undefined || bundle.accessTokenExpiresAtMs > Date.now() + 60_000) return bundle;
  if (!bundle.refreshToken || !appConfig) throw new ProviderError('needs_reauth', 401);
  const tokenRes = (await providerFetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: appConfig.clientId,
      client_secret: appConfig.clientSecret,
    }).toString(),
  })) as { access_token?: string; expires_in?: number };
  if (!tokenRes?.access_token) throw new ProviderError('needs_reauth', 401);
  return { ...bundle, accessToken: tokenRes.access_token, accessTokenExpiresAtMs: Date.now() + Number(tokenRes.expires_in ?? 14400) * 1000 };
}

export const dropboxAdapter: ProviderAdapter = {
  id: 'dropbox',
  experimental: false,
  displayName: 'Dropbox',
  requiresAppConfig: true,
  capabilities: { upload: true, download: true, list: true },

  async connectAndReadAccount(bundle, appConfig): Promise<NormalizedAccount> {
    const fresh = await ensureFresh(bundle, appConfig);
    const account = (await providerFetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { authorization: `Bearer ${fresh.accessToken}` },
      body: 'null',
    })) as { account_id?: string; email?: string; name?: { display_name?: string } };
    if (!account?.account_id) throw new ProviderError('identity_validation_failed', 502);
    const granted = fresh.grantedScopes ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length > 0 && granted.length > 0) {
      // connected but scopes are insufficient for planned transfers; surface honestly
      return {
        providerAccountId: account.account_id,
        displayLabel: account.email ?? account.name?.display_name ?? account.account_id,
        quota: { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' },
        grantedScopes: granted,
        safeErrorCode: 'needs_reauth',
      };
    }
    // space usage is a separate official endpoint
    let quota: NormalizedQuota = { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' };
    try {
      const space = (await providerFetch('https://api.dropboxapi.com/2/users/get_space_usage', {
        method: 'POST',
        headers: { authorization: `Bearer ${fresh.accessToken}` },
        body: 'null',
      })) as { used?: number; allocation?: { allocated?: number } };
      const total = space?.allocation?.allocated;
      quota = {
        usedBytes: typeof space?.used === 'number' ? space.used : null,
        totalBytes: typeof total === 'number' ? total : null,
        status: typeof space?.used === 'number' ? 'current' : 'unknown',
      };
      if (quota.status === 'unknown') quota.safeErrorCode = 'quota_unavailable';
    } catch {
      // quota-only failure keeps the account connected with unknown quota
    }
    return {
      providerAccountId: account.account_id,
      displayLabel: account.email ?? account.name?.display_name ?? account.account_id,
      quota,
      grantedScopes: granted,
    };
  },

  async getQuota(bundle, appConfig): Promise<NormalizedQuota> {
    const fresh = await ensureFresh(bundle, appConfig);
    try {
      const space = (await providerFetch('https://api.dropboxapi.com/2/users/get_space_usage', {
        method: 'POST',
        headers: { authorization: `Bearer ${fresh.accessToken}` },
        body: 'null',
      })) as { used?: number; allocation?: { allocated?: number } };
      const total = space?.allocation?.allocated;
      return {
        usedBytes: typeof space?.used === 'number' ? space.used : null,
        totalBytes: typeof total === 'number' ? total : null,
        status: typeof space?.used === 'number' ? 'current' : 'unknown',
        safeErrorCode: typeof space?.used === 'number' ? undefined : 'quota_unavailable',
      };
    } catch (err) {
      if (err instanceof ProviderError && (err.safeCode === 'needs_reauth' || err.safeCode === 'provider_rate_limited')) throw err;
      return { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' };
    }
  },

  async ensureValidCredentials(bundle, appConfig) {
    return ensureFresh(bundle, appConfig);
  },
};

export { REQUIRED_SCOPES as DROPBOX_REQUIRED_SCOPES };
