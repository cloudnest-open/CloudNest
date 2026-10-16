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
  headBucketImpl,
  mapS3Error,
  objectUrl,
  fullObjectKey,
  s3EndpointOrigin,
} from '../src/providers/s3-files.js';
import { ProviderError, type ProviderCredentialBundle } from '../src/providers/types.js';

/** Mocked S3-compatible endpoint. No real network, no real credentials. */
const bundle: ProviderCredentialBundle = {
  schemaVersion: 1,
  provider: 's3',
  endpoint: 'https://acc123.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret-not-real',
  bucket: 'fx-bucket',
  prefix: 'cloudnest/',
};

interface Call { url: URL; method: string; headers: Record<string, string>; bodySize: number; bodyText: string }
const originalFetch = globalThis.fetch;
let calls: Call[] = [];

function installMock(handler: (call: Call) => { status: number; headers?: Record<string, string>; body?: string }): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const signal = init?.signal;
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw abortError();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    let bodySize = 0;
    let bodyText = '';
    const body = init?.body;
    if (body && typeof (body as ReadableStream).getReader === 'function') {
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      // an aborted request must interrupt the body drain exactly like the real
      // fetch does, and the reader must be released so nothing stays pending
      const drain = (async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bodySize += value?.length ?? 0;
          if (bodyText.length < 8192) bodyText += Buffer.from(value ?? new Uint8Array()).toString('latin1');
        }
      })();
      const abortPromise = new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      await Promise.race([drain, abortPromise]).finally(() => {
        void reader.cancel().catch(() => undefined);
      });
    }
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, bodySize, bodyText };
    calls.push(call);
    const result = handler(call);
    // 204/304 (and HEAD) responses carry no body by definition — constructing
    // one with a body throws
    const nullBody = result.status === 204 || result.status === 304 || call.method === 'HEAD';
    return new Response(nullBody ? null : (result.body ?? ''), { status: result.status, headers: result.headers ?? {} });
  }) as typeof fetch;
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('endpoint validation accepts bare https origins only', () => {
  assert.equal(s3EndpointOrigin('https://acc123.r2.cloudflarestorage.com').host, 'acc123.r2.cloudflarestorage.com');
  assert.throws(() => s3EndpointOrigin('http://acc123.r2.cloudflarestorage.com'), ProviderError);
  assert.throws(() => s3EndpointOrigin('https://host.com/some/path'), ProviderError);
  assert.throws(() => s3EndpointOrigin('not a url'), ProviderError);
});

test('object URLs are path-style and namespace every key under the prefix', () => {
  const url = objectUrl(bundle as Extract<ProviderCredentialBundle, { provider: 's3' }>, 'cloudnest/', 'chunk-abc.bin');
  assert.equal(url.pathname, '/fx-bucket/cloudnest/chunk-abc.bin');
  assert.equal(fullObjectKey('cloudnest/', 'k'), 'cloudnest/k');
  assert.equal(fullObjectKey('cloudnest', 'k'), 'cloudnest/k', 'a missing trailing slash is normalized');
});

test('upload streams one PUT under the prefix with UNSIGNED-PAYLOAD auth', async () => {
  installMock(() => ({ status: 200, headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' } }));
  const payload = Buffer.from('0123456789');
  const ref = await uploadObjectStreamImpl(
    bundle,
    { rootId: 'cloudnest/', objectKey: 'chunk-1', name: 'chunk-1', readable: Readable.from(payload), sizeBytes: payload.length },
  );
  assert.equal(ref.remoteObjectId, 'cloudnest/chunk-1');
  assert.equal(ref.sizeBytes, 10);
  assert.equal(ref.providerChecksum?.type, 'etag');

  const call = calls[0]!;
  assert.equal(call.method, 'PUT');
  assert.equal(call.url.pathname, '/fx-bucket/cloudnest/chunk-1');
  assert.equal(call.bodySize, 10, 'the exact chunk bytes are streamed');
  assert.equal(call.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.equal(call.headers['content-length'], '10');
  assert.ok(call.headers.authorization!.startsWith('AWS4-HMAC-SHA256 Credential=test-key/'));
  assert.ok(call.headers.authorization!.includes('/auto/s3/aws4_request, '));
  assert.ok(call.headers.authorization!.includes('x-amz-content-sha256'), 'the payload header is signed');
  assert.ok(!call.url.search, 'no token ever rides in a URL');
});

test('upload abort surfaces as upload_aborted, never as success', async () => {
  installMock(() => ({ status: 200 }));
  const controller = new AbortController();
  const stuck = new Readable({ read() { /* never pushes */ } });
  const promise = uploadObjectStreamImpl(
    bundle,
    { rootId: 'cloudnest/', objectKey: 'stuck', name: 'stuck', readable: stuck, sizeBytes: 10, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, (err: unknown) => err instanceof ProviderError && err.safeCode === 'upload_aborted');
});

test('find-by-key HEAD returns the object or null, scoped to the prefix', async () => {
  installMock((call) => {
    assert.equal(call.method, 'HEAD');
    assert.equal(call.url.pathname, '/fx-bucket/cloudnest/chunk-2');
    return { status: 200, headers: { 'content-length': '7' } };
  });
  const found = await findAppObjectByKeyImpl(bundle, 'cloudnest/', 'chunk-2');
  assert.equal(found?.remoteObjectId, 'cloudnest/chunk-2');
  assert.equal(found?.sizeBytes, 7);

  installMock(() => ({ status: 404 }));
  assert.equal(await findAppObjectByKeyImpl(bundle, 'cloudnest/', 'missing'), null);
});

test('list is prefix-scoped, parses the XML, and follows continuation tokens', async () => {
  let page = 0;
  installMock((call) => {
    page += 1;
    assert.equal(call.method, 'GET');
    assert.equal(call.url.pathname, '/fx-bucket/');
    assert.equal(call.url.searchParams.get('list-type'), '2');
    assert.equal(call.url.searchParams.get('prefix'), 'cloudnest/');
    if (page === 1) {
      assert.equal(call.url.searchParams.has('continuation-token'), false);
      return {
        status: 200,
        body:
          '<ListBucketResult>' +
          '<IsTruncated>true</IsTruncated><NextContinuationToken>next-token-1</NextContinuationToken>' +
          '<Contents><Key>cloudnest/a.bin</Key><Size>5</Size></Contents>' +
          '<Contents><Key>outside-prefix/secret.bin</Key><Size>9</Size></Contents>' +
          '</ListBucketResult>',
      };
    }
    assert.equal(call.url.searchParams.get('continuation-token'), 'next-token-1');
    return {
      status: 200,
      body:
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
        '<Contents><Key>cloudnest/b &amp; c.bin</Key><Size>7</Size></Contents>' +
        '</ListBucketResult>',
    };
  });
  const listed = await listAppObjectsImpl(bundle, 'cloudnest/');
  assert.deepEqual(listed.map((o) => o.remoteObjectId), ['cloudnest/a.bin', 'cloudnest/b & c.bin']);
  assert.equal(page, 2, 'listing paged twice');
});

test('delete is prefix-guarded, idempotent on 404, and refuses foreign ids before any request', async () => {
  installMock((call) => {
    assert.equal(call.method, 'DELETE');
    assert.equal(call.url.pathname, '/fx-bucket/cloudnest/chunk-3');
    return { status: 204 };
  });
  assert.equal((await deleteAppObjectImpl(bundle, 'cloudnest/', 'cloudnest/chunk-3')).deleted, true);

  installMock(() => ({ status: 404 }));
  assert.equal((await deleteAppObjectImpl(bundle, 'cloudnest/', 'cloudnest/gone')).deleted, true);

  calls = [];
  await assert.rejects(
    deleteAppObjectImpl(bundle, 'cloudnest/', 'other-namespace/secret.bin'),
    (err: unknown) => err instanceof ProviderError && err.safeCode === 'provider_object_missing',
  );
  assert.equal(calls.length, 0, 'a foreign id is refused without any network request');
});

test('download streams bytes and honours a byte range', async () => {
  installMock((call) => {
    assert.equal(call.method, 'GET');
    assert.equal(call.url.pathname, '/fx-bucket/cloudnest/chunk-4');
    if (call.headers['range']) {
      assert.equal(call.headers['range'], 'bytes=2-5');
      return { status: 206, headers: { 'content-length': '4', 'content-type': 'application/octet-stream' }, body: '2345' };
    }
    return { status: 200, headers: { 'content-length': '10', 'content-type': 'application/octet-stream' }, body: '0123456789' };
  });
  const whole = await downloadObjectStreamImpl(bundle, 'cloudnest/chunk-4');
  assert.equal(whole.sizeBytes, 10);
  let text = '';
  for await (const chunk of whole.stream) text += String(chunk);
  assert.equal(text, '0123456789');

  const ranged = await downloadObjectStreamImpl(bundle, 'cloudnest/chunk-4', undefined, { start: 2, end: 5 });
  assert.equal(ranged.sizeBytes, 4);
  text = '';
  for await (const chunk of ranged.stream) text += String(chunk);
  assert.equal(text, '2345');
});

test('connect HeadBucket distinguishes good keys, wrong keys and a missing bucket', async () => {
  installMock(() => ({ status: 200 }));
  await assert.doesNotReject(() => headBucketImpl(bundle));

  installMock(() => ({ status: 403 }));
  await assert.rejects(() => headBucketImpl(bundle), (err: unknown) => err instanceof ProviderError && err.safeCode === 'invalid_credentials');

  installMock(() => ({ status: 404 }));
  await assert.rejects(() => headBucketImpl(bundle), (err: unknown) => err instanceof ProviderError && err.safeCode === 'provider_object_missing');
});

test('ensureAppRoot is the managed prefix itself (nothing to create remotely)', async () => {
  calls = [];
  const root = await ensureAppRootImpl(bundle);
  assert.equal(root.remoteRootId, 'cloudnest/');
  assert.equal(root.created, false);
  assert.equal(calls.length, 0, 'no network request is needed');
});

test('S3 errors map to distinct safe codes', () => {
  assert.equal(mapS3Error(403).safeCode, 'invalid_credentials');
  assert.equal(mapS3Error(401).safeCode, 'invalid_credentials');
  assert.equal(mapS3Error(404).safeCode, 'provider_object_missing');
  assert.equal(mapS3Error(500, '<Error><Code>NoSuchKey</Code></Error>').safeCode, 'provider_object_missing');
  assert.equal(mapS3Error(409).safeCode, 'provider_object_conflict');
  assert.equal(mapS3Error(429).safeCode, 'provider_rate_limited');
  assert.equal(mapS3Error(503).safeCode, 'provider_rate_limited');
  assert.equal(mapS3Error(500).safeCode, 'provider_unavailable');
  assert.equal(mapS3Error(400, '<Error><Code>SignatureDoesNotMatch</Code></Error>').safeCode, 'invalid_credentials');
});

test('a non-S3 bundle is refused before any request', async () => {
  installMock(() => ({ status: 200 }));
  const bad = { schemaVersion: 1, provider: 'mega', email: 'a@b.c', password: 'x' } as unknown as ProviderCredentialBundle;
  await assert.rejects(listAppObjectsImpl(bad, 'cloudnest/'), (err: unknown) => err instanceof ProviderError && err.httpStatus === 400);
  assert.equal(calls.length, 0);
});
