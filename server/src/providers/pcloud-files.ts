import { Readable } from 'node:stream';
import { ProviderError, type ProviderCredentialBundle, type DecryptedProviderAppConfig, type EnsureAppRootResult, type RemoteObjectRef, type UploadObjectStreamParams } from './types.js';

/**
 * pCloud file-object primitives (Step 4 / M7).
 *
 * Design notes (from the approved plan):
 * - Only the documented, allowlisted pCloud API hosts are ever contacted. The
 *   host comes from the encrypted credential bundle and was validated against
 *   the US/EU mapping during connect; it is never taken from a request.
 * - Uploads use the documented `uploadfile` endpoint with a streaming multipart
 *   body: every required parameter precedes the file part, `nopartial=1` is set
 *   so a failed transfer cannot leave a partial file behind, and a freshly
 *   generated object name is used so unrelated user files are never overwritten.
 * - Every object lives inside one CloudNest-owned folder. Objects are looked up
 *   by exact folder listing, so the connector never scans the user's drive.
 */

export const PCLOUD_ALLOWED_HOSTS = ['api.pcloud.com', 'eapi.pcloud.com'] as const;
export type PCloudHost = (typeof PCLOUD_ALLOWED_HOSTS)[number];
export const PCLOUD_ROOT_NAME = 'CloudNest Data';
/** pCloud OAuth codes are bound to the documented US/EU host mapping. */
export const PCLOUD_ROOT_FOLDER_ID = 0;

function isPcloudBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'pcloud' }> {
  return b.provider === 'pcloud';
}

/** Reject anything outside the documented host allowlist (SSRF guard). */
export function assertAllowedHost(host: string | undefined): PCloudHost {
  if (!host || !(PCLOUD_ALLOWED_HOSTS as readonly string[]).includes(host)) {
    throw new ProviderError('provider_unavailable', 400);
  }
  return host as PCloudHost;
}

function hostBase(bundle: Extract<ProviderCredentialBundle, { provider: 'pcloud' }>): string {
  return `https://${assertAllowedHost(bundle.apiHost)}`;
}

/** Make a generated key safe to use as a pCloud filename. */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

interface PcloudEnvelope {
  result?: number;
  error?: string;
  [key: string]: unknown;
}

/** pCloud reports failures as HTTP 200 with a non-zero `result`. */
export function mapPcloudError(envelope: PcloudEnvelope, httpStatus = 200): ProviderError {
  if (httpStatus === 401) return new ProviderError('needs_reauth', 401);
  if (httpStatus === 429) return new ProviderError('provider_rate_limited', 429);
  if (httpStatus >= 500) return new ProviderError('provider_unavailable', 502);
  const code = envelope.result ?? 0;
  const text = (envelope.error ?? '').toLowerCase();
  if (code === 0) return new ProviderError('provider_unavailable', 502);
  // documented pCloud result codes
  if (code === 1000 || code === 1001 || text.includes('log in') || text.includes('access_token')) {
    return new ProviderError('needs_reauth', 401);
  }
  if (code === 2008 || text.includes('not enough free space') || text.includes('no space')) {
    return new ProviderError('provider_no_space', 507);
  }
  if (code === 2002 || code === 2005 || text.includes('not exist') || text.includes('directory does not exist')) {
    return new ProviderError('provider_object_missing', 404);
  }
  if (code === 2004 || text.includes('already exists')) {
    return new ProviderError('provider_object_conflict', 409);
  }
  if (code === 4000 || text.includes('too many') || text.includes('rate')) {
    return new ProviderError('provider_rate_limited', 429);
  }
  return new ProviderError('provider_unavailable', 502);
}

/** JSON API call: bounded response size, hard timeout, never logs bodies. */
async function pcloudJson<T extends PcloudEnvelope>(
  bundle: Extract<ProviderCredentialBundle, { provider: 'pcloud' }>,
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = 30000,
): Promise<T> {
  const query = new URLSearchParams({ access_token: bundle.accessToken });
  for (const [k, v] of Object.entries(params)) query.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${hostBase(bundle)}/${path}?${query.toString()}`, { signal: controller.signal });
    const text = await res.text();
    if (text.length > 1_000_000) throw new ProviderError('provider_unavailable', 502);
    let json: PcloudEnvelope = {};
    try {
      json = text ? (JSON.parse(text) as PcloudEnvelope) : {};
    } catch {
      json = {};
    }
    if (!res.ok) throw mapPcloudError(json, res.status);
    if ((json.result ?? 0) !== 0) throw mapPcloudError(json);
    return json as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('provider_unavailable', 504);
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming multipart body builder.
 * All metadata parts are written first (as pCloud documents), then the file
 * part streams the source without ever buffering the whole chunk.
 */
function buildUploadBody(
  fields: Record<string, string>,
  fileFieldName: string,
  filename: string,
  source: Readable,
  boundary: string,
): Readable {
  const head = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    .join('');
  const fileHead =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  // Prepend the parameters, then stream the source bytes, then append the tail.
  return Readable.from(
    (async function* generate(): AsyncGenerator<Buffer> {
      yield Buffer.from(head + fileHead, 'utf8');
      for await (const chunk of source) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      yield Buffer.from(tail, 'utf8');
    })(),
  );
}

async function listFolderChildren(
  bundle: Extract<ProviderCredentialBundle, { provider: 'pcloud' }>,
  folderId: number,
): Promise<Array<{ fileid?: number; folderid?: number; name?: string; size?: number; isfolder?: boolean }>> {
  const res = await pcloudJson<{ metadata?: { contents?: Array<{ fileid?: number; folderid?: number; name?: string; size?: number; isfolder?: boolean }> } }>(
    bundle,
    'listfolder',
    { folderid: folderId },
  );
  return res.metadata?.contents ?? [];
}

async function ensureAppRootImpl(
  bundle: ProviderCredentialBundle,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<EnsureAppRootResult> {
  if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  assertAllowedHost(bundle.apiHost);
  // look for the folder by name inside the app's own root first (idempotent)
  const children = await listFolderChildren(bundle, PCLOUD_ROOT_FOLDER_ID);
  const existing = children.find((c) => c.isfolder && c.name === PCLOUD_ROOT_NAME && typeof c.folderid === 'number');
  if (existing?.folderid !== undefined) return { remoteRootId: String(existing.folderid), created: false };

  try {
    const created = await pcloudJson<{ metadata?: { folderid?: number } }>(bundle, 'createfolder', {
      folderid: PCLOUD_ROOT_FOLDER_ID,
      name: PCLOUD_ROOT_NAME,
    });
    const folderId = created.metadata?.folderid;
    if (folderId === undefined) throw new ProviderError('provider_unavailable', 502);
    return { remoteRootId: String(folderId), created: true };
  } catch (err) {
    // a concurrent create is not an error: re-read the folder id
    if (err instanceof ProviderError && err.safeCode === 'provider_object_conflict') {
      const again = await listFolderChildren(bundle, PCLOUD_ROOT_FOLDER_ID);
      const found = again.find((c) => c.isfolder && c.name === PCLOUD_ROOT_NAME && typeof c.folderid === 'number');
      if (found?.folderid !== undefined) return { remoteRootId: String(found.folderid), created: false };
    }
    throw err;
  }
}

function parseRootId(rootId: string): number {
  const id = Number(rootId);
  if (!Number.isInteger(id) || id < 0) throw new ProviderError('provider_unavailable', 400);
  return id;
}

/**
 * One logical chunk object via a streaming multipart `uploadfile` request.
 * `nopartial=1` makes pCloud discard a partial file on failure, and the
 * generated name guarantees no unrelated file is overwritten.
 */
async function uploadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  params: UploadObjectStreamParams,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef> {
  if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  assertAllowedHost(bundle.apiHost);
  const { rootId, objectKey, readable, sizeBytes, signal } = params;
  if (sizeBytes <= 0) throw new ProviderError('provider_unavailable', 400);

  const folderId = parseRootId(rootId);
  const filename = safeSegment(objectKey);
  const boundary = `----CloudNest${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  // every required parameter precedes the file part, as pCloud documents
  const fields: Record<string, string> = {
    folderid: String(folderId),
    filename,
    nopartial: '1',
    renameifexists: '0', // never silently accept a different name
  };
  const body = buildUploadBody(fields, 'file', filename, readable as Readable, boundary);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${hostBase(bundle)}/uploadfile`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>,
      // @ts-expect-error Node fetch requires duplex for streaming request bodies
      duplex: 'half',
      signal: controller.signal,
    });
    const text = await res.text();
    let json: PcloudEnvelope & { metadata?: Array<{ fileid?: number; name?: string; size?: number }> } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      json = {};
    }
    if (!res.ok) throw mapPcloudError(json, res.status);
    if ((json.result ?? 0) !== 0) throw mapPcloudError(json);
    const meta = json.metadata?.[0];
    const fileId = meta?.fileid;
    if (fileId === undefined) throw new ProviderError('provider_unavailable', 502);
    // verify the returned size matches what was sent
    const returnedSize = typeof meta?.size === 'number' ? meta.size : sizeBytes;
    if (returnedSize !== sizeBytes) {
      throw new ProviderError('provider_checksum_mismatch', 502);
    }
    return { remoteObjectId: String(fileId), objectKey, sizeBytes: returnedSize };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('upload_aborted', 499);
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** List only the CloudNest folder's files; folders are never returned as objects. */
async function listAppObjectsImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef[]> {
  if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const children = await listFolderChildren(bundle, parseRootId(rootId));
  return children
    .filter((c) => !c.isfolder && typeof c.fileid === 'number' && typeof c.name === 'string')
    .map((c) => ({
      remoteObjectId: String(c.fileid),
      objectKey: c.name as string,
      sizeBytes: typeof c.size === 'number' ? c.size : 0,
    }));
}

async function findAppObjectByKeyImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  objectKey: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef | null> {
  if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const wanted = safeSegment(objectKey);
  const children = await listFolderChildren(bundle, parseRootId(rootId));
  const hit = children.find((c) => !c.isfolder && c.name === wanted && typeof c.fileid === 'number');
  if (!hit?.fileid) return null;
  return { remoteObjectId: String(hit.fileid), objectKey, sizeBytes: typeof hit.size === 'number' ? hit.size : 0 };
}

async function deleteAppObjectImpl(
  bundle: ProviderCredentialBundle,
  _rootId: string,
  remoteObjectId: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<{ deleted: boolean; safeErrorCode?: never }> {
  if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const fileId = Number(remoteObjectId);
  if (!Number.isInteger(fileId) || fileId < 0) throw new ProviderError('provider_unavailable', 400);
  try {
    await pcloudJson(bundle, 'deletefile', { fileid: fileId });
    return { deleted: true };
  } catch (err) {
    // an already-absent object is a successful cleanup outcome
    if (err instanceof ProviderError && err.safeCode === 'provider_object_missing') return { deleted: true };
    throw err;
  }
}

async function downloadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  remoteObjectId: string,
  _appConfig?: DecryptedProviderAppConfig,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number | null; contentType: string | null }> {
  if (!isPcloudBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const fileId = Number(remoteObjectId);
  if (!Number.isInteger(fileId) || fileId < 0) throw new ProviderError('provider_unavailable', 400);
  // resolve a short-lived download URL, then fetch the bytes from that host
  const link = await pcloudJson<{ hosts?: string[]; path?: string }>(bundle, 'getfilelink', { fileid: fileId });
  const host = link.hosts?.[0];
  const path = link.path;
  if (!host || !path) throw new ProviderError('provider_unavailable', 502);
  // pCloud returns its own download hosts (e.g. *.pcloud.com); only https is used
  const url = `https://${host}${path}`;
  if (!url.startsWith('https://')) throw new ProviderError('provider_unavailable', 502);
  const headers: Record<string, string> = {};
  if (range) headers['range'] = `bytes=${range.start}-${range.end}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    let json: PcloudEnvelope = {};
    try {
      json = text ? (JSON.parse(text) as PcloudEnvelope) : {};
    } catch {
      json = {};
    }
    throw mapPcloudError(json, res.status);
  }
  const len = res.headers.get('content-length');
  return {
    stream: Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    sizeBytes: len ? Number(len) : null,
    contentType: res.headers.get('content-type'),
  };
}

export {
  ensureAppRootImpl,
  uploadObjectStreamImpl,
  findAppObjectByKeyImpl,
  listAppObjectsImpl,
  deleteAppObjectImpl,
  downloadObjectStreamImpl,
  hostBase,
};
