import { Readable } from 'node:stream';
import { ProviderError, type ProviderCredentialBundle, type DecryptedProviderAppConfig, type EnsureAppRootResult, type RemoteObjectRef, type UploadObjectStreamParams } from './types.js';

/**
 * OneDrive file-object primitives (Step 4 / M6) via Microsoft Graph.
 *
 * Design notes (from the approved plan):
 * - V1 logical chunks are at most 64 MiB, below the documented 250 MB
 *   single-request content-upload ceiling, so V1 uses a plain
 *   `PUT .../content` and deliberately avoids upload sessions (which impose a
 *   60 MiB request cap and 320 KiB fragment alignment that V1 does not need).
 * - Every object lives inside one CloudNest-owned folder. Objects are located
 *   by exact path lookup, so the connector never enumerates the user's drive
 *   root and can never list, move, or delete an unrelated user file.
 * - Extra bytes are streamed with backpressure; no whole-chunk buffering and no
 *   temporary chunk file.
 */

export const ONEDRIVE_ROOT_NAME = 'CloudNest Data';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Hard cap for the V1 simple-upload path; above this a session design is needed. */
export const SINGLE_REQUEST_MAX_BYTES = 64 * 1024 * 1024;
export const VALID_AUTHORITIES = new Set(['common', 'consumers', 'organizations']);

function isOneDriveBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'onedrive' }> {
  return b.provider === 'onedrive';
}

function authorityBase(authority: string): string {
  if (VALID_AUTHORITIES.has(authority)) return `https://login.microsoftonline.com/${authority}`;
  if (/^[0-9a-fA-F-]{36}$/.test(authority)) return `https://login.microsoftonline.com/${authority}`;
  // never accept an arbitrary OAuth authority URL
  throw new ProviderError('provider_unavailable', 400);
}

async function ensureFresh(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<Extract<ProviderCredentialBundle, { provider: 'onedrive' }>> {
  if (!isOneDriveBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  if (bundle.accessTokenExpiresAtMs === undefined || bundle.accessTokenExpiresAtMs > Date.now() + 60_000) return bundle;
  if (!bundle.refreshToken || !appConfig) throw new ProviderError('needs_reauth', 401);
  const tokenRes = await graphJson<{ access_token?: string; expires_in?: number; refresh_token?: string }>(
    `${authorityBase(bundle.authority)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appConfig.clientId,
        client_secret: appConfig.clientSecret,
        refresh_token: bundle.refreshToken,
        grant_type: 'refresh_token',
        // Microsoft requires offline_access explicitly to issue a refresh token
        scope: 'offline_access Files.ReadWrite',
      }).toString(),
    },
    '',
  );
  if (!tokenRes?.access_token) throw new ProviderError('needs_reauth', 401);
  return {
    ...bundle,
    accessToken: tokenRes.access_token,
    accessTokenExpiresAtMs: Date.now() + Number(tokenRes.expires_in ?? 3600) * 1000,
    // a refresh response without a replacement preserves the existing token
    refreshToken: tokenRes.refresh_token ?? bundle.refreshToken,
  };
}

/** Map a Microsoft Graph error payload into a normalized safe code. */
export function mapGraphError(status: number, payload: unknown, retryAfter?: string | null): ProviderError {
  const body = (payload ?? {}) as { error?: { code?: string; message?: string } };
  const code = (body.error?.code ?? '').toLowerCase();
  if (status === 401 || code === 'invalidauthenticationtoken' || code === 'unauthenticated' || code === 'invalidgrant' || code === 'expiredtoken') {
    return new ProviderError('needs_reauth', 401);
  }
  if (code === 'invalidclient' || code === 'invalidclientsecret') {
    return new ProviderError('provider_not_configured', 400);
  }
  if (retryAfter || status === 429 || code === 'activitylimitreached' || code === 'toomanyrequests') {
    return new ProviderError('provider_rate_limited', 429);
  }
  if (status === 403) return new ProviderError('needs_reauth', 403);
  if (status === 404 || code === 'itemnotfound') return new ProviderError('provider_object_missing', 404);
  if (status === 409 || code === 'namealreadyexists') return new ProviderError('provider_object_conflict', 409);
  if (status === 507 || code === 'quotalimitreached' || code === 'storagelimitreached') {
    return new ProviderError('provider_no_space', 507);
  }
  if (status >= 500) return new ProviderError('provider_unavailable', 502);
  return new ProviderError('provider_unavailable', 502);
}

/** Minimal Graph JSON helper (hard timeout, no body logging). Empty token for auth calls. */
async function graphJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}, token: string): Promise<T> {
  const { timeoutMs = 30000, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      headers: {
        ...(headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw mapGraphError(res.status, json, res.headers.get('retry-after'));
    return json as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('provider_unavailable', 504);
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Make a generated object key usable as one Graph path segment. */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Exact-path lookup for an item inside the app root (no drive enumeration). */
function childPath(rootId: string, name: string): string {
  return `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}:/${encodeURIComponent(safeSegment(name))}:`;
}

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  file?: { hashes?: { quickXorHash?: string; sha256Hash?: string; sha1Hash?: string } };
  folder?: { childCount?: number };
}

async function ensureAppRootImpl(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<EnsureAppRootResult> {
  const fresh = await ensureFresh(bundle, appConfig);
  // exact path lookup at the drive root: never enumerate the user's root items
  try {
    const existing = await graphJson<DriveItem>(
      `${GRAPH}/me/drive/root:/${encodeURIComponent(ONEDRIVE_ROOT_NAME)}`,
      {},
      fresh.accessToken,
    );
    if (existing?.id && existing.folder) return { remoteRootId: existing.id, created: false };
  } catch (err) {
    if (!(err instanceof ProviderError) || err.safeCode !== 'provider_object_missing') throw err;
  }
  try {
    const created = await graphJson<DriveItem>(
      `${GRAPH}/me/drive/root/children`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: ONEDRIVE_ROOT_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      },
      fresh.accessToken,
    );
    if (!created?.id) throw new ProviderError('provider_unavailable', 502);
    return { remoteRootId: created.id, created: true };
  } catch (err) {
    // a concurrent create is not an error: resolve the existing folder by path
    if (err instanceof ProviderError && err.safeCode === 'provider_object_conflict') {
      const again = await graphJson<DriveItem>(
        `${GRAPH}/me/drive/root:/${encodeURIComponent(ONEDRIVE_ROOT_NAME)}`,
        {},
        fresh.accessToken,
      );
      if (again?.id) return { remoteRootId: again.id, created: false };
    }
    throw err;
  }
}

/**
 * Single-request content upload of one logical chunk object.
 * Above the V1 ceiling this refuses rather than silently attempting an
 * untested session-based path.
 */
async function uploadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  params: UploadObjectStreamParams,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef> {
  const fresh = await ensureFresh(bundle, appConfig);
  const { rootId, objectKey, readable, sizeBytes, signal } = params;
  if (sizeBytes <= 0) throw new ProviderError('provider_unavailable', 400);
  if (sizeBytes > SINGLE_REQUEST_MAX_BYTES) {
    // V1 must not pretend it can upload this object
    throw new ProviderError('provider_unavailable', 413, 'chunk exceeds the V1 single-request upload ceiling');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${childPath(rootId, objectKey)}/content`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${fresh.accessToken}`,
        'content-type': 'application/octet-stream',
        'content-length': String(sizeBytes),
      },
      body: Readable.toWeb(readable as Readable) as unknown as ReadableStream<Uint8Array>,
      // @ts-expect-error Node fetch requires duplex for streaming request bodies
      duplex: 'half',
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: DriveItem | null = null;
    try {
      parsed = text ? (JSON.parse(text) as DriveItem) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw mapGraphError(res.status, parsed, res.headers.get('retry-after'));
    if (!parsed?.id) throw new ProviderError('provider_unavailable', 502);
    const quickXor = parsed.file?.hashes?.quickXorHash;
    return {
      remoteObjectId: parsed.id,
      objectKey,
      sizeBytes: typeof parsed.size === 'number' ? parsed.size : sizeBytes,
      ...(quickXor ? { providerChecksum: { type: 'onedrive_quickxorhash', value: quickXor } } : {}),
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('upload_aborted', 499);
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** List only the children of the CloudNest root folder (never the drive root). */
async function listAppObjectsImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef[]> {
  const fresh = await ensureFresh(bundle, appConfig);
  const out: RemoteObjectRef[] = [];
  let url: string | undefined = `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}/children?$select=id,name,size,file,folder&$top=200`;
  while (url) {
    const current: string = url;
    const res: { value?: DriveItem[]; '@odata.nextLink'?: string } = await graphJson(url, {}, fresh.accessToken);
    for (const item of res.value ?? []) {
      // folders are organisational only; only real files are CloudNest objects
      if (!item.id || !item.name || !item.file) continue;
      out.push({ remoteObjectId: item.id, objectKey: item.name, sizeBytes: typeof item.size === 'number' ? item.size : 0 });
    }
    url = res['@odata.nextLink'];
  }
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
    const item = await graphJson<DriveItem>(`${childPath(rootId, objectKey)}?$select=id,name,size,file`, {}, fresh.accessToken);
    if (!item?.id) return null;
    return { remoteObjectId: item.id, objectKey, sizeBytes: typeof item.size === 'number' ? item.size : 0 };
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
  const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(remoteObjectId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${fresh.accessToken}` },
  });
  // an already-absent object is a successful cleanup outcome
  if (res.status === 204 || res.status === 200 || res.status === 404) return { deleted: true };
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  throw mapGraphError(res.status, parsed, res.headers.get('retry-after'));
}

async function downloadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  remoteObjectId: string,
  appConfig?: DecryptedProviderAppConfig,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number | null; contentType: string | null }> {
  const fresh = await ensureFresh(bundle, appConfig);
  const rangeHeader: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end}` } : {};
  // Graph answers with a short-lived pre-authenticated URL; follow it WITHOUT
  // the bearer token so the access token never reaches the storage host.
  const authedHeaders: Record<string, string> = { authorization: `Bearer ${fresh.accessToken}`, ...rangeHeader };
  const first: Response = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(remoteObjectId)}/content`, {
    headers: authedHeaders,
    redirect: 'manual',
  });
  let res: Response = first;
  if ([301, 302, 303, 307, 308].includes(first.status)) {
    const location = first.headers.get('location');
    if (!location) throw new ProviderError('provider_unavailable', 502);
    res = await fetch(location, { headers: rangeHeader });
  }
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw mapGraphError(res.status, parsed, res.headers.get('retry-after'));
  }
  const len = res.headers.get('content-length');
  return {
    stream: Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    sizeBytes: len ? Number(len) : null,
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
};
