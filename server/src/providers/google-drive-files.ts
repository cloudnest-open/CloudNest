import { providerFetch, ProviderError, type ProviderCredentialBundle, type DecryptedProviderAppConfig, type EnsureAppRootResult, type RemoteObjectRef, type UploadObjectStreamParams } from './types.js';
import { Readable } from 'node:stream';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ROOT_LABEL = 'CloudNest Data — do not rename/delete';
const APP_FOLDER_MIME = 'application/vnd.google-apps.folder';
const RESUMABLE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/** Google Drive file/folder primitives (Step 4 / M4). All app-managed objects
 *  live inside one dedicated CloudNest root folder; unrelated user files are
 *  never listed or deleted. */

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

/** Escape a value for use inside a Drive `q` query string. */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findRootFolder(bundle: Extract<ProviderCredentialBundle, { provider: 'google_drive' }>): Promise<string | null> {
  const q = `mimeType='${APP_FOLDER_MIME}' and name='${escapeQueryValue(ROOT_LABEL)}' and trashed=false`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = (await providerFetch(url, { headers: { authorization: `Bearer ${bundle.accessToken}` } })) as {
    files?: Array<{ id?: string; name?: string }>;
  };
  const first = res?.files?.[0];
  return first?.id ?? null;
}

async function ensureAppRootImpl(
  bundle: ProviderCredentialBundle,
  appConfig?: DecryptedProviderAppConfig,
): Promise<EnsureAppRootResult> {
  const fresh = await ensureFresh(bundle, appConfig);
  const existing = await findRootFolder(fresh);
  if (existing) return { remoteRootId: existing, created: false };
  // create lazily. Drive has no unique-name constraint, so two concurrent
  // calls (e.g. the first two chunks of a fresh account) can both reach the
  // create: the created id is only a candidate. A re-search afterwards makes
  // every racer converge on the first folder under the app label instead of
  // forking duplicate roots.
  const body = JSON.stringify({ name: ROOT_LABEL, mimeType: APP_FOLDER_MIME });
  const created = (await providerFetch(`${FILES_URL}?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
    body,
  })) as { id?: string };
  if (!created?.id) throw new ProviderError('identity_validation_failed', 502);
  const settled = await findRootFolder(fresh);
  return { remoteRootId: settled ?? created.id, created: true };
}

/** Map a Google API error payload into our normalized safe codes. */
function mapGoogleError(status: number, payload: unknown): ProviderError {
  const err = (payload ?? {}) as { error?: { errors?: Array<{ reason?: string }>; message?: string } };
  const reason = err.error?.errors?.[0]?.reason ?? '';
  if (status === 401 || reason === 'authError' || reason === 'invalid_grant') {
    return new ProviderError('needs_reauth', 401);
  }
  if (status === 403 && (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded')) {
    return new ProviderError('provider_no_space', 507);
  }
  if (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')) {
    return new ProviderError('provider_rate_limited', 429);
  }
  if (status === 403) return new ProviderError('needs_reauth', 403);
  if (status === 404) return new ProviderError('provider_object_missing', 404);
  if (status === 429) return new ProviderError('provider_rate_limited', 429);
  if (status >= 500) return new ProviderError('provider_unavailable', 502);
  return new ProviderError('provider_unavailable', 502);
}

async function googleJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}, token: string): Promise<T> {
  const { timeoutMs = 30000, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      headers: { ...(headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw mapGoogleError(res.status, json);
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
 * Resumable upload of one logical chunk object.
 * - Creates a resumable session, then streams the body with backpressure.
 * - Honors cancellation; on interrupt, queries the acknowledged range so a
 *   retry can resume from the correct offset instead of duplicating objects.
 * - Never collects the whole chunk into a Buffer.
 */
async function uploadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  params: UploadObjectStreamParams,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef> {
  const fresh = await ensureFresh(bundle, appConfig);
  const { rootId, objectKey, name, readable, sizeBytes, signal, acknowledgedBytes = 0 } = params;
  if (sizeBytes <= 0) throw new ProviderError('provider_unavailable', 400);

  const metadata = JSON.stringify({ name, parents: [rootId], appProperties: { cloudnestKey: objectKey } });
  const sessionRes = await fetch(RESUMABLE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fresh.accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(sizeBytes),
    },
    body: metadata,
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw mapGoogleError(sessionRes.status, parsed);
  }
  const sessionUri = sessionRes.headers.get('location');
  if (!sessionUri) throw new ProviderError('provider_unavailable', 502);

  // Stream remaining bytes with the correct Content-Range header.
  const remaining = sizeBytes - acknowledgedBytes;
  const rangeHeader = `bytes ${acknowledgedBytes}-${sizeBytes - 1}/${sizeBytes}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const body = Readable.toWeb(readable as Readable) as unknown as ReadableStream<Uint8Array>;
    const res = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'content-length': String(remaining),
        'content-range': rangeHeader,
        'content-type': 'application/octet-stream',
      },
      body,
      // @ts-expect-error Node fetch requires duplex for streaming bodies
      duplex: 'half',
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: { id?: string; size?: string } | null = null;
    try {
      parsed = text ? (JSON.parse(text) as { id?: string; size?: string }) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw mapGoogleError(res.status, parsed);
    if (!parsed?.id) throw new ProviderError('provider_unavailable', 502);
    return {
      remoteObjectId: parsed.id,
      objectKey,
      sizeBytes: parsed.size !== undefined ? Number(parsed.size) : sizeBytes,
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') {
      // W-01: an interrupted resumable session may have persisted part of the
      // body. Query the acknowledged range once so the retry can resume from
      // the true offset instead of restarting the chunk at zero. A failed
      // probe never masks the abort itself.
      try {
        const probe = await fetch(sessionUri, { method: 'PUT', headers: { 'content-range': `bytes */${sizeBytes}` } });
        if (probe.status === 308) {
          const end = probe.headers.get('range');
          const match = end ? /bytes=0-(\d+)$/.exec(end) : null;
          if (match) {
            const acked = Number(match[1]) + 1;
            const details = new Error(`upload_aborted at ${acked} acknowledged bytes`);
            throw Object.assign(details, { safeCode: 'upload_aborted', httpStatus: 499, acknowledgedBytes: acked });
          }
        }
      } catch (probeErr) {
        if ((probeErr as { safeCode?: string }).safeCode === 'upload_aborted') throw probeErr;
      }
      throw new ProviderError('upload_aborted', 499);
    }
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function findAppObjectByKeyImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  objectKey: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef | null> {
  const fresh = await ensureFresh(bundle, appConfig);
  const q = `'${escapeQueryValue(rootId)}' in parents and appProperties has { key='cloudnestKey' and value='${escapeQueryValue(objectKey)}' } and trashed=false`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name,size,appProperties)&supportsAllDrives=true`;
  const res = await googleJson<{ files?: Array<{ id?: string; size?: string; appProperties?: Record<string, string> }> }>(url, {}, fresh.accessToken);
  const first = (res?.files ?? []).find((f) => f.appProperties?.['cloudnestKey'] === objectKey);
  if (!first?.id) return null;
  return { remoteObjectId: first.id, objectKey, sizeBytes: first.size !== undefined ? Number(first.size) : 0 };
}

async function listAppObjectsImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef[]> {
  const fresh = await ensureFresh(bundle, appConfig);
  const q = `'${escapeQueryValue(rootId)}' in parents and trashed=false and appProperties has { key='cloudnestKey' }`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name,size,appProperties)&supportsAllDrives=true&pageSize=200`;
  const res = await googleJson<{ files?: Array<{ id?: string; size?: string; appProperties?: Record<string, string> }> }>(url, {}, fresh.accessToken);
  // Defence in depth: even if the provider returned an unrelated file, only
  // objects carrying CloudNest's own app key are ever surfaced or acted upon.
  return (res.files ?? [])
    .filter((f) => typeof f.id === 'string' && typeof f.appProperties?.['cloudnestKey'] === 'string' && f.appProperties['cloudnestKey'].length > 0)
    .map((f) => ({
      remoteObjectId: f.id as string,
      objectKey: f.appProperties?.['cloudnestKey'] as string,
      sizeBytes: f.size !== undefined ? Number(f.size) : 0,
    }));
}

async function deleteAppObjectImpl(
  bundle: ProviderCredentialBundle,
  _rootId: string,
  remoteObjectId: string,
  appConfig?: DecryptedProviderAppConfig,
): Promise<{ deleted: boolean; safeErrorCode?: never }> {
  const fresh = await ensureFresh(bundle, appConfig);
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(remoteObjectId)}?supportsAllDrives=true`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${fresh.accessToken}` },
  });
  if (res.status === 204 || res.status === 200) return { deleted: true };
  if (res.status === 404) return { deleted: true }; // already gone is a success for cleanup
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  throw mapGoogleError(res.status, parsed);
}

async function downloadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  remoteObjectId: string,
  appConfig?: DecryptedProviderAppConfig,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number | null; contentType: string | null }> {
  const fresh = await ensureFresh(bundle, appConfig);
  const headers: Record<string, string> = { authorization: `Bearer ${fresh.accessToken}` };
  if (range) headers['range'] = `bytes=${range.start}-${range.end}`;
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(remoteObjectId)}?alt=media&supportsAllDrives=true`, { headers });
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw mapGoogleError(res.status, parsed);
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
  mapGoogleError,
  ROOT_LABEL,
  APP_FOLDER_MIME,
};
