import { Readable } from 'node:stream';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCredentialBundle,
  type NormalizedAccount,
  type NormalizedQuota,
  type EnsureAppRootResult,
  type RemoteObjectRef,
  type UploadObjectStreamParams,
} from '../src/providers/types.js';

/**
 * Deterministic in-memory provider adapter for same-provider multi-account
 * regression tests (task §4: "mocked provider adapters", no real credentials).
 *
 * Isolation model: every stored object is namespaced under the CONNECTING
 * account's credential identity (access token / user id). A second account of
 * the SAME provider therefore cannot read another account's object by key —
 * mirroring the real per-account remote namespace. That is what makes the
 * account-mapping tests meaningful: a download that resolves the wrong
 * account's credentials fails instead of silently returning foreign bytes.
 */

const GIB = 1024 * 1024 * 1024;

export type FakeBundle = ProviderCredentialBundle;

/** Stable per-account credential identity used for namespacing. */
export function fakeAccountKey(bundle: FakeBundle): string {
  if ('accessToken' in bundle) return bundle.accessToken;
  if ('userId' in bundle) return `pcloud-${bundle.userId}`;
  if ('email' in bundle) return `mega-${bundle.email}`;
  return 'unknown';
}

export interface FakeStoredObject {
  accountKey: string;
  objectKey: string;
  bytes: Buffer;
  deleted: boolean;
}

export interface FakeAdapterLog {
  uploads: Array<{ accountKey: string; objectKey: string; sizeBytes: number }>;
  downloads: Array<{ accountKey: string; remoteObjectId: string }>;
  deleteAttempts: Array<{ accountKey: string; remoteObjectId: string; deleted: boolean }>;
  quotaReads: string[];
  connects: string[];
}

export interface FakeAdapterOptions {
  /** Artificial delay in connectAndReadAccount — widens the concurrent-callback race window. */
  connectDelayMs?: number;
  /** Quota reads fail (safe quota_unavailable) for these account keys. */
  failQuotaFor?: string[];
  /** ensureValidCredentials returns a rotated token (exercises per-account refresh persistence). */
  rotateRefreshFor?: string[];
}

export interface FakeAdapterHandle {
  adapter: ProviderAdapter;
  /** All objects ever uploaded, keyed by `${accountKey}/${objectKey}`. */
  store: Map<string, FakeStoredObject>;
  log: FakeAdapterLog;
  quotaFor: (accountKey: string) => NormalizedQuota;
}

export function makeFakeAdapter(
  provider: 'google_drive' | 'dropbox' | 'onedrive' | 'pcloud',
  options: FakeAdapterOptions = {},
): FakeAdapterHandle {
  const store = new Map<string, FakeStoredObject>();
  const log: FakeAdapterLog = { uploads: [], downloads: [], deleteAttempts: [], quotaReads: [], connects: [] };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function accountKeyOf(bundle: FakeBundle): string {
    return fakeAccountKey(bundle);
  }

  function quotaFor(_accountKey: string): NormalizedQuota {
    return { totalBytes: 10 * GIB, usedBytes: 0, status: 'current' };
  }

  const adapter: ProviderAdapter = {
    id: provider,
    experimental: false,
    displayName: `Fake ${provider}`,
    requiresAppConfig: provider !== 'pcloud',
    capabilities: { upload: true, download: true, list: true },

    async connectAndReadAccount(bundle): Promise<NormalizedAccount> {
      if (options.connectDelayMs) await sleep(options.connectDelayMs);
      const accountKey = accountKeyOf(bundle);
      log.connects.push(accountKey);
      return {
        providerAccountId: `ident-${accountKey}`,
        displayLabel: `${accountKey}@fake.example`,
        quota: quotaFor(accountKey),
      };
    },

    async getQuota(bundle): Promise<NormalizedQuota> {
      const accountKey = accountKeyOf(bundle);
      log.quotaReads.push(accountKey);
      if (options.failQuotaFor?.includes(accountKey)) {
        throw new ProviderError('quota_unavailable', 502, `quota unavailable for ${accountKey}`);
      }
      return quotaFor(accountKey);
    },

    async ensureValidCredentials(bundle) {
      const accountKey = accountKeyOf(bundle);
      if (options.rotateRefreshFor?.includes(accountKey) && 'refreshToken' in bundle && bundle.refreshToken) {
        return { ...bundle, refreshToken: `${bundle.refreshToken}-rotated` } as FakeBundle;
      }
      return bundle;
    },

    async revokeOrClose(bundle) {
      void bundle;
      return { revoked: true };
    },

    async ensureAppRoot(bundle): Promise<EnsureAppRootResult> {
      return { remoteRootId: `root-${accountKeyOf(bundle)}`, created: false };
    },

    async uploadObjectStream(bundle, params: UploadObjectStreamParams): Promise<RemoteObjectRef> {
      const accountKey = accountKeyOf(bundle);
      const parts: Buffer[] = [];
      for await (const piece of params.readable) {
        if (params.signal?.aborted) throw new ProviderError('upload_aborted', 499);
        parts.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as unknown as Uint8Array));
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length !== params.sizeBytes) {
        throw new ProviderError('provider_checksum_mismatch', 502, 'fake adapter received the wrong byte count');
      }
      store.set(`${accountKey}/${params.objectKey}`, { accountKey, objectKey: params.objectKey, bytes, deleted: false });
      log.uploads.push({ accountKey, objectKey: params.objectKey, sizeBytes: bytes.length });
      return { remoteObjectId: params.objectKey, objectKey: params.objectKey, sizeBytes: bytes.length };
    },

    async findAppObjectByKey(bundle, _rootId, objectKey): Promise<RemoteObjectRef | null> {
      const accountKey = accountKeyOf(bundle);
      const obj = store.get(`${accountKey}/${objectKey}`);
      if (!obj || obj.deleted) return null;
      return { remoteObjectId: objectKey, objectKey, sizeBytes: obj.bytes.length };
    },

    async listAppObjects(bundle): Promise<RemoteObjectRef[]> {
      const accountKey = accountKeyOf(bundle);
      const refs: RemoteObjectRef[] = [];
      for (const obj of store.values()) {
        if (obj.accountKey === accountKey && !obj.deleted) {
          refs.push({ remoteObjectId: obj.objectKey, objectKey: obj.objectKey, sizeBytes: obj.bytes.length });
        }
      }
      return refs;
    },

    async deleteAppObject(bundle, _rootId, remoteObjectId) {
      const accountKey = accountKeyOf(bundle);
      const obj = store.get(`${accountKey}/${remoteObjectId}`);
      const deleted = obj !== undefined;
      if (obj) obj.deleted = true;
      log.deleteAttempts.push({ accountKey, remoteObjectId, deleted });
      return { deleted };
    },

    async downloadObjectStream(bundle, remoteObjectId) {
      const accountKey = accountKeyOf(bundle);
      const obj = store.get(`${accountKey}/${remoteObjectId}`);
      if (!obj || obj.deleted) {
        // the real adapters surface a missing object as a provider error; the
        // download service translates that into its own safe codes
        throw new ProviderError('provider_object_missing', 404, `no object ${remoteObjectId} for ${accountKey}`);
      }
      log.downloads.push({ accountKey, remoteObjectId });
      const bytes = obj.bytes;
      return { stream: Readable.from(bytes), sizeBytes: bytes.length, contentType: 'application/octet-stream' };
    },
  };

  return { adapter, store, log, quotaFor };
}
