import { Readable } from 'node:stream';
import { ProviderError, type ProviderCredentialBundle, type RemoteObjectRef, type UploadObjectStreamParams, type EnsureAppRootResult } from './types.js';
import { sha256Hex, signS3Request, presignS3Request } from './s3-signature.js';

/**
 * S3-compatible file-object primitives (roadmap Phase 1).
 *
 * Design notes:
 * - Path-style URLs (`https://endpoint/bucket/key`) so Cloudflare R2,
 *   Backblaze B2 and AWS S3 all behave identically on one code path.
 * - The CloudNest-managed namespace is the account's key prefix (default
 *   `cloudnest/`). Uploads, lookups, listings and deletes never touch keys
 *   outside it, so unrelated objects in the same bucket are invisible.
 * - CloudNest logical chunks are at most 64 MiB, far below S3's 5 GiB
 *   single-PUT limit, so one chunk object = one plain `PUT` (no multipart
 *   state machine to leave dangling). Streaming with `UNSIGNED-PAYLOAD`
 *   keeps memory bounded and works across R2/B2/AWS.
 * - Every request is SigV4-signed via s3-signature.ts (no AWS SDK).
 * - pCloud-style error mapping: failures become ProviderError safe codes.
 */

export function isS3Bundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 's3' }> {
  return b.provider === 's3';
}

const EMPTY_SHA256 = sha256Hex('');
const LIST_PAGE_LIMIT = 1000;
const LIST_MAX_PAGES = 100;

/** Validate the stored endpoint and return its origin (https only, no path). */
export function s3EndpointOrigin(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderError('invalid_request', 400, 'endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new ProviderError('invalid_request', 400, 'endpoint must be https');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new ProviderError('invalid_request', 400, 'endpoint must be a bare origin');
  }
  return url;
}

/** URI-encode every path segment of an object key (SigV4 canonical form). */
export function encodeKeyPath(key: string): string {
  return key.split('/').map((segment) => (segment ? encodeURIComponent(segment) : '')).join('/');
}

/** Namespace an engine object key under the account's managed prefix. */
export function fullObjectKey(rootPrefix: string, objectKey: string): string {
  const prefix = rootPrefix.endsWith('/') || rootPrefix === '' ? rootPrefix : `${rootPrefix}/`;
  return `${prefix}${objectKey}`;
}

/** The bucket-rooted base URL (path style). */
export function bucketBaseUrl(bundle: Extract<ProviderCredentialBundle, { provider: 's3' }>): URL {
  const origin = s3EndpointOrigin(bundle.endpoint);
  return new URL(`/${encodeURIComponent(bundle.bucket)}`, origin);
}

/** Object URL (path style, prefix + key). */
export function objectUrl(bundle: Extract<ProviderCredentialBundle, { provider: 's3' }>, rootPrefix: string, objectKey: string): URL {
  const base = bucketBaseUrl(bundle);
  return new URL(`${base.pathname}/${encodeKeyPath(fullObjectKey(rootPrefix, objectKey))}`, base);
}

/** Minimal XML decode for the small entity set S3 emits. */
function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function firstTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match ? xmlDecode(match[1]!) : null;
}

/** Map an S3 error response to a ProviderError safe code. */
export function mapS3Error(status: number, bodyText = ''): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('invalid_credentials', 401);
  if (status === 404 || bodyText.includes('NoSuchKey') || bodyText.includes('NoSuchBucket')) {
    return new ProviderError('provider_object_missing', 404);
  }
  if (status === 409) return new ProviderError('provider_object_conflict', 409);
  if (status === 429 || status === 503) return new ProviderError('provider_rate_limited', 429);
  if (status >= 500) return new ProviderError('provider_unavailable', 502);
  if (status === 400 && bodyText.includes('SignatureDoesNotMatch')) return new ProviderError('invalid_credentials', 401);
  return new ProviderError('provider_unavailable', 502);
}

interface S3FetchOptions {
  method: string;
  url: URL;
  extraHeaders?: Record<string, string>;
  body?: ReadableStream<Uint8Array>;
  /** Hex payload hash; defaults to the empty-body hash. */
  payloadHash?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Signed fetch with a hard timeout; never logs bodies or credentials. */
async function s3Fetch(
  bundle: Extract<ProviderCredentialBundle, { provider: 's3' }>,
  options: S3FetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const headers = signS3Request({
      method: options.method,
      url: options.url,
      headers: options.extraHeaders ?? {},
      payloadHash: options.payloadHash ?? EMPTY_SHA256,
      credentials: { accessKeyId: bundle.accessKeyId, secretAccessKey: bundle.secretAccessKey, region: bundle.region },
    });
    return await fetch(options.url, {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body: options.body, duplex: 'half' } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw options.signal?.aborted ? new ProviderError('upload_aborted', 499) : new ProviderError('provider_unavailable', 504);
    }
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function errorFromResponse(res: Response): Promise<ProviderError> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  return mapS3Error(res.status, text.length > 100_000 ? '' : text);
}

/**
 * The managed namespace IS the root: nothing needs to be created remotely
 * (S3 keys materialize on first PUT), so ensureAppRoot is pure bookkeeping.
 */
export async function ensureAppRootImpl(
  bundle: ProviderCredentialBundle,
  _appConfig?: unknown,
): Promise<EnsureAppRootResult> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  s3EndpointOrigin(bundle.endpoint);
  return { remoteRootId: bundle.prefix, created: false };
}

/** One logical chunk object via a streaming single-PUT (chunks are ≤64 MiB). */
export async function uploadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  params: UploadObjectStreamParams,
  _appConfig?: unknown,
): Promise<RemoteObjectRef> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const { rootId, objectKey, readable, sizeBytes, signal } = params;
  if (sizeBytes <= 0) throw new ProviderError('provider_unavailable', 400);
  const url = objectUrl(bundle, rootId, objectKey);
  const res = await s3Fetch(bundle, {
    method: 'PUT',
    url,
    body: Readable.toWeb(readable as Readable) as unknown as ReadableStream<Uint8Array>,
    payloadHash: 'UNSIGNED-PAYLOAD',
    extraHeaders: { 'content-length': String(sizeBytes), 'content-type': 'application/octet-stream' },
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  void res.text().catch(() => undefined);
  const etag = res.headers.get('etag');
  return {
    remoteObjectId: fullObjectKey(rootId, objectKey),
    objectKey,
    sizeBytes,
    // S3 returns an opaque ETag (not a SHA-256 for ordinary PUTs), so it is
    // recorded as provider metadata only — never claimed as a verified hash.
    ...(etag ? { providerChecksum: { type: 'etag', value: etag.replace(/"/g, '') } } : {}),
  };
}

/** Find one managed object by its exact key (HEAD; 404 → null). */
export async function findAppObjectByKeyImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  objectKey: string,
  _appConfig?: unknown,
): Promise<RemoteObjectRef | null> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const url = objectUrl(bundle, rootId, objectKey);
  const res = await s3Fetch(bundle, { method: 'HEAD', url });
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFromResponse(res);
  void res.text().catch(() => undefined);
  const len = res.headers.get('content-length');
  return {
    remoteObjectId: fullObjectKey(rootId, objectKey),
    objectKey,
    sizeBytes: len ? Number(len) : 0,
  };
}

/**
 * List only the managed prefix (ListObjectsV2, fully paged). Keys outside the
 * prefix can never appear: the request itself is prefix-scoped server-side.
 */
export async function listAppObjectsImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  _appConfig?: unknown,
): Promise<RemoteObjectRef[]> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const base = bucketBaseUrl(bundle);
  const refs: RemoteObjectRef[] = [];
  let continuation: string | null = null;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      'list-type': '2',
      prefix: rootId,
      'max-keys': String(LIST_PAGE_LIMIT),
      ...(continuation ? { 'continuation-token': continuation } : {}),
    });
    const url = new URL(`${base.pathname}/?${query.toString()}`, base);
    const res = await s3Fetch(bundle, { method: 'GET', url });
    if (!res.ok) throw await errorFromResponse(res);
    const text = await res.text();
    if (text.length > 1_000_000) throw new ProviderError('provider_unavailable', 502);
    const contents = text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
    for (const entry of contents) {
      const key = firstTag(entry, 'Key');
      const size = firstTag(entry, 'Size');
      if (!key) continue;
      // defensive: a conforming endpoint only returns the requested prefix,
      // but a nonconforming one must never leak foreign keys through us
      if (!key.startsWith(rootId)) continue;
      refs.push({
        remoteObjectId: key,
        objectKey: key,
        sizeBytes: size !== null && /^\d+$/.test(size) ? Number(size) : 0,
      });
    }
    const truncated = firstTag(text, 'IsTruncated');
    continuation = firstTag(text, 'NextContinuationToken');
    if (truncated !== 'true' || !continuation) break;
  }
  return refs;
}

/** Delete one managed object; S3 DELETE is idempotent, 404 counts as clean. */
export async function deleteAppObjectImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  remoteObjectId: string,
  _appConfig?: unknown,
): Promise<{ deleted: boolean; safeErrorCode?: never }> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  // remoteObjectId is the full storage key this adapter issued; refuse anything
  // from outside the managed prefix so a stale id can never cross namespaces.
  const managedPrefix = fullObjectKey(rootId, '');
  if (!remoteObjectId.startsWith(managedPrefix)) throw new ProviderError('provider_object_missing', 404);
  const url = new URL(`${bucketBaseUrl(bundle).pathname}/${encodeKeyPath(remoteObjectId)}`, bucketBaseUrl(bundle));
  const res = await s3Fetch(bundle, { method: 'DELETE', url });
  if (res.status === 404) return { deleted: true };
  if (!res.ok) throw await errorFromResponse(res);
  void res.text().catch(() => undefined);
  return { deleted: true };
}

/** Stream a managed object, honouring an optional byte range. */
export async function downloadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  remoteObjectId: string,
  _appConfig?: unknown,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number | null; contentType: string | null }> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const url = new URL(`${bucketBaseUrl(bundle).pathname}/${encodeKeyPath(remoteObjectId)}`, bucketBaseUrl(bundle));
  const res = await s3Fetch(bundle, {
    method: 'GET',
    url,
    ...(range ? { extraHeaders: { range: `bytes=${range.start}-${range.end}` } } : {}),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const len = res.headers.get('content-length');
  return {
    stream: Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    sizeBytes: len ? Number(len) : null,
    contentType: res.headers.get('content-type'),
  };
}

/** HeadBucket on connect: proves the keys work and the bucket is reachable. */
export async function headBucketImpl(bundle: ProviderCredentialBundle): Promise<void> {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const res = await s3Fetch(bundle, { method: 'HEAD', url: bucketBaseUrl(bundle), timeoutMs: 15000 });
  if (res.status === 404) throw new ProviderError('provider_object_missing', 404, 'bucket does not exist');
  if (!res.ok) throw await errorFromResponse(res);
  void res.text().catch(() => undefined);
}

/** One hour: long enough for a slow chunk PUT, short enough to be useless replay material. */
export const PRESIGN_EXPIRES_SECONDS = 3600;

/**
 * Presigned single-PUT URL for one logical chunk (roadmap Phase 2): the
 * browser transfers the bytes directly to the bucket and CloudNest never
 * carries them. The URL is scoped to exactly one object key, one PUT verb and
 * one hour; it carries the SigV4 signature in its query string and no other
 * secret — the access key id is public by design, the secret key never leaves
 * the server.
 */
export function presignUploadUrl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  objectKey: string,
  expiresInSeconds = PRESIGN_EXPIRES_SECONDS,
): { url: string; expiresAt: string } {
  if (!isS3Bundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  return presignS3Request({
    method: 'PUT',
    url: objectUrl(bundle, rootId, objectKey),
    credentials: { accessKeyId: bundle.accessKeyId, secretAccessKey: bundle.secretAccessKey, region: bundle.region },
    expiresInSeconds,
  });
}
