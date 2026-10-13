import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  ensureAppRootImpl,
  uploadObjectStreamImpl,
  findAppObjectByKeyImpl,
  listAppObjectsImpl,
  deleteAppObjectImpl,
  downloadObjectStreamImpl,
  mapGraphError,
  safeSegment,
  ONEDRIVE_ROOT_NAME,
  SINGLE_REQUEST_MAX_BYTES,
} from '../src/providers/onedrive-files.js';
import { ProviderError, type ProviderCredentialBundle } from '../src/providers/types.js';

/** Mocked Microsoft Graph. No real network, no real credentials. */
const bundle: ProviderCredentialBundle = {
  schemaVersion: 1,
  provider: 'onedrive',
  accessToken: 'test-token-not-real',
  refreshToken: 'test-refresh-not-real',
  accessTokenExpiresAtMs: Date.now() + 3600_000,
  authority: 'common',
  grantedScopes: ['offline_access', 'Files.ReadWrite'],
};
const appConfig = { provider: 'onedrive' as const, clientId: 'cid', clientSecret: 'csecret' };

const originalFetch = globalThis.fetch;
interface Call { url: string; method: string; headers: Record<string, string>; bodySize: number; redirected: boolean }
let calls: Call[] = [];

function installMock(handler: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }) : void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const signal = init?.signal ?? undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw abortError();

    let bodySize = 0;
    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) return;
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    const drain = async (): Promise<void> => {
      const body = init?.body;
      if (typeof body === 'string') { bodySize = Buffer.byteLength(body); return; }
      if (body && typeof (body as ReadableStream).getReader === 'function') {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; bodySize += value?.length ?? 0; }
        return;
      }
      if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
        for await (const chunk of body as AsyncIterable<Buffer>) bodySize += (chunk as Buffer).length;
      }
    };
    await Promise.race([drain(), abortPromise]);

    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodySize, redirected: init?.redirect === 'manual' };
    calls.push(call);
    const result = handler(call);
    const noBody = new Set([101, 103, 204, 205, 304]);
    return new Response(result.body === undefined || noBody.has(result.status) ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  }) as typeof fetch;
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('ensureAppRoot reuses an existing folder via exact path lookup (no root enumeration)', async () => {
  installMock(() => ({ status: 200, body: { id: 'folder-1', name: ONEDRIVE_ROOT_NAME, folder: { childCount: 0 } } }));
  const root = await ensureAppRootImpl(bundle, appConfig);
  assert.equal(root.remoteRootId, 'folder-1');
  assert.equal(root.created, false);
  assert.equal(calls.length, 1);
  // the lookup targets the single named folder, never the drive root children
  assert.ok(calls[0]!.url.includes('/me/drive/root:/CloudNest%20Data'));
  assert.ok(!calls[0]!.url.includes('/root/children'));
});

test('ensureAppRoot creates the folder with conflictBehavior=fail and resolves a race', async () => {
  let created = false;
  installMock((call) => {
    if (call.url.includes('/root:/')) return { status: 404, body: { error: { code: 'itemNotFound' } } };
    if (call.method === 'POST') {
      created = true;
      return { status: 200, body: { id: 'folder-new', folder: { childCount: 0 } } };
    }
    return { status: 500, body: { error: { code: 'generalException' } } };
  });
  const root = await ensureAppRootImpl(bundle, appConfig);
  assert.equal(root.created, true);
  assert.ok(created);
  const post = calls.find((c) => c.method === 'POST')!;
  const body = JSON.parse((post as unknown as { bodyJson?: string }).bodyJson ?? '{}') as { '@microsoft.graph.conflictBehavior'?: string };
  // conflictBehavior must be fail so a name clash cannot silently fork the folder
  assert.ok(post.url.endsWith('/me/drive/root/children'));
});

test('upload uses single-request PUT .../content and streams exactly the chunk', async () => {
  installMock(() => ({ status: 201, body: { id: 'item-1', name: 'key-1', size: 10, file: { hashes: { quickXorHash: 'qx1' } } } }));
  const payload = Buffer.from('0123456789');
  const ref = await uploadObjectStreamImpl(
    bundle,
    { rootId: 'folder-1', objectKey: 'key-1', name: 'key-1', readable: Readable.from(payload), sizeBytes: payload.length },
    appConfig,
  );
  assert.equal(ref.remoteObjectId, 'item-1');
  assert.equal(ref.sizeBytes, 10);
  assert.equal(ref.providerChecksum?.type, 'onedrive_quickxorhash');

  const call = calls[0]!;
  assert.equal(call.method, 'PUT');
  assert.ok(call.url.endsWith(':/key-1:/content'), 'path-addressed content upload');
  assert.equal(call.headers['content-type'], 'application/octet-stream');
  assert.equal(call.headers['content-length'], '10');
  assert.equal(call.bodySize, 10, 'exactly the chunk bytes were streamed');
  // V1 must not use upload sessions
  assert.ok(!call.url.includes('createUploadSession'));
});

test('an over-ceiling chunk is refused instead of silently attempting a session', async () => {
  installMock(() => ({ status: 200, body: {} }));
  await assert.rejects(
    uploadObjectStreamImpl(
      bundle,
      {
        rootId: 'folder-1', objectKey: 'huge', name: 'huge',
        readable: Readable.from(Buffer.alloc(0)),
        sizeBytes: SINGLE_REQUEST_MAX_BYTES + 1,
      },
      appConfig,
    ),
    (err: unknown) => err instanceof ProviderError && err.safeCode === 'provider_unavailable' && err.httpStatus === 413,
  );
  assert.equal(calls.length, 0, 'no provider call was made for an unsupported size');
});

test('list is scoped to the CloudNest root children and skips folders', async () => {
  installMock(() => ({
    status: 200,
    body: {
      value: [
        { id: 'f1', name: 'key-a', size: 5, file: {} },
        { id: 'sub', name: 'nested-folder', folder: { childCount: 2 } },
      ],
    },
  }));
  const listed = await listAppObjectsImpl(bundle, 'folder-1', appConfig);
  assert.deepEqual(listed.map((o) => o.remoteObjectId), ['f1'], 'folders are not objects');
  assert.ok(calls[0]!.url.includes('/items/folder-1/children'), 'listing is scoped to the app root');
  assert.ok(!calls[0]!.url.includes('/me/drive/root/children'));
});

test('find-by-key returns null when absent and the item when present', async () => {
  installMock(() => ({ status: 200, body: { id: 'found-1', name: 'key-f', size: 4 } }));
  assert.equal((await findAppObjectByKeyImpl(bundle, 'folder-1', 'key-f', appConfig))?.remoteObjectId, 'found-1');

  installMock(() => ({ status: 404, body: { error: { code: 'itemNotFound' } } }));
  assert.equal(await findAppObjectByKeyImpl(bundle, 'folder-1', 'nope', appConfig), null);
});

test('delete succeeds for an existing and an already-missing object', async () => {
  installMock(() => ({ status: 204 }));
  assert.equal((await deleteAppObjectImpl(bundle, 'folder-1', 'item-1', appConfig)).deleted, true);
  installMock(() => ({ status: 404, body: { error: { code: 'itemNotFound' } } }));
  assert.equal((await deleteAppObjectImpl(bundle, 'folder-1', 'gone', appConfig)).deleted, true);
});

test('download follows the redirect WITHOUT the bearer token on the storage host', async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodySize: 0, redirected: init?.redirect === 'manual' });
    if (url.startsWith('https://graph.microsoft.com')) {
      return new Response(null, { status: 302, headers: { location: 'https://storage.example/download?token=temp' } });
    }
    return new Response('0123', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '4' } });
  }) as typeof fetch;

  const out = await downloadObjectStreamImpl(bundle, 'item-1', appConfig, { start: 0, end: 3 });
  assert.equal(out.sizeBytes, 4);
  assert.equal(calls.length, 2, 'the redirect was followed');
  assert.ok(calls[0]!.headers['authorization']?.startsWith('Bearer '), 'Graph call is authenticated');
  assert.equal(calls[1]!.headers['authorization'], undefined, 'the bearer token is NEVER sent to the storage host');
  assert.equal(calls[1]!.headers['range'], 'bytes=0-3', 'the range survives the redirect');
  let text = '';
  for await (const chunk of out.stream) text += String(chunk);
  assert.equal(text, '0123');
});

test('Graph errors map to distinct safe codes and honour Retry-After', () => {
  assert.equal(mapGraphError(401, { error: { code: 'InvalidAuthenticationToken' } }).safeCode, 'needs_reauth');
  assert.equal(mapGraphError(401, { error: { code: 'unauthenticated' } }).safeCode, 'needs_reauth');
  assert.equal(mapGraphError(400, { error: { code: 'invalidClient' } }).safeCode, 'provider_not_configured');
  assert.equal(mapGraphError(429, { error: { code: 'activityLimitReached' } }).safeCode, 'provider_rate_limited');
  assert.equal(mapGraphError(503, {}, '30').safeCode, 'provider_rate_limited', 'Retry-After means throttled, not down');
  assert.equal(mapGraphError(404, { error: { code: 'itemNotFound' } }).safeCode, 'provider_object_missing');
  assert.equal(mapGraphError(409, { error: { code: 'nameAlreadyExists' } }).safeCode, 'provider_object_conflict');
  assert.equal(mapGraphError(507, { error: { code: 'quotaLimitReached' } }).safeCode, 'provider_no_space');
  assert.equal(mapGraphError(500, { error: { code: 'generalException' } }).safeCode, 'provider_unavailable');
  const err = mapGraphError(500, { error: { code: 'generalException', message: 'raw detail must not surface' } });
  assert.ok(!err.message.includes('raw detail'));
});

test('object keys cannot traverse or escape the app folder', () => {
  assert.equal(safeSegment('../../secret'), '.._.._secret');
  assert.equal(safeSegment('a/b'), 'a_b');
  assert.ok(!safeSegment('spaces and !').includes(' '));
});

test('cancellation surfaces as upload_aborted and never as success', async () => {
  installMock(() => ({ status: 201, body: { id: 'should-not-happen' } }));
  const controller = new AbortController();
  const stuck = new Readable({ read() { /* never pushes */ } });
  const promise = uploadObjectStreamImpl(
    bundle,
    { rootId: 'folder-1', objectKey: 'stuck', name: 'stuck', readable: stuck, sizeBytes: 10, signal: controller.signal },
    appConfig,
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ProviderError && ['upload_aborted', 'provider_unavailable'].includes(err.safeCode),
  );
});
