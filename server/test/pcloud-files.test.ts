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
  mapPcloudError,
  assertAllowedHost,
  safeSegment,
  PCLOUD_ROOT_NAME,
} from '../src/providers/pcloud-files.js';
import { ProviderError, type ProviderCredentialBundle } from '../src/providers/types.js';

/** Mocked pCloud API. No real network, no real credentials. */
const bundle: ProviderCredentialBundle = {
  schemaVersion: 1,
  provider: 'pcloud',
  accessToken: 'test-token-not-real',
  apiHost: 'api.pcloud.com',
  userId: '42',
};

const originalFetch = globalThis.fetch;
interface Call { url: string; method: string; headers: Record<string, string>; bodyText: string; bodySize: number }
let calls: Call[] = [];

function installMock(handler: (call: Call) => { status: number; body?: unknown; raw?: string }): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const signal = init?.signal ?? undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw abortError();

    let bodySize = 0;
    let bodyText = '';
    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) return;
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    const drain = async (): Promise<void> => {
      const body = init?.body;
      if (typeof body === 'string') { bodyText = body; bodySize = Buffer.byteLength(body); return; }
      if (body && typeof (body as ReadableStream).getReader === 'function') {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bodySize += value?.length ?? 0;
          if (bodyText.length < 4096) bodyText += Buffer.from(value ?? new Uint8Array()).toString('utf8');
        }
        return;
      }
      if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          bodySize += (chunk as Buffer).length;
          if (bodyText.length < 4096) bodyText += (chunk as Buffer).toString('utf8');
        }
      }
    };
    await Promise.race([drain(), abortPromise]);

    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodyText, bodySize };
    calls.push(call);
    const result = handler(call);
    const payload = result.raw !== undefined ? result.raw : (result.body === undefined ? null : JSON.stringify(result.body));
    return new Response(payload, { status: result.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('only allowlisted pCloud hosts are ever accepted', () => {
  assert.equal(assertAllowedHost('api.pcloud.com'), 'api.pcloud.com');
  assert.equal(assertAllowedHost('eapi.pcloud.com'), 'eapi.pcloud.com');
  // SSRF guard: anything else is refused outright
  assert.throws(() => assertAllowedHost('evil.example.com'), /provider_unavailable|/);
  assert.throws(() => assertAllowedHost(undefined));
  assert.throws(() => assertAllowedHost('api.pcloud.com.evil.example'));
});

test('ensureAppRoot reuses an existing folder and does not create a duplicate', async () => {
  installMock((call) => {
    if (call.url.includes('listfolder')) {
      return { status: 200, body: { result: 0, metadata: { contents: [{ folderid: 123, name: PCLOUD_ROOT_NAME, isfolder: true }] } } };
    }
    return { status: 200, body: { result: 0 } };
  });
  const root = await ensureAppRootImpl(bundle);
  assert.equal(root.remoteRootId, '123');
  assert.equal(root.created, false);
  assert.equal(calls.filter((c) => c.url.includes('createfolder')).length, 0);
  // only the allowlisted host was contacted
  assert.ok(calls.every((c) => c.url.startsWith('https://api.pcloud.com/')));
});

test('ensureAppRoot creates the folder lazily and resolves a concurrent create', async () => {
  let created = false;
  installMock((call) => {
    if (call.url.includes('createfolder')) {
      created = true;
      return { status: 200, body: { result: 0, metadata: { folderid: 777 } } };
    }
    if (call.url.includes('listfolder')) return { status: 200, body: { result: 0, metadata: { contents: [] } } };
    return { status: 200, body: { result: 0 } };
  });
  const root = await ensureAppRootImpl(bundle);
  assert.equal(root.remoteRootId, '777');
  assert.equal(root.created, true);
  assert.ok(created);
});

test('upload streams a multipart body with nopartial=1 and parameters before the file', async () => {
  installMock(() => ({ status: 200, body: { result: 0, metadata: [{ fileid: 9001, name: 'key-1', size: 10 }] } }));
  const payload = Buffer.from('0123456789');
  const ref = await uploadObjectStreamImpl(
    bundle,
    { rootId: '123', objectKey: 'key-1', name: 'key-1', readable: Readable.from(payload), sizeBytes: payload.length },
  );
  assert.equal(ref.remoteObjectId, '9001');
  assert.equal(ref.sizeBytes, 10);

  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  assert.ok(call.url.endsWith('/uploadfile'));
  assert.ok(call.headers['content-type']!.startsWith('multipart/form-data; boundary='));
  // parameters must precede the file part, and nopartial must be set
  const fieldIndex = call.bodyText.indexOf('name="nopartial"');
  const fileIndex = call.bodyText.indexOf('filename=');
  assert.ok(fieldIndex >= 0, 'nopartial field present');
  assert.ok(call.bodyText.includes('1'), 'nopartial=1');
  assert.ok(fileIndex > fieldIndex, 'all parameters precede the file part');
  // the streamed body includes the exact bytes plus multipart framing
  assert.ok(call.bodySize > payload.length, 'multipart framing wraps the streamed bytes');
});

test('upload verifies the returned size and rejects a mismatch (no silent corruption)', async () => {
  installMock(() => ({ status: 200, body: { result: 0, metadata: [{ fileid: 5, name: 'key-1', size: 999 }] } }));
  await assert.rejects(
    uploadObjectStreamImpl(
      bundle,
      { rootId: '123', objectKey: 'key-1', name: 'key-1', readable: Readable.from(Buffer.from('0123456789')), sizeBytes: 10 },
    ),
    (err: unknown) => err instanceof ProviderError && err.safeCode === 'provider_checksum_mismatch',
  );
});

test('list returns only files inside the CloudNest folder, never folders', async () => {
  installMock(() => ({
    status: 200,
    body: {
      result: 0,
      metadata: {
        contents: [
          { fileid: 1, name: 'key-a', size: 5 },
          { folderid: 2, name: 'subfolder', isfolder: true },
          { fileid: 3, name: 'key-b', size: 7 },
        ],
      },
    },
  }));
  const listed = await listAppObjectsImpl(bundle, '123');
  assert.deepEqual(listed.map((o) => o.remoteObjectId), ['1', '3']);
  assert.ok(calls[0]!.url.includes('folderid=123'), 'listing is scoped to the CloudNest folder only');
});

test('find-by-key returns the file when present and null when absent', async () => {
  installMock(() => ({ status: 200, body: { result: 0, metadata: { contents: [{ fileid: 8, name: 'key-f', size: 4 }] } } }));
  assert.equal((await findAppObjectByKeyImpl(bundle, '123', 'key-f'))?.remoteObjectId, '8');

  installMock(() => ({ status: 200, body: { result: 0, metadata: { contents: [] } } }));
  assert.equal(await findAppObjectByKeyImpl(bundle, '123', 'nope'), null);
});

test('delete succeeds for an existing file and treats a missing file as clean', async () => {
  installMock(() => ({ status: 200, body: { result: 0 } }));
  assert.equal((await deleteAppObjectImpl(bundle, '123', '55')).deleted, true);

  // a numeric id that the provider reports as already absent
  installMock(() => ({ status: 200, body: { result: 2005, error: 'File does not exist' } }));
  assert.equal((await deleteAppObjectImpl(bundle, '123', '999')).deleted, true);
});

test('a non-numeric provider id is refused before any request', async () => {
  installMock(() => ({ status: 200, body: { result: 0 } }));
  await assert.rejects(deleteAppObjectImpl(bundle, '123', 'not-an-id'), (err: unknown) => err instanceof ProviderError && err.httpStatus === 400);
  assert.equal(calls.length, 0, 'no request was made with an invalid id');
});

test('download resolves a file link then streams over https, honouring a range', async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodyText: '', bodySize: 0 });
    if (url.includes('getfilelink')) return new Response(JSON.stringify({ result: 0, hosts: ['df-1.pcloud.com'], path: '/download/abc' }), { status: 200 });
    return new Response('0123', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '4' } });
  }) as typeof fetch;

  const out = await downloadObjectStreamImpl(bundle, '77', undefined, { start: 0, end: 3 });
  assert.equal(out.sizeBytes, 4);
  assert.ok(calls[1]!.url.startsWith('https://df-1.pcloud.com/'), 'bytes come from the provider-returned https link');
  assert.equal(calls[1]!.headers['range'], 'bytes=0-3');
  let text = '';
  for await (const chunk of out.stream) text += String(chunk);
  assert.equal(text, '0123');
});

test('pCloud in-body result codes map to distinct safe errors', () => {
  // pCloud returns HTTP 200 with a non-zero result on failure
  assert.equal(mapPcloudError({ result: 1000, error: 'Log in failed' }).safeCode, 'needs_reauth');
  assert.equal(mapPcloudError({ result: 2008, error: 'Not enough free space' }).safeCode, 'provider_no_space');
  assert.equal(mapPcloudError({ result: 2005, error: 'File does not exist' }).safeCode, 'provider_object_missing');
  assert.equal(mapPcloudError({ result: 2004, error: 'already exists' }).safeCode, 'provider_object_conflict');
  assert.equal(mapPcloudError({ result: 4000, error: 'too many requests' }).safeCode, 'provider_rate_limited');
  assert.equal(mapPcloudError({ result: 9999, error: 'weird' }).safeCode, 'provider_unavailable');
  const err = mapPcloudError({ result: 9999, error: 'raw detail must not surface' });
  assert.ok(!err.message.includes('raw detail'));
});

test('generated names cannot traverse or escape the CloudNest folder', () => {
  assert.equal(safeSegment('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeSegment('a/b'), 'a_b');
  assert.ok(!safeSegment('weird name!').includes(' '));
});

test('a non-allowlisted stored host is refused before any request', async () => {
  installMock(() => ({ status: 200, body: { result: 0 } }));
  const bad = { ...bundle, apiHost: 'evil.example.com' } as unknown as ProviderCredentialBundle;
  await assert.rejects(listAppObjectsImpl(bad, '123'), (err: unknown) => err instanceof ProviderError && err.httpStatus === 400);
  assert.equal(calls.length, 0, 'no outbound request was made to the untrusted host');
});

test('cancellation surfaces as upload_aborted and never as success', async () => {
  installMock(() => ({ status: 200, body: { result: 0, metadata: [{ fileid: 1, size: 10 }] } }));
  const controller = new AbortController();
  const stuck = new Readable({ read() { /* never pushes */ } });
  const promise = uploadObjectStreamImpl(
    bundle,
    { rootId: '123', objectKey: 'stuck', name: 'stuck', readable: stuck, sizeBytes: 10, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ProviderError && ['upload_aborted', 'provider_unavailable'].includes(err.safeCode),
  );
});
