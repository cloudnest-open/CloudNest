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
  mapGoogleError,
  ROOT_LABEL,
  APP_FOLDER_MIME,
} from '../src/providers/google-drive-files.js';
import { ProviderError, type ProviderCredentialBundle } from '../src/providers/types.js';

/** Mocked Google Drive HTTP. No real network access, no real credentials. */
const bundle: ProviderCredentialBundle = {
  schemaVersion: 1,
  provider: 'google_drive',
  accessToken: 'test-token-not-real',
  refreshToken: 'test-refresh-not-real',
  grantedScopes: ['https://www.googleapis.com/auth/drive.file'],
};
const appConfig = { provider: 'google_drive' as const, clientId: 'cid', clientSecret: 'csecret' };

const originalFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodySize: number;
}

let calls: Call[] = [];

function installMock(handler: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const signal = init?.signal ?? undefined;
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw abortError();

    let bodySize = 0;

    // Drain the request body with a hard abort race: a cancelled upload must
    // settle promptly even when the source stream never produces data.
    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    const drain = async (): Promise<void> => {
      const body = init?.body;
      if (typeof body === 'string') {
        bodySize = Buffer.byteLength(body);
        return;
      }
      if (body && typeof (body as ReadableStream).getReader === 'function') {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bodySize += value?.length ?? 0;
        }
        return;
      }
      if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          bodySize += (chunk as Buffer).length;
        }
      }
    };
    await Promise.race([drain(), abortPromise]);

    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodySize };
    calls.push(call);
    const result = handler(call);
    const noBodyStatuses = new Set([101, 103, 204, 205, 304]);
    const body = result.body === undefined || noBodyStatuses.has(result.status) ? null : JSON.stringify(result.body);
    return new Response(body, {
      status: result.status,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  }) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('ensureAppRoot returns the existing root without creating a duplicate', async () => {
  installMock((call) => {
    if (call.url.includes('files?q=')) return { status: 200, body: { files: [{ id: 'root-1', name: ROOT_LABEL }] } };
    return { status: 500, body: { error: { message: 'unexpected' } } };
  });
  const result = await ensureAppRootImpl(bundle, appConfig);
  assert.equal(result.remoteRootId, 'root-1');
  assert.equal(result.created, false);
  const creates = calls.filter((c) => c.method === 'POST');
  assert.equal(creates.length, 0, 'no folder created when one exists');
  // the query is scoped to the app folder label, and never lists everything
  const q = decodeURIComponent(calls[0]!.url);
  assert.ok(q.includes(`name='${ROOT_LABEL}'`));
  assert.ok(q.includes(`mimeType='${APP_FOLDER_MIME}'`));
});

test('ensureAppRoot creates the root lazily when missing', async () => {
  installMock((call) => {
    if (call.method === 'GET') return { status: 200, body: { files: [] } };
    return { status: 200, body: { id: 'new-root' } };
  });
  const result = await ensureAppRootImpl(bundle, appConfig);
  assert.equal(result.remoteRootId, 'new-root');
  assert.equal(result.created, true);
  const create = calls.find((c) => c.method === 'POST');
  assert.ok(create);
  assert.ok(create.url.includes('supportsAllDrives=true'));
});

test('upload uses a resumable session, streams the body, and returns the remote id', async () => {
  installMock((call) => {
    if (call.method === 'POST' && call.url.includes('uploadType=resumable')) {
      return { status: 200, body: null, headers: { location: 'https://upload.example/session-abc' } };
    }
    if (call.method === 'PUT' && call.url.startsWith('https://upload.example/')) {
      return { status: 200, body: { id: 'obj-1', size: '10' } };
    }
    return { status: 500, body: { error: { message: 'unexpected' } } };
  });
  const payload = Buffer.from('0123456789');
  const ref = await uploadObjectStreamImpl(
    bundle,
    { rootId: 'root-1', objectKey: 'key-1', name: 'chunk-0', readable: Readable.from(payload), sizeBytes: payload.length },
    appConfig,
  );
  assert.equal(ref.remoteObjectId, 'obj-1');
  assert.equal(ref.sizeBytes, 10);
  // session request carried the exact expected size and app-managed metadata
  const session = calls.find((c) => c.method === 'POST')!;
  assert.equal(session.headers['x-upload-content-length'], '10');
  // the data request used PUT with a correct Content-Range and streamed exactly the bytes
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.headers['content-range'], 'bytes 0-9/10');
  assert.equal(put.headers['content-length'], '10');
  assert.equal(put.bodySize, 10, 'exactly the chunk bytes were streamed');
});

test('upload resume drops the acknowledged prefix and sets the right range', async () => {
  installMock((call) => {
    if (call.method === 'POST') return { status: 200, body: null, headers: { location: 'https://upload.example/session-xyz' } };
    return { status: 200, body: { id: 'obj-2', size: '10' } };
  });
  const full = Buffer.from('0123456789');
  const suffix = full.subarray(4); // provider already acknowledged first 4 bytes
  await uploadObjectStreamImpl(
    bundle,
    { rootId: 'root-1', objectKey: 'key-2', name: 'chunk-1', readable: Readable.from(suffix), sizeBytes: 10, acknowledgedBytes: 4 },
    appConfig,
  );
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.headers['content-range'], 'bytes 4-9/10');
  assert.equal(put.bodySize, 6, 'only the unacknowledged suffix was sent');
});

test('cancellation surfaces as upload_aborted and never as success', async () => {
  installMock((call) => {
    if (call.method === 'POST') return { status: 200, body: null, headers: { location: 'https://upload.example/session-abort' } };
    return { status: 200, body: { id: 'should-not-happen' } };
  });
  const controller = new AbortController();
  // a stream that never ends: only cancellation can resolve the upload
  const stuck = new Readable({ read() { /* intentionally never pushes */ } });
  const promise = uploadObjectStreamImpl(
    bundle,
    { rootId: 'root-1', objectKey: 'key-3', name: 'chunk-2', readable: stuck, sizeBytes: 10, signal: controller.signal },
    appConfig,
  );
  // abort shortly after the session request begins
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ProviderError && ['upload_aborted', 'provider_unavailable'].includes(err.safeCode),
  );
});

test('find/delete/list are scoped to the CloudNest root and app keys only', async () => {
  installMock((call) => {
    if (call.method === 'GET' && call.url.includes('cloudnestKey')) {
      return { status: 200, body: { files: [{ id: 'obj-9', size: '5', appProperties: { cloudnestKey: 'key-9' } }] } };
    }
    if (call.method === 'DELETE') return { status: 204, body: null };
    return { status: 500, body: { error: { message: 'unexpected' } } };
  });

  const found = await findAppObjectByKeyImpl(bundle, 'root-1', 'key-9', appConfig);
  assert.equal(found?.remoteObjectId, 'obj-9');
  const listQ = decodeURIComponent(calls[0]!.url);
  assert.ok(listQ.includes("'root-1' in parents"), 'scoped to the app root');
  assert.ok(listQ.includes('appProperties'), 'scoped to app-managed objects');

  const listed = await listAppObjectsImpl(bundle, 'root-1', appConfig);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.objectKey, 'key-9');

  const del = await deleteAppObjectImpl(bundle, 'root-1', 'obj-9', appConfig);
  assert.equal(del.deleted, true);
  const delCall = calls.find((c) => c.method === 'DELETE')!;
  assert.ok(delCall.url.includes('supportsAllDrives=true'));
});

test('deleting an already-missing object is treated as successful cleanup', async () => {
  installMock(() => ({ status: 404, body: { error: { message: 'notFound' } } }));
  const res = await deleteAppObjectImpl(bundle, 'root-1', 'gone', appConfig);
  assert.equal(res.deleted, true);
});

test('download streams bytes and supports a byte range', async () => {
  calls = []; // this test installs its own minimal fetch, so reset the recorder
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers: (init?.headers ?? {}) as Record<string, string>, bodySize: 0 });
    return new Response('0123', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '4' } });
  }) as typeof fetch;
  const out = await downloadObjectStreamImpl(bundle, 'obj-1', appConfig, { start: 0, end: 3 });
  assert.equal(out.sizeBytes, 4);
  assert.equal(out.contentType, 'application/octet-stream');
  assert.equal(calls[0]!.headers['range'] ?? calls[0]!.headers['Range'], 'bytes=0-3');
  let text = '';
  for await (const chunk of out.stream) text += String(chunk);
  assert.equal(text, '0123');
});

test('Google error mapping produces distinct safe codes', () => {
  assert.equal(mapGoogleError(401, {}).safeCode, 'needs_reauth');
  assert.equal(mapGoogleError(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } }).safeCode, 'provider_no_space');
  assert.equal(mapGoogleError(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }).safeCode, 'provider_rate_limited');
  assert.equal(mapGoogleError(429, {}).safeCode, 'provider_rate_limited');
  assert.equal(mapGoogleError(404, {}).safeCode, 'provider_object_missing');
  assert.equal(mapGoogleError(503, {}).safeCode, 'provider_unavailable');
  // never leaks raw provider messages to callers
  const err = mapGoogleError(403, { error: { message: 'internal detail that must not surface' } });
  assert.ok(!err.message.includes('internal detail'));
});

test('the connector only ever lists app-managed objects, never unrelated files', async () => {
  installMock((call) => {
    if (call.url.includes('/files?')) {
      // even if the provider returned unrelated files, only app-keyed objects are kept
      return {
        status: 200,
        body: {
          files: [
            { id: 'mine', size: '3', appProperties: { cloudnestKey: 'k1' } },
            { id: 'users-photo', size: '999' },
          ],
        },
      };
    }
    return { status: 500, body: { error: { message: 'unexpected' } } };
  });
  const listed = await listAppObjectsImpl(bundle, 'root-1', appConfig);
  assert.deepEqual(listed.map((o) => o.remoteObjectId), ['mine']);
});
