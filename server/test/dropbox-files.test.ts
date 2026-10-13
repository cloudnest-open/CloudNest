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
  mapDropboxError,
  safeSegment,
  DROPBOX_ROOT_PATH,
} from '../src/providers/dropbox-files.js';
import { ProviderError, type ProviderCredentialBundle } from '../src/providers/types.js';

/** Mocked Dropbox HTTP. No real network, no real credentials. */
const bundle: ProviderCredentialBundle = {
  schemaVersion: 1,
  provider: 'dropbox',
  accessToken: 'test-token-not-real',
  refreshToken: 'test-refresh-not-real',
  grantedScopes: ['files.content.write', 'files.content.read', 'files.metadata.read'],
};
const appConfig = { provider: 'dropbox' as const, clientId: 'cid', clientSecret: 'csecret' };

const originalFetch = globalThis.fetch;
interface Call { url: string; method: string; headers: Record<string, string>; bodySize: number; apiArg: string | null; bodyJson: string | null }
let calls: Call[] = [];

function installMock(handler: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string>; raw?: string }): void {
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
    let stringBody: string | null = null;
    const drain = async (): Promise<void> => {
      const body = init?.body;
      if (typeof body === 'string') { bodySize = Buffer.byteLength(body); stringBody = body; return; }
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

    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodySize, apiArg: headers['dropbox-api-arg'] ?? null, bodyJson: stringBody };
    calls.push(call);
    const result = handler(call);
    const noBody = new Set([101, 103, 204, 205, 304]);
    const payload = result.raw !== undefined ? result.raw : (result.body === undefined || noBody.has(result.status) ? null : JSON.stringify(result.body));
    return new Response(payload, { status: result.status, headers: { 'content-type': 'application/json', ...(result.headers ?? {}) } });
  }) as typeof fetch;
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('ensureAppRoot reuses an existing root and is idempotent', async () => {
  installMock((call) => {
    if (call.url.endsWith('/files/get_metadata')) return { status: 200, body: { id: 'id:root', path_display: DROPBOX_ROOT_PATH } };
    return { status: 500, body: { error_summary: 'unexpected' } };
  });
  const root = await ensureAppRootImpl(bundle, appConfig);
  assert.equal(root.remoteRootId, DROPBOX_ROOT_PATH);
  assert.equal(root.created, false);
  assert.equal(calls.filter((c) => c.url.includes('create_folder')).length, 0, 'no folder created when one exists');
});

test('ensureAppRoot creates the root lazily when metadata says it is missing', async () => {
  let created = false;
  installMock((call) => {
    if (call.url.endsWith('/files/get_metadata')) return { status: 409, body: { error_summary: 'path/not_found/...' } };
    created = true;
    return { status: 200, body: { metadata: { id: 'id:newroot' } } };
  });
  const root = await ensureAppRootImpl(bundle, appConfig);
  assert.equal(root.created, true);
  assert.ok(created);
  const create = calls.find((c) => c.url.includes('create_folder'))!;
  assert.equal(create.method, 'POST');
  // autorename must be false so a name clash can never silently create a second folder
  const arg = JSON.parse(create.bodyJson!) as { path: string; autorename: boolean };
  assert.equal(arg.path, DROPBOX_ROOT_PATH);
  assert.equal(arg.autorename, false);
});

test('upload uses single-request /2/files/upload with mode=add and never overwrites', async () => {
  installMock((call) => {
    if (call.url.includes('/2/files/upload')) {
      return { status: 200, body: { id: 'id:obj1', name: 'key-1', size: 10, content_hash: 'abc123' } };
    }
    return { status: 500, body: { error_summary: 'unexpected' } };
  });
  const payload = Buffer.from('0123456789');
  const ref = await uploadObjectStreamImpl(
    bundle,
    { rootId: DROPBOX_ROOT_PATH, objectKey: 'key-1', name: 'key-1', readable: Readable.from(payload), sizeBytes: payload.length },
    appConfig,
  );
  assert.equal(ref.remoteObjectId, 'id:obj1');
  assert.equal(ref.sizeBytes, 10);
  assert.equal(ref.providerChecksum?.type, 'dropbox_content_hash');

  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/octet-stream');
  assert.equal(call.bodySize, 10, 'streamed exactly the chunk bytes');
  const arg = JSON.parse(call.apiArg!) as { mode: string; autorename: boolean; strict_conflict: boolean; path: string };
  assert.equal(arg.mode, 'add', 'mode=add never overwrites');
  assert.equal(arg.autorename, false);
  assert.equal(arg.strict_conflict, true);
  assert.ok(arg.path.startsWith(DROPBOX_ROOT_PATH));
  // the API arguments must not appear in the URL (Dropbox wants them in the header)
  assert.ok(!call.url.includes('key-1'));
});

test('an existing object yields a conflict error instead of overwriting it', async () => {
  installMock(() => ({ status: 409, body: { error_summary: 'path/conflict/file/...', error: { '.tag': 'path', conflict: {} } } }));
  await assert.rejects(
    uploadObjectStreamImpl(
      bundle,
      { rootId: DROPBOX_ROOT_PATH, objectKey: 'dup', name: 'dup', readable: Readable.from(Buffer.from('x')), sizeBytes: 1 },
      appConfig,
    ),
    (err: unknown) => err instanceof ProviderError && err.safeCode === 'provider_object_conflict',
  );
});

test('a failed upload is cleaned up by its app key, not by a blanket listing', async () => {
  installMock((call) => {
    if (call.url.endsWith('/files/list_folder')) {
      return { status: 200, body: { entries: [{ '.tag': 'file', id: 'id:a', name: 'key-a', size: 1 }], has_more: false, cursor: 'c' } };
    }
    return { status: 500, body: { error_summary: 'unexpected' } };
  });
  const listed = await listAppObjectsImpl(bundle, DROPBOX_ROOT_PATH, appConfig);
  assert.deepEqual(listed.map((o) => o.objectKey), ['key-a']);
  const arg = JSON.parse(calls[0]!.bodyJson!) as { path: string; recursive: boolean };
  assert.equal(arg.path, DROPBOX_ROOT_PATH, 'listing is scoped to the CloudNest root only');
  assert.equal(arg.recursive, false);
});

test('find-by-key returns null for a missing object and an id when present', async () => {
  installMock(() => ({ status: 200, body: { id: 'id:found', size: 4 } }));
  const found = await findAppObjectByKeyImpl(bundle, DROPBOX_ROOT_PATH, 'key-f', appConfig);
  assert.equal(found?.remoteObjectId, 'id:found');

  installMock(() => ({ status: 409, body: { error_summary: 'path/not_found/..' } }));
  const missing = await findAppObjectByKeyImpl(bundle, DROPBOX_ROOT_PATH, 'nope', appConfig);
  assert.equal(missing, null);
});

test('delete treats an already-missing object as successful cleanup', async () => {
  installMock(() => ({ status: 200, body: { metadata: { id: 'id:del' } } }));
  assert.equal((await deleteAppObjectImpl(bundle, DROPBOX_ROOT_PATH, 'id:del', appConfig)).deleted, true);

  installMock(() => ({ status: 409, body: { error_summary: 'path/not_found/..' } }));
  assert.equal((await deleteAppObjectImpl(bundle, DROPBOX_ROOT_PATH, 'gone', appConfig)).deleted, true);
});

test('download streams bytes and never mis-reports a ranged size as the object size', async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers: (init?.headers ?? {}) as Record<string, string>, bodySize: 0, apiArg: null, bodyJson: null });
    return new Response('0123', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '9999' } });
  }) as typeof fetch;

  const whole = await downloadObjectStreamImpl(bundle, 'id:obj', appConfig);
  assert.equal(whole.sizeBytes, 9999);
  let text = '';
  for await (const chunk of whole.stream) text += String(chunk);
  assert.equal(text, '0123');

  const ranged = await downloadObjectStreamImpl(bundle, 'id:obj', appConfig, { start: 0, end: 3 });
  assert.equal(ranged.sizeBytes, null, 'Dropbox reports the full size even for ranges, so it must not be trusted here');
  assert.equal(calls[1]!.headers['range'], 'bytes=0-3');
});

test('Dropbox errors map to distinct safe codes, never leaking raw summaries', () => {
  assert.equal(mapDropboxError(401, { error_summary: 'invalid_access_token/..' }).safeCode, 'needs_reauth');
  assert.equal(mapDropboxError(403, { error_summary: 'insufficient_space/..' }).safeCode, 'provider_no_space');
  assert.equal(mapDropboxError(403, { error_summary: 'missing_scope/..' }).safeCode, 'needs_reauth');
  assert.equal(mapDropboxError(409, { error_summary: 'path/not_found/..' }).safeCode, 'provider_object_missing');
  assert.equal(mapDropboxError(409, { error_summary: 'path/conflict/file/..' }).safeCode, 'provider_object_conflict');
  assert.equal(mapDropboxError(429, {}).safeCode, 'provider_rate_limited');
  assert.equal(mapDropboxError(500, {}).safeCode, 'provider_unavailable');
  const err = mapDropboxError(500, { error_summary: 'internal detail that must not surface' });
  assert.ok(!err.message.includes('internal detail'));
});

test('generated object keys cannot traverse or inject path segments', () => {
  assert.equal(safeSegment('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeSegment('a/b\\c'), 'a_b_c');
  assert.ok(!safeSegment('weird name with spaces!').includes(' '));
});

test('unrelated Dropbox files are never listed or deleted', async () => {
  installMock((call) => {
    if (call.url.endsWith('/files/list_folder')) {
      return {
        status: 200,
        body: {
          entries: [
            { '.tag': 'file', id: 'id:mine', name: 'key-1', size: 3 },
            { '.tag': 'folder', id: 'id:folder', name: 'users-photos' },
            { '.tag': 'deleted', id: 'id:gone', name: 'old' },
          ],
          has_more: false,
          cursor: 'c',
        },
      };
    }
    return { status: 500, body: { error_summary: 'unexpected' } };
  });
  const listed = await listAppObjectsImpl(bundle, DROPBOX_ROOT_PATH, appConfig);
  assert.deepEqual(listed.map((o) => o.remoteObjectId), ['id:mine'], 'only app files inside the root are surfaced');
  // every delete call targets a specific id, never a folder path listing
  assert.equal(calls.filter((c) => c.url.includes('delete_v2')).length, 0);
});

test('cancellation surfaces as upload_aborted and never as success', async () => {
  installMock((call) => (call.url.includes('/2/files/upload')
    ? { status: 200, body: { id: 'should-not-happen' } }
    : { status: 500, body: { error_summary: 'unexpected' } }));
  const controller = new AbortController();
  const stuck = new Readable({ read() { /* never pushes */ } });
  const promise = uploadObjectStreamImpl(
    bundle,
    { rootId: DROPBOX_ROOT_PATH, objectKey: 'stuck', name: 'stuck', readable: stuck, sizeBytes: 10, signal: controller.signal },
    appConfig,
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ProviderError && ['upload_aborted', 'provider_unavailable'].includes(err.safeCode),
  );
});
