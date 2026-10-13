import { providerFetch, ProviderError, type ProviderAdapter, type ProviderCredentialBundle, type NormalizedAccount, type NormalizedQuota, type DecryptedProviderAppConfig } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

function isGoogleBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'google_drive' }> {
  return b.provider === 'google_drive';
}

async function ensureFresh(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<Extract<ProviderCredentialBundle, { provider: 'google_drive' }>> {
  if (!isGoogleBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  if (bundle.accessTokenExpiresAtMs === undefined || bundle.accessTokenExpiresAtMs > Date.now() + 60_000) {
    return bundle;
  }
  if (!bundle.refreshToken || !appConfig) throw new ProviderError('needs_reauth', 401);
  const tokenRes = (await providerFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appConfig.clientId,
      client_secret: appConfig.clientSecret,
      refresh_token: bundle.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!tokenRes?.access_token) throw new ProviderError('needs_reauth', 401);
  // a refresh response without a new refresh token preserves the old one
  return {
    ...bundle,
    accessToken: tokenRes.access_token,
    accessTokenExpiresAtMs: Date.now() + Number(tokenRes.expires_in ?? 3600) * 1000,
    refreshToken: tokenRes.refresh_token ?? bundle.refreshToken,
  };
}

export const googleDriveAdapter: ProviderAdapter = {
  id: 'google_drive',
  experimental: false,
  displayName: 'Google Drive',
  requiresAppConfig: true,

  async connectAndReadAccount(bundle, appConfig): Promise<NormalizedAccount> {
    const fresh = await ensureFresh(bundle, appConfig);
    const about = (await providerFetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)',
      { headers: { authorization: `Bearer ${fresh.accessToken}` } },
    )) as {
      user?: { permissionId?: string; displayName?: string; emailAddress?: string };
      storageQuota?: { limit?: string; usage?: string; usageInDrive?: string };
    };
    const permissionId = about?.user?.permissionId;
    if (!permissionId) throw new ProviderError('identity_validation_failed', 502);
    const limitRaw = about.storageQuota?.limit;
    const usageRaw = about.storageQuota?.usageInDrive ?? about.storageQuota?.usage;
    const quota: NormalizedQuota = {
      totalBytes: limitRaw !== undefined ? Number(limitRaw) : null,
      usedBytes: usageRaw !== undefined ? Number(usageRaw) : null,
      status: limitRaw !== undefined || usageRaw !== undefined ? 'current' : 'unknown',
    };
    if (quota.status === 'unknown') quota.safeErrorCode = 'quota_unavailable';
    return {
      providerAccountId: permissionId,
      displayLabel: about.user?.emailAddress ?? about.user?.displayName ?? permissionId,
      quota,
      grantedScopes: fresh.grantedScopes,
      safeErrorCode: fresh.refreshToken ? undefined : 'refresh_token_missing',
    };
  },

  async getQuota(bundle, appConfig): Promise<NormalizedQuota> {
    const fresh = await ensureFresh(bundle, appConfig);
    try {
      const about = (await providerFetch(
        'https://www.googleapis.com/drive/v3/about?fields=storageQuota(limit,usage,usageInDrive,usageInDriveTrash)',
        { headers: { authorization: `Bearer ${fresh.accessToken}` } },
      )) as { storageQuota?: { limit?: string; usage?: string; usageInDrive?: string } };
      const limitRaw = about?.storageQuota?.limit;
      const usageRaw = about?.storageQuota?.usageInDrive ?? about?.storageQuota?.usage;
      return {
        totalBytes: limitRaw !== undefined ? Number(limitRaw) : null,
        usedBytes: usageRaw !== undefined ? Number(usageRaw) : null,
        status: limitRaw !== undefined || usageRaw !== undefined ? 'current' : 'unknown',
        safeErrorCode: limitRaw === undefined && usageRaw === undefined ? 'quota_unavailable' : undefined,
      };
    } catch (err) {
      if (err instanceof ProviderError && err.safeCode === 'provider_rate_limited') throw err;
      if (err instanceof ProviderError && err.safeCode === 'needs_reauth') throw err;
      return { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' };
    }
  },

  async ensureValidCredentials(bundle, appConfig) {
    return ensureFresh(bundle, appConfig);
  },
};

export { SCOPE as GOOGLE_DRIVE_SCOPE };
