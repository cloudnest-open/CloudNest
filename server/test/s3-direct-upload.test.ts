import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp, Client } from './helpers.js';

/**
 * Roadmap Phase 2 acceptance: the presigned direct transfer over the real
 * HTTP API. The browser path is exercised by driving the same requests the
 * SPA makes — begin → PUT to the presigned URL on the (mocked) provider host
 * → complete — and every durable outcome is asserted against the temp
 * database. No real bucket, keys or network are involved.
 */

const PASSWORD = 'test-access-code-123';
const MIB = 1024 * 1024;
const S3_BODY = {
  endpoint: 'https://acc123.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'TESTKEY-not-real',
  secretAccessKey: 'TESTSECRET-not-real',
  bucket: 'fx-bucket',
  prefix: 'cloudnest',
  capacityCapBytes: 500 * 1024 * 1024 * 1024,
};

/**
 * Mock ONLY the provider host: PUT records the byte count and answers with an
 * ETag, HEAD answers with the recorded size (or 404). App traffic passes
 * through untouched.
 */
async function withDirectApp(
  fn: (app: TestApp, client: Client, objects: Map<string, number>) => Promise<void>,
): Promise<void> {
  const app = await startTestApp();
  const objects = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.host !== 'acc123.r2.cloudflarestorage.com') return originalFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = decodeURIComponent(url.pathname.replace(/^\/fx-bucket\/?/, ''));
    if (method === 'PUT') {
      const size = (init?.body as Uint8Array | undefined)?.byteLength ?? 0;
      objects.set(key, size);
      return new Response(null, { status: 200, headers: { etag: '"mock-etag-1"' } });
    }
    if (method === 'HEAD') {
      if (url.pathname === '/fx-bucket') return new Response(null, { status: 200 });
      const size = objects.get(key);
      if (size === undefined) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-length': String(size) } });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  try {
    const client = new Client(app.url);
    await client.setup(PASSWORD);
    await fn(app, client, objects);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
}

function connectS3(client: Client): Promise<{ status: number; body: unknown }> {
  return client.post('/api/providers/s3/credentials', S3_BODY);
}

interface BeginDirect {
  mode: 'proxy' | 'direct';
  attemptId?: string;
  objectKey?: string;
  url?: string;
  expiresAt?: string;
}

async function planAndBegin(
  client: Client,
  body: Record<string, unknown>,
  idempotencyKey: string,
  chunkIndex: number,
): Promise<{ planRes: { status: number; body: unknown }; beginRes: { status: number; body: unknown } }> {
  const planRes = await client.post('/api/uploads/plan', body, { 'idempotency-key': idempotencyKey });
  const jobId = (planRes.body as { jobId?: string }).jobId ?? '';
  const beginRes = await client.post(`/api/uploads/${jobId}/chunks/${chunkIndex}/begin`, {});
  return { planRes, beginRes };
}

test('a business chunk flows begin → direct PUT → complete with an honest placement', async () => {
  await withDirectApp(async (app, client) => {
    const connect = await connectS3(client);
    assert.equal(connect.status, 201, JSON.stringify(connect.body));

    const planRes = await client.post(
      '/api/uploads/plan',
      // 24 MiB sits above the 20 MiB single-object threshold, so the business
      // file really splits into three 8 MiB chunks — which is what the
      // direct-chunk flow under test needs
      { originalName: 'direct.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, tier: 'business' },
      { 'idempotency-key': 'direct-e2e-1' },
    );
    assert.equal(planRes.status, 201, JSON.stringify(planRes.body));
    const plan = planRes.body as { jobId: string; chunkCount: number; allocations: Array<Record<string, unknown>> };
    assert.equal(plan.chunkCount, 3);
    // the plan shape never names the account behind an allocation
    assert.ok(!JSON.stringify(plan).includes('accountId'));

    const bytes0 = crypto.randomBytes(8 * MIB);
    const digest0 = crypto.createHash('sha256').update(bytes0).digest('hex');
    const begin0 = await client.post(`/api/uploads/${plan.jobId}/chunks/0/begin`, {});
    assert.equal(begin0.status, 200, JSON.stringify(begin0.body));
    const direct0 = begin0.body as BeginDirect;
    assert.equal(direct0.mode, 'direct');
    assert.ok(direct0.url && direct0.attemptId && direct0.objectKey);
    assert.ok(direct0.url.startsWith('https://acc123.r2.cloudflarestorage.com/fx-bucket/'), direct0.url);
    assert.ok((direct0.url ?? '').includes('X-Amz-Signature='));
    // the presigned URL carries a query signature, never the secret key, and
    // the response never names the account
    assert.ok(!JSON.stringify(begin0.body).includes('TESTSECRET-not-real'));
    assert.ok(!JSON.stringify(begin0.body).includes('accountId'));

    const put0 = await fetch(direct0.url!, { method: 'PUT', body: bytes0 });
    assert.equal(put0.status, 200);
    const etag0 = put0.headers.get('etag');

    const complete0 = await client.post(`/api/uploads/${plan.jobId}/chunks/0/complete`, {
      attemptId: direct0.attemptId, sha256: digest0, etag: etag0,
    });
    assert.equal(complete0.status, 200, JSON.stringify(complete0.body));
    assert.equal((complete0.body as { chunksCompleted: number }).chunksCompleted, 1);

    // durable honesty: the placement is 'uploaded' (etag is not comparable),
    // the attempt is committed, and the stored digest is the client-reported one
    const placement = app.db.prepare(
      `SELECT p.state, p.provider_checksum_type FROM chunk_placements p
       JOIN file_chunks fc ON fc.id = p.chunk_id WHERE p.is_active = 1`,
    ).get() as { state: string; provider_checksum_type: string | null };
    assert.equal(placement.state, 'uploaded');
    assert.notEqual(placement.state, 'verified');
    assert.equal(placement.provider_checksum_type, 'etag');
    const chunkRow = app.db.prepare('SELECT sha256 FROM file_chunks').get() as { sha256: string };
    assert.equal(chunkRow.sha256, digest0);
    const attempt0 = app.db.prepare('SELECT state FROM upload_attempts WHERE id = ?').get(direct0.attemptId) as { state: string };
    assert.equal(attempt0.state, 'committed');

    // second chunk completes three-of-three; the file is not done yet
    const bytes1 = crypto.randomBytes(8 * MIB);
    const digest1 = crypto.createHash('sha256').update(bytes1).digest('hex');
    const begin1 = await client.post(`/api/uploads/${plan.jobId}/chunks/1/begin`, {});
    assert.equal(begin1.status, 200);
    const direct1 = begin1.body as BeginDirect;
    assert.equal(direct1.mode, 'direct');
    const put1 = await fetch(direct1.url!, { method: 'PUT', body: bytes1 });
    assert.equal(put1.status, 200);
    const complete1 = await client.post(`/api/uploads/${plan.jobId}/chunks/1/complete`, {
      attemptId: direct1.attemptId, sha256: digest1, etag: put1.headers.get('etag'),
    });
    assert.equal(complete1.status, 200);
    assert.equal((complete1.body as { fileCompleted: boolean }).fileCompleted, false);

    // third (final) chunk completes the file
    const bytes2 = crypto.randomBytes(8 * MIB);
    const digest2 = crypto.createHash('sha256').update(bytes2).digest('hex');
    const begin2 = await client.post(`/api/uploads/${plan.jobId}/chunks/2/begin`, {});
    assert.equal(begin2.status, 200);
    const direct2 = begin2.body as BeginDirect;
    assert.equal(direct2.mode, 'direct');
    const put2 = await fetch(direct2.url!, { method: 'PUT', body: bytes2 });
    assert.equal(put2.status, 200);
    const complete2 = await client.post(`/api/uploads/${plan.jobId}/chunks/2/complete`, {
      attemptId: direct2.attemptId, sha256: digest2, etag: put2.headers.get('etag'),
    });
    assert.equal(complete2.status, 200);
    assert.equal((complete2.body as { fileCompleted: boolean }).fileCompleted, true);

    const jobRes = await client.get(`/api/uploads/${plan.jobId}`);
    assert.equal((jobRes.body as { job: { state: string } }).job.state, 'completed');

    // once an S3 account exists, the document CSP widens its connect-src to
    // exactly the configured endpoint origin so the browser can PUT there
    const health = await client.get('/api/health');
    const csp = health.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("connect-src 'self' https://acc123.r2.cloudflarestorage.com"), csp);
  });
});

test('a wrong-size direct PUT is a failure with a cleanup obligation, not a commit', async () => {
  await withDirectApp(async (app, client, objects) => {
    await connectS3(client);
    const { planRes, beginRes } = await planAndBegin(
      client,
      { originalName: 'short.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, tier: 'business' },
      'direct-mismatch-1', 0,
    );
    assert.equal(planRes.status, 201);
    assert.equal(beginRes.status, 200);
    const jobId = (planRes.body as { jobId: string }).jobId;
    const direct = beginRes.body as BeginDirect;
    assert.equal(direct.mode, 'direct');

    // only half the bytes reach the bucket
    const bytes = crypto.randomBytes(4 * MIB);
    const put = await fetch(direct.url!, { method: 'PUT', body: bytes });
    assert.equal(put.status, 200);

    const digest = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
    const complete = await client.post(`/api/uploads/${jobId}/chunks/0/complete`, {
      attemptId: direct.attemptId, sha256: digest, etag: '"mock-etag-1"',
    });
    assert.equal(complete.status, 400);
    assert.equal((complete.body as { code?: string }).code, 'chunk_size_mismatch');

    // the wrong-size object exists remotely, so the attempt must carry the
    // durable cleanup obligation (UL-3) — never a silent success
    const attempt = app.db.prepare('SELECT state, remote_object_id FROM upload_attempts WHERE id = ?')
      .get(direct.attemptId) as { state: string; remote_object_id: string | null };
    assert.equal(attempt.state, 'cleanup_pending');
    assert.ok(attempt.remote_object_id);
    assert.equal(objects.size, 1, 'the provider mock saw exactly the wrong-size object');
    const placements = app.db.prepare('SELECT COUNT(*) AS n FROM chunk_placements').get() as { n: number };
    assert.equal(placements.n, 0, 'no placement was created');
  });
});

test('completing a direct attempt whose object never landed fails honestly', async () => {
  await withDirectApp(async (app, client) => {
    await connectS3(client);
    const { planRes, beginRes } = await planAndBegin(
      client,
      { originalName: 'ghost.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, tier: 'business' },
      'direct-missing-1', 0,
    );
    assert.equal(planRes.status, 201);
    const jobId = (planRes.body as { jobId: string }).jobId;
    const direct = beginRes.body as BeginDirect;
    assert.equal(direct.mode, 'direct');

    const digest = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
    const complete = await client.post(`/api/uploads/${jobId}/chunks/0/complete`, {
      attemptId: direct.attemptId, sha256: digest, etag: null,
    });
    assert.equal(complete.status, 409);
    assert.equal((complete.body as { code?: string }).code, 'provider_object_missing');

    const attempt = app.db.prepare('SELECT state, remote_object_id FROM upload_attempts WHERE id = ?')
      .get(direct.attemptId) as { state: string; remote_object_id: string | null };
    assert.equal(attempt.state, 'failed');
    assert.equal(attempt.remote_object_id, null);
    const placements = app.db.prepare('SELECT COUNT(*) AS n FROM chunk_placements').get() as { n: number };
    assert.equal(placements.n, 0);
  });
});

test('OAuth accounts stay on the proxy path and keep the 2-in-flight cap', async () => {
  await withDirectApp(async (app, client) => {
    // a connected personal OAuth pool (no credentials needed: begin never
    // touches the provider for the proxy path)
    const now = new Date().toISOString();
    app.db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, tier,
        quota_total_bytes, used_bytes, quota_status, capacity_cap_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`,
    ).run('acc-personal', 'google_drive', 'Personal Drive', 'ident-p', 'personal', 100 * MIB, 0, 'current', null, now, now);

    const planRes = await client.post(
      '/api/uploads/plan',
      { originalName: 'home.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, tier: 'personal' },
      { 'idempotency-key': 'direct-oauth-1' },
    );
    assert.equal(planRes.status, 201);
    const plan = planRes.body as { jobId: string; chunkCount: number };
    assert.equal(plan.chunkCount, 3);

    const begin0 = await client.post(`/api/uploads/${plan.jobId}/chunks/0/begin`, {});
    assert.equal(begin0.status, 200);
    assert.equal((begin0.body as BeginDirect).mode, 'proxy');
    assert.equal((begin0.body as BeginDirect).url, undefined, 'no presigned URL ever leaves for OAuth pools');

    const begin1 = await client.post(`/api/uploads/${plan.jobId}/chunks/1/begin`, {});
    assert.equal(begin1.status, 200);
    assert.equal((begin1.body as BeginDirect).mode, 'proxy');

    const begin2 = await client.post(`/api/uploads/${plan.jobId}/chunks/2/begin`, {});
    assert.equal(begin2.status, 429);
    assert.equal((begin2.body as { code?: string }).code, 'account_busy');
    assert.equal(begin2.headers.get('retry-after'), '2');

    // without any S3 account the CSP stays exactly as before
    const health = await client.get('/api/health');
    const csp = health.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("connect-src 'self'"), csp);
    assert.ok(!csp.includes('acc123'), csp);
  });
});

test('the S3 window is wide: more than two chunks may be in flight at once', async () => {
  await withDirectApp(async (app, client) => {
    await connectS3(client);
    const planRes = await client.post(
      '/api/uploads/plan',
      { originalName: 'wide.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, tier: 'business' },
      { 'idempotency-key': 'direct-wide-1' },
    );
    assert.equal(planRes.status, 201);
    const plan = planRes.body as { jobId: string; chunkCount: number };
    assert.equal(plan.chunkCount, 3);
    for (const index of [0, 1, 2]) {
      const begin = await client.post(`/api/uploads/${plan.jobId}/chunks/${index}/begin`, {});
      assert.equal(begin.status, 200, JSON.stringify(begin.body));
      assert.equal((begin.body as BeginDirect).mode, 'direct');
    }
  });
});

test('the direct routes are guarded: auth, CSRF and unknown jobs', async () => {
  await withDirectApp(async (app, client) => {
    // no session → 401 before anything else
    const stranger = new Client(app.url);
    const unauth = await stranger.post('/api/uploads/unknown-job/chunks/0/begin', {});
    assert.equal(unauth.status, 401);

    // a bad CSRF token → 403
    const badCsrf = await client.postWithToken('/api/uploads/unknown-job/chunks/0/begin', {}, 'not-the-token');
    assert.equal(badCsrf.status, 403);

    // authenticated but unknown job → 404
    const missing = await client.post('/api/uploads/unknown-job/chunks/0/begin', {});
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code?: string }).code, 'job_not_found');

    const missingComplete = await client.post('/api/uploads/unknown-job/chunks/0/complete', {
      attemptId: 'a', sha256: 'a'.repeat(64), etag: null,
    });
    assert.equal(missingComplete.status, 404);
    const missingFail = await client.post('/api/uploads/unknown-job/chunks/0/fail', { attemptId: 'a' });
    assert.equal(missingFail.status, 404);
  });
});
