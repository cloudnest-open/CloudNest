import { Readable } from 'node:stream';
import { ProviderError, type ProviderCredentialBundle, type DecryptedProviderAppConfig, type EnsureAppRootResult, type RemoteObjectRef, type UploadObjectStreamParams } from './types.js';

/**
 * Dropbox file-object primitives (Step 4 / M5).
 *
 * Design notes (from the approved plan):
 * - V1 logical chunks are at most 64 MiB, so a single-request `/2/files/upload`
 *   (documented limit 150 MiB) is used instead of upload sessions.
 * - Each object gets a unique app-generated path; an object can always be
 *   reconciled by its app key. Nothing outside the CloudNest app folder is
 *   ever listed, written, or deleted.
 * - Extra bytes are scraped off the response body and the request is streamed
 *   with backpressure; the whole chunk is never buffered in memory.
 */

/** App-folder style root inside the Dropbox app's own space. */
export const DROPBOX_ROOT_PATH = '/CloudNest Data — do not rename delete';
/** Dropbox single-request uploads accept at most 150 MB; V1 chunks are <= 64 MiB. */
export const SINGLE_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const API_URL = 'https://api.dropboxapi.com/2';

function isDropboxBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'dropbox' }> {
  return b.provider === 'dropbox';
}

/** Dropbox wants its API arguments in a header, JSON-encoded, never in the URL. */
function apiArgHeader(value: Record<string, unknown>): string {
  // Non-ASCII characters must be escaped as \uXXXX in the HTTP header value.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function ensureFresh(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<Extract<ProviderCredentialBundle, { provider: 'dropbox' }>> {
  if (!isDropboxBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  if (bundle.accessTokenExpiresAtMs === undefined || bundle.accessTokenExpiresAtMs > Date.now() + 60_000) return bundle;
  if (!bundle.refreshToken || !appConfig) throw new ProviderError('needs_reauth', 401);
  const tokenRes = (await providerFetchJson('https://api.dropboxapi.com/oauth2/token', {
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
  return {
    ...bundle,
    accessToken: tokenRes.access_token,
    accessTokenExpiresAtMs: Date.now() + Number(tokenRes.expires_in ?? 14400) * 1000,
  };
}

/** Map a Dropbox error payload into a normalized safe code. */
export function mapDropboxError(status: number, payload: unknown, retryAfter?: string | null): ProviderError {
  const body = (payload ?? {}) as { error_summary?: string; error?: Record<string, unknown> };
  const summary = body.error_summary ?? '';
  const tag = (() => {
    const err = body.error;
    if (err && typeof err === 'object') {
      const first = Object.keys(err)[0];
      if (first) return first;
    }
    return '';
  })();
  if (status === 401 || summary.includes('invalid_access_token') || summary.includes('expired_access_token') || summary.includes('invalid_grant')) {
    return new ProviderError('needs_reauth', 401);
  }
  if (status === 403) {
    if (summary.includes('insufficient_space') || tag === 'insufficient_space') return new ProviderError('provider_no_space', 507);
    // a missing scope is a permission problem the owner must fix by reconnecting
    if (summary.includes('missing_scope') || summary.includes('insufficient_scope')) return new ProviderError('needs_reauth', 403);
    return new ProviderError('needs_reauth', 403);
  }
  if (status === 409) {
    // conflict: never overwrite; surfaced so the caller can use a new key/attempt
    if (summary.includes('conflict') || tag === 'conflict') return new ProviderError('provider_object_conflict', 409);
    if (summary.includes('not_found') || tag === 'not_found') return new ProviderError('provider_object_missing', 404);
    return new ProviderError('provider_object_conflict', 409);
  }
  if (status === 429 || retryAfter) return new ProviderError('provider_rate_limited', 429);
  if (status === 404) return new ProviderError('provider_object_missing', 404);
  if (status >= 500) return new ProviderError('provider_unavailable', 502);
  return new ProviderError('provider_unavailable', 502);
}

/** Minimal JSON call helper with a hard timeout; never logs bodies. */
async function providerFetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 30000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw mapDropboxError(res.status, json, res.headers.get('retry-after'));
    return json as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('provider_unavailable', 504);
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Escape a path segment so a generated key can never traverse or inject. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function objectPath(objectKey: string): string {
  return `${DROPBOX_ROOT_PATH}/${safeSegment(objectKey)}`;
}

async function ensureFolder(path: string, token: string): Promise<void> {
  try {
    await providerFetchJson(`${API_URL}/files/create_folder_v2`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path, autorename: false }),
    });
  } catch (err) {
    // Already existing is success for our idempotent ensure flow.
    if (err instanceof ProviderError && err.safeCode === 'provider_object_conflict') return;
    throw err;
  }
}

async function ensureAppRootImpl(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<EnsureAppRootResult> {
  const fresh = await ensureFresh(bundle, appConfig);
  // metadata lookup first: idempotent, and cheaper than a failed create
  try {
    const meta = await providerFetchJson<{ id?: string; path_display?: string }>(`${API_URL}/files/get_metadata`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: DROPBOX_ROOT_PATH }),
    });
    if (meta?.id) return { remoteRootId: DROPBOX_ROOT_PATH, created: false };
  } catch (err) {
    if (!(err instanceof ProviderError) || err.safeCode !== 'provider_object_missing') throw err;
  }
  await ensureFolder(DROPBOX_ROOT_PATH, fresh.accessToken);
  return { remoteRootId: DROPBOX_ROOT_PATH, created: true };
}

/**
 * Single-request upload of one logical chunk object.
 * `mode: 'add'` with `autorename: false` guarantees we never overwrite an
 * existing Dropbox object: a name collision becomes a conflict error instead.
 */
async function uploadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  params: UploadObjectStreamParams,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef> {
  const fresh = await ensureFresh(bundle, appConfig);
  const { rootId, objectKey, name, readable, sizeBytes, signal } = params;
  if (sizeBytes <= 0) throw new ProviderError('provider_unavailable', 400);
  // W-02: the single-request endpoint tops out well below the planned chunk
  // ceiling; refuse with an honest code instead of a generic 502 from a 413.
  if (sizeBytes > SINGLE_REQUEST_MAX_BYTES) {
    throw new ProviderError('provider_unavailable', 413, 'chunk exceeds the V1 single-request upload ceiling');
  }

  const path = `${rootId.replace(/\/$/, '')}/${safeSegment(objectKey)}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fresh.accessToken}`,
        'content-type': 'application/octet-stream',
        'dropbox-api-arg': apiArgHeader({
          path,
          mode: 'add',
          autorename: false,
          mute: true,
          strict_conflict: true,
        }),
      },
      body: Readable.toWeb(readable as Readable) as unknown as ReadableStream<Uint8Array>,
      // @ts-expect-error Node fetch requires duplex for streaming request bodies
      duplex: 'half',
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: { id?: string; name?: string; size?: number; content_hash?: string } | null = null;
    try {
      parsed = text ? (JSON.parse(text) as { id?: string; size?: number; content_hash?: string }) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw mapDropboxError(res.status, parsed, res.headers.get('retry-after'));
    if (!parsed?.id) throw new ProviderError('provider_unavailable', 502);
    return {
      remoteObjectId: parsed.id,
      objectKey,
      sizeBytes: typeof parsed.size === 'number' ? parsed.size : sizeBytes,
      ...(parsed.content_hash ? { providerChecksum: { type: 'dropbox_content_hash', value: parsed.content_hash } } : {}),
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('upload_aborted', 499);
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function listAppObjectsImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef[]> {
  const fresh = await ensureFresh(bundle, appConfig);
  const out: RemoteObjectRef[] = [];
  let cursor: string | undefined;
  do {
    const res = await providerFetchJson<{
      entries?: Array<{ '.tag'?: string; id?: string; name?: string; size?: number }>;
      cursor?: string;
      has_more?: boolean;
    }>(`${API_URL}/files/list_folder${cursor ? '/continue' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(cursor ? { cursor } : { path: rootId, recursive: false, limit: 200 }),
    });
    for (const entry of res.entries ?? []) {
      // Only files directly inside the app root; skip folders and metadata-only entries.
      if (entry['.tag'] !== 'file' || !entry.id || !entry.name) continue;
      out.push({
        remoteObjectId: entry.id,
        objectKey: entry.name,
        sizeBytes: typeof entry.size === 'number' ? entry.size : 0,
      });
    }
    cursor = res.has_more ? res.cursor : undefined;
  } while (cursor);
  return out;
}

async function findAppObjectByKeyImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  objectKey: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef | null> {
  const fresh = await ensureFresh(bundle, appConfig);
  try {
    const meta = await providerFetchJson<{ id?: string; name?: string; size?: number }>(`${API_URL}/files/get_metadata`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${rootId.replace(/\/$/, '')}/${safeSegment(objectKey)}` }),
    });
    if (!meta?.id) return null;
    return { remoteObjectId: meta.id, objectKey, sizeBytes: typeof meta.size === 'number' ? meta.size : 0 };
  } catch (err) {
    if (err instanceof ProviderError && err.safeCode === 'provider_object_missing') return null;
    throw err;
  }
}

async function deleteAppObjectImpl(
  bundle: ProviderCredentialBundle,
  _rootId: string,
  remoteObjectId: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<{ deleted: boolean; safeErrorCode?: never }> {
  const fresh = await ensureFresh(bundle, appConfig);
  try {
    const res = await providerFetchJson<{ metadata?: { id?: string } }>(`${API_URL}/files/delete_v2`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: remoteObjectId }),
    });
    return { deleted: res?.metadata?.id !== undefined };
  } catch (err) {
    // already gone is a successful cleanup outcome
    if (err instanceof ProviderError && err.safeCode === 'provider_object_missing') return { deleted: true };
    throw err;
  }
}

async function downloadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  remoteObjectId: string,
  appConfig?: DecryptedProviderAppConfig,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number | null; contentType: string | null }> {
  const fresh = await ensureFresh(bundle, appConfig);
  const headers: Record<string, string> = {
    authorization: `Bearer ${fresh.accessToken}`,
    'dropbox-api-arg': apiArgHeader(
      range
        ? { path: remoteObjectId, extra_headers: {} }
        : { path: remoteObjectId },
    ),
  };
  if (range) headers['range'] = `bytes=${range.start}-${range.end}`;
  const res = await fetch('https://content.dropboxapi.com/2/files/download', { headers });
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw mapDropboxError(res.status, parsed, res.headers.get('retry-after'));
  }
  const len = res.headers.get('content-length');
  return {
    stream: Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    // Dropbox reports the FULL object size in this header even for ranged reads,
    // so a ranged response must not be reported as the returned byte count.
    sizeBytes: range ? null : (len ? Number(len) : null),
    contentType: res.headers.get('content-type'),
  };
}

export {
  ensureFresh,
  ensureAppRootImpl,
  uploadObjectStreamImpl,
  findAppObjectByKeyImpl,
  listAppObjectsImpl,
  deleteAppObjectImpl,
  downloadObjectStreamImpl,
  objectPath,
  safeSegment,
};
