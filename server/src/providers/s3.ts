import {
  ensureAppRootImpl,
  uploadObjectStreamImpl,
  findAppObjectByKeyImpl,
  listAppObjectsImpl,
  deleteAppObjectImpl,
  downloadObjectStreamImpl,
  headBucketImpl,
  isS3Bundle,
} from './s3-files.js';
import { ProviderError, type ProviderAdapter, type NormalizedAccount } from './types.js';

/**
 * S3-compatible adapter (roadmap Phase 1): Cloudflare R2, Backblaze B2,
 * AWS S3 and any S3-compatible endpoint. Business tier only — the routing
 * policy keeps business files off personal OAuth pools (and vice versa).
 *
 * Honesty rules:
 * - S3 exposes no quota API. The adapter therefore reports `unknown` quota;
 *   the account service supplies the owner-set capacity cap plus
 *   CloudNest-tracked byte sums, which is the only truthful accounting.
 * - Static access keys do not expire, so ensureValidCredentials is identity
 *   validation only; wrong keys surface as invalid_credentials on use.
 * - Mock-tested like every other connector until a live smoke test runs.
 */
export const s3Adapter: ProviderAdapter = {
  id: 's3',
  experimental: false,
  displayName: 'S3-compatible',
  requiresAppConfig: false,
  capabilities: { upload: true, download: true, list: true },

  async connectAndReadAccount(bundle): Promise<NormalizedAccount> {
    if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
    await headBucketImpl(bundle);
    const host = new URL(bundle.endpoint).host;
    return {
      providerAccountId: `${bundle.bucket}@${host}`,
      displayLabel: bundle.bucket,
      // the owner-set cap is applied by the connect route (service layer);
      // the adapter itself has no honest quota claim to make
      quota: { totalBytes: null, usedBytes: null, status: 'unknown' },
    };
  },

  async getQuota() {
    // no S3 quota API exists; the refresh path computes the truthful
    // cap-based/tracked quota in the service layer instead of calling this
    return { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' };
  },

  async ensureValidCredentials(bundle) {
    if (!isS3Bundle(bundle)) throw new ProviderError('invalid_credentials', 401);
    return bundle;
  },

  // ---- file-object primitives (roadmap Phase 1) ----
  async ensureAppRoot(bundle) {
    return ensureAppRootImpl(bundle);
  },
  async uploadObjectStream(bundle, params) {
    return uploadObjectStreamImpl(bundle, params);
  },
  async findAppObjectByKey(bundle, rootId, objectKey) {
    return findAppObjectByKeyImpl(bundle, rootId, objectKey);
  },
  async listAppObjects(bundle, rootId) {
    return listAppObjectsImpl(bundle, rootId);
  },
  async deleteAppObject(bundle, rootId, remoteObjectId) {
    return deleteAppObjectImpl(bundle, rootId, remoteObjectId);
  },
  async downloadObjectStream(bundle, remoteObjectId, appConfig, range) {
    return downloadObjectStreamImpl(bundle, remoteObjectId, appConfig, range);
  },
};
