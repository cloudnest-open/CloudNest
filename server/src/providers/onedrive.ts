import { providerFetch, ProviderError, type ProviderAdapter, type ProviderCredentialBundle, type NormalizedAccount, type NormalizedQuota, type DecryptedProviderAppConfig } from './types.js';

export const VALID_AUTHORITIES = new Set(['common', 'consumers', 'organizations']);
const REQUIRED_SCOPES = ['offline_access', 'Files.ReadWrite'];

function isOnedriveBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'onedrive' }> {
  return b.provider === 'onedrive';
}

function authorityHost(authority: string): string {
  // authority is like "common" | "consumers" | "organizations" | a tenant GUID
  if (VALID_AUTHORITIES.has(authority)) return `https://login.microsoftonline.com/${authority}`;
  if (/^[0-9a-fA-F-]{36}$/.test(authority)) return `https://login.microsoftonline.com/${authority}`;
  throw new ProviderError('provider_unavailable', 400);
}

async function ensureFresh(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<Extract<ProviderCredentialBundle, { provider: 'onedrive' }>> {
  if (!isOnedriveBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  if (bundle.accessTokenExpiresAtMs === undefined || bundle.accessTokenExpiresAtMs > Date.now() + 60_000) return bundle;
  if (!bundle.refreshToken || !appConfig) throw new ProviderError('needs_reauth', 401);
  const tokenRes = (await providerFetch(`${authorityHost(bundle.authority)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appConfig.clientId,
      client_secret: appConfig.clientSecret,
      refresh_token: bundle.refreshToken,
      grant_type: 'refresh_token',
      scope: 'offline_access Files.ReadWrite',
    }).toString(),
  })) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!tokenRes?.access_token) throw new ProviderError('needs_reauth', 401);
  return {
    ...bundle,
    accessToken: tokenRes.access_token,
    accessTokenExpiresAtMs: Date.now() + Number(tokenRes.expires_in ?? 3600) * 1000,
    refreshToken: tokenRes.refresh_token ?? bundle.refreshToken,
  };
}

export const onedriveAdapter: ProviderAdapter = {
  id: 'onedrive',
  experimental: false,
  displayName: 'OneDrive',
  requiresAppConfig: true,
  capabilities: { upload: true, download: true, list: true },

  async connectAndReadAccount(bundle, appConfig): Promise<NormalizedAccount> {
    const fresh = await ensureFresh(bundle, appConfig);
    const drive = (await providerFetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,owner,quota', {
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    })) as {
      id?: string;
      owner?: { user?: { id?: string; displayName?: string; email?: string } };
      quota?: { total?: number; used?: number; remaining?: number };
    };
    const driveId = drive?.id;
    const ownerId = drive?.owner?.user?.id;
    if (!driveId || !ownerId) throw new ProviderError('identity_validation_failed', 502);
    const total = typeof drive.quota?.total === 'number' ? drive.quota.total : null;
    const used = typeof drive.quota?.used === 'number' ? drive.quota.used : null;
    const granted = fresh.grantedScopes ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    return {
      providerAccountId: ownerId,
      displayLabel: drive.owner?.user?.email ?? drive.owner?.user?.displayName ?? ownerId,
      quota: {
        totalBytes: total,
        usedBytes: used,
        status: total !== null || used !== null ? 'current' : 'unknown',
        safeErrorCode: total === null && used === null ? 'quota_unavailable' : undefined,
      },
      grantedScopes: granted,
      safeErrorCode: missing.length > 0 && granted.length > 0 ? 'needs_reauth' : undefined,
    };
  },

  async getQuota(bundle, appConfig): Promise<NormalizedQuota> {
    const fresh = await ensureFresh(bundle, appConfig);
    try {
      const drive = (await providerFetch('https://graph.microsoft.com/v1.0/me/drive?$select=quota', {
        headers: { authorization: `Bearer ${fresh.accessToken}` },
      })) as { quota?: { total?: number; used?: number } };
      const total = typeof drive?.quota?.total === 'number' ? drive.quota.total : null;
      const used = typeof drive?.quota?.used === 'number' ? drive.quota.used : null;
      return {
        totalBytes: total,
        usedBytes: used,
        status: total !== null || used !== null ? 'current' : 'unknown',
        safeErrorCode: total === null && used === null ? 'quota_unavailable' : undefined,
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

export { REQUIRED_SCOPES as ONEDRIVE_REQUIRED_SCOPES };
