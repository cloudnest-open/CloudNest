import { providerFetch, ProviderError, type ProviderAdapter, type ProviderCredentialBundle, type NormalizedAccount, type NormalizedQuota } from './types.js';
import {
  ensureAppRootImpl,
  uploadObjectStreamImpl,
  findAppObjectByKeyImpl,
  listAppObjectsImpl,
  deleteAppObjectImpl,
  downloadObjectStreamImpl,
} from './pcloud-files.js';

const ALLOWED_HOSTS = new Set(['api.pcloud.com', 'eapi.pcloud.com']);

function isPcloudBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'pcloud' }> {
  return b.provider === 'pcloud';
}

function assertAllowedHost(host: string): void {
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ProviderError('provider_unavailable', 400);
  }
}

export const pcloudAdapter: ProviderAdapter = {
  id: 'pcloud',
  experimental: false,
  displayName: 'pCloud',
  requiresAppConfig: true,
  capabilities: { upload: true, download: true, list: true },

  async connectAndReadAccount(bundle): Promise<NormalizedAccount> {
    if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
    assertAllowedHost(bundle.apiHost);
    const info = (await providerFetch(
      `https://${bundle.apiHost}/userinfo?access_token=${encodeURIComponent(bundle.accessToken)}`,
    )) as { userid?: number; email?: string; quota?: number; usedquota?: number };
    if (typeof info?.userid !== 'number') throw new ProviderError('identity_validation_failed', 502);
    return {
      providerAccountId: String(info.userid),
      displayLabel: info.email ?? String(info.userid),
      quota: {
        totalBytes: typeof info.quota === 'number' ? info.quota : null,
        usedBytes: typeof info.usedquota === 'number' ? info.usedquota : null,
        status: typeof info.quota === 'number' || typeof info.usedquota === 'number' ? 'current' : 'unknown',
        safeErrorCode: typeof info.quota === 'number' ? undefined : 'quota_unavailable',
      },
    };
  },

  async getQuota(bundle): Promise<NormalizedQuota> {
    if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
    assertAllowedHost(bundle.apiHost);
    try {
      const info = (await providerFetch(
        `https://${bundle.apiHost}/userinfo?access_token=${encodeURIComponent(bundle.accessToken)}`,
      )) as { quota?: number; usedquota?: number };
      return {
        totalBytes: typeof info?.quota === 'number' ? info.quota : null,
        usedBytes: typeof info?.usedquota === 'number' ? info.usedquota : null,
        status: typeof info?.quota === 'number' || typeof info?.usedquota === 'number' ? 'current' : 'unknown',
        safeErrorCode: typeof info?.quota === 'number' || typeof info?.usedquota === 'number' ? undefined : 'quota_unavailable',
      };
    } catch (err) {
      if (err instanceof ProviderError && (err.safeCode === 'needs_reauth' || err.safeCode === 'provider_rate_limited')) throw err;
      return { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' };
    }
  },

  async ensureValidCredentials(bundle) {
    if (!isPcloudBundle(bundle)) throw new ProviderError('needs_reauth', 401);
    // pCloud tokens are non-expiring; validate by a cheap userinfo call in getQuota paths.
    return bundle;
  },

  // ---- file-object primitives (Step 4 / M7) ----
  async ensureAppRoot(bundle, appConfig) {
    return ensureAppRootImpl(bundle, appConfig);
  },
  async uploadObjectStream(bundle, params, appConfig) {
    return uploadObjectStreamImpl(bundle, params, appConfig);
  },
  async findAppObjectByKey(bundle, rootId, objectKey, appConfig) {
    return findAppObjectByKeyImpl(bundle, rootId, objectKey, appConfig);
  },
  async listAppObjects(bundle, rootId, appConfig) {
    return listAppObjectsImpl(bundle, rootId, appConfig);
  },
  async deleteAppObject(bundle, rootId, remoteObjectId, appConfig) {
    return deleteAppObjectImpl(bundle, rootId, remoteObjectId, appConfig);
  },
  async downloadObjectStream(bundle, remoteObjectId, appConfig, range) {
    return downloadObjectStreamImpl(bundle, remoteObjectId, appConfig, range);
  },

  async revokeOrClose(bundle) {
    if (!isPcloudBundle(bundle)) return { revoked: false, safeErrorCode: 'provider_unavailable' as const };
    try {
      assertAllowedHost(bundle.apiHost);
      await providerFetch(`https://${bundle.apiHost}/logout?access_token=${encodeURIComponent(bundle.accessToken)}`);
      return { revoked: true };
    } catch {
      return { revoked: false, safeErrorCode: 'provider_unavailable' as const };
    }
  },
};
