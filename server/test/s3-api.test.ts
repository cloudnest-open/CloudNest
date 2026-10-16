import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, Client } from './helpers.js';

/**
 * Roadmap Phase 1: the S3-compatible connect flow over the real HTTP API —
 * owner-only, credential-form based (no OAuth), with the owner-set capacity
 * cap and honest error reporting. The provider endpoint is mocked at
 * globalThis.fetch, so no real bucket or credentials are involved.
 */

const PASSWORD = 'test-access-code-123';
const S3_BODY = {
  endpoint: 'https://acc123.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'TESTKEY-not-real',
  secretAccessKey: 'TESTSECRET-not-real',
  bucket: 'fx-bucket',
  prefix: 'cloudnest',
  capacityCapBytes: 500 * 1024 * 1024 * 1024,
};

async function withAppAndMock(mock: (url: URL, method: string) => { status: number }, fn: (app: TestApp, client: Client) => Promise<void>): Promise<void> {
  const app = await startTestApp();
  const originalFetch = globalThis.fetch;
  // intercept ONLY the provider host: the app's own HTTP traffic (the test
  // client's calls) must pass through untouched
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.host !== 'acc123.r2.cloudflarestorage.com') return originalFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const result = mock(url, method);
    const nullBody = result.status === 204 || result.status === 304 || method === 'HEAD';
    return new Response(nullBody ? null : '', { status: result.status });
  }) as typeof fetch;
  try {
    const client = new Client(app.url);
    await client.setup(PASSWORD);
    await fn(app, client);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
}

test('S3 connect creates a business-tier account with the owner-set cap', async () => {
  await withAppAndMock((_url, method) => ({ status: method === 'HEAD' ? 200 : 200 }), async (_app, client) => {
    const res = await client.post('/api/providers/s3/credentials', S3_BODY);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const accounts = await client.get('/api/provider-accounts');
    const list = (accounts.body as { accounts: Array<Record<string, unknown>> }).accounts;
    const s3 = list.find((a) => a['provider'] === 's3') as Record<string, unknown>;
    assert.ok(s3, 'the S3 account exists');
    assert.equal(s3['tier'], 'business');
    assert.equal(s3['capacityCapBytes'], S3_BODY.capacityCapBytes);
    assert.equal(s3['displayLabel'], 'fx-bucket');
    assert.equal((s3['quota'] as Record<string, unknown>).status, 'current');
    assert.equal((s3['quota'] as Record<string, unknown>).totalBytes, S3_BODY.capacityCapBytes);
    // the secret never reaches any response
    assert.ok(!JSON.stringify(accounts.body).includes('TESTSECRET-not-real'));
  });
});

test('S3 connect reports wrong keys honestly and creates no account', async () => {
  await withAppAndMock(() => ({ status: 403 }), async (_app, client) => {
    const res = await client.post('/api/providers/s3/credentials', S3_BODY);
    assert.equal(res.status, 401);
    assert.equal((res.body as { code?: string }).code, 'invalid_credentials');
    const accounts = await client.get('/api/provider-accounts');
    const list = (accounts.body as { accounts: Array<Record<string, unknown>> }).accounts;
    assert.equal(list.filter((a) => a['provider'] === 's3').length, 0, 'no account was created');
  });
});

test('S3 connect rejects a missing bucket with a 404-shaped safe error', async () => {
  await withAppAndMock(() => ({ status: 404 }), async (_app, client) => {
    const res = await client.post('/api/providers/s3/credentials', S3_BODY);
    assert.equal(res.status, 404);
    assert.equal((res.body as { code?: string }).code, 'provider_object_missing');
  });
});

test('S3 connect validates the endpoint and the cap before any request', async () => {
  await withAppAndMock((_url, method) => {
    throw new Error(`no provider request should be made, saw ${method}`);
  }, async (_app, client) => {
    const badEndpoint = await client.post('/api/providers/s3/credentials', { ...S3_BODY, endpoint: 'http://insecure.example.com' });
    assert.equal(badEndpoint.status, 400);
    assert.equal((badEndpoint.body as { code?: string }).code, 'invalid_request');

    const badBucket = await client.post('/api/providers/s3/credentials', { ...S3_BODY, bucket: 'not a bucket!' });
    assert.equal(badBucket.status, 400);

    const noKeys = await client.post('/api/providers/s3/credentials', { ...S3_BODY, accessKeyId: '', secretAccessKey: '' });
    assert.equal(noKeys.status, 400);
  });
});

test('S3 accounts accept a credentials-style reconnect and refresh from tracked bytes', async () => {
  await withAppAndMock((_url, method) => ({ status: method === 'HEAD' ? 200 : 200 }), async (_app, client) => {
    await client.post('/api/providers/s3/credentials', S3_BODY);
    const accounts = await client.get('/api/provider-accounts');
    const s3 = (accounts.body as { accounts: Array<{ id: string; provider: string }> }).accounts.find((a) => a.provider === 's3')!;

    const reconnect = await client.post(`/api/provider-accounts/${s3.id}/reconnect`);
    assert.equal(reconnect.status, 200);
    assert.equal((reconnect.body as { mode?: string }).mode, 'credentials');

    // refresh computes the cap-based quota locally (no provider quota API)
    const refresh = await client.post(`/api/provider-accounts/${s3.id}/refresh-quota`);
    assert.equal(refresh.status, 200);
    const result = (refresh.body as { result: { ok: boolean; status: string } }).result;
    assert.equal(result.ok, true);
    assert.equal(result.status, 'current');
  });
});
