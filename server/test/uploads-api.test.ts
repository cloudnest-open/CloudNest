import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { openDatabase } from '../src/db/index.js';

/**
 * Route-level tests for the upload API (M9.e).
 * These exercise the real HTTP surface: admin auth, CSRF, the raw chunk body
 * route, validation and the JSON error envelope.
 */

const GOOD = 'correct horse battery staple';
const MIB = 1024 * 1024;

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

/** Insert a connected account with current quota directly into the app DB. */
function seedAccount(dbPath: string, opts: {
  id: string; provider: string; total: number; used: number; quotaStatus?: string;
}): void {
  const { db, close } = openDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
        quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, 0, 0, ?, ?)`,
    ).run(opts.id, opts.provider, `${opts.id}@example.com`, `ident-${opts.id}`,
      opts.total, opts.used, opts.quotaStatus ?? 'current', now, now);
  } finally {
    close();
  }
}

test('upload routes require an authenticated admin', async () => {
  const { app } = await authed();
  try {
    const anon = new Client(app.url);
    assert.equal((await anon.get('/api/uploads')).status, 401);
    assert.equal((await anon.get('/api/files')).status, 401);
    assert.equal((await anon.get('/api/dashboard/summary')).status, 401);
    const plan = await fetch(`${app.url}/api/uploads/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ originalName: 'a.bin', sizeBytes: 1 }),
    });
    assert.equal(plan.status, 401, 'the admin gate runs before anything else');
  } finally {
    await app.close();
  }
});

test('planning requires CSRF and an idempotency key', async () => {
  const { app, client } = await authed();
  try {
    const noCsrf = await fetch(`${app.url}/api/uploads/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: client.jar.header() },
      body: JSON.stringify({ originalName: 'a.bin', sizeBytes: MIB }),
    });
    assert.equal(noCsrf.status, 403, 'CSRF is enforced on the plan route');

    // an idempotency key is mandatory
    const res = await client.post('/api/uploads/plan', { originalName: 'a.bin', sizeBytes: MIB, chunkSizeMiB: 8 });
    assert.equal(res.status, 400);
    assert.equal((res.body as { code?: string }).code, 'invalid_upload_metadata');
  } finally {
    await app.close();
  }
});

test('planning without eligible capacity returns capacity_insufficient', async () => {
  const { app, client } = await authed();
  try {
    const res = await client.post(
      '/api/uploads/plan',
      { originalName: 'a.bin', sizeBytes: MIB, chunkSizeMiB: 8 },
      { 'idempotency-key': crypto.randomUUID() },
    );
    // no accounts are connected in this app, so the plan must be refused
    assert.equal(res.status, 409);
    assert.equal((res.body as { code?: string }).code, 'capacity_insufficient');
  } finally {
    await app.close();
  }
});

test('a valid plan returns geometry only (no provider details)', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const res = await client.post(
      '/api/uploads/plan',
      { originalName: 'video.mp4', sizeBytes: 10 * MIB, chunkSizeMiB: 8, mimeType: 'video/mp4' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    assert.equal(res.status, 201);
    const body = res.body as {
      jobId: string; chunkCount: number; allocations: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number; accountId?: string }>;
    };
    assert.equal(body.chunkCount, 2);
    assert.equal(body.allocations.length, 2);
    // the client gets its own chunk geometry but never the account/provider choice
    for (const a of body.allocations) {
      assert.equal(a.accountId, undefined, 'the allocated account id is never exposed');
      assert.ok(typeof a.offsetBytes === 'number');
      assert.ok(typeof a.sizeBytes === 'number');
    }
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('acc-a'), 'no internal account id leaks to the client');
  } finally {
    await app.close();
  }
});

test('the same idempotency key returns the same job over HTTP', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const key = crypto.randomUUID();
    const body = { originalName: 'a.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8 };
    const first = await client.post('/api/uploads/plan', { ...body, idempotencyKey: key }, { 'idempotency-key': key } as never);
    const second = await client.post('/api/uploads/plan', { ...body, idempotencyKey: key }, { 'idempotency-key': key } as never);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200, 'a repeat returns the existing job');
    assert.equal((second.body as { jobId: string }).jobId, (first.body as { jobId: string }).jobId);
    assert.equal((second.body as { reused: boolean }).reused, true);

    // same key, different metadata is rejected
    const conflicting = await client.post('/api/uploads/plan',
      { originalName: 'other.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, idempotencyKey: key },
      { 'idempotency-key': key } as never);
    assert.equal(conflicting.status, 409);
    assert.equal((conflicting.body as { code?: string }).code, 'idempotency_key_reused');
  } finally {
    await app.close();
  }
});

test('an empty file completes without needing capacity', async () => {
  const { app, client } = await authed();
  try {
    const key = crypto.randomUUID();
    const res = await client.post('/api/uploads/plan',
      { originalName: 'empty.txt', sizeBytes: 0, chunkSizeMiB: 8, idempotencyKey: key },
      { 'idempotency-key': key } as never);
    assert.equal(res.status, 201);
    assert.equal((res.body as { chunkCount: number }).chunkCount, 0);
  } finally {
    await app.close();
  }
});

test('the raw chunk route rejects an unknown job and an out-of-range index', async () => {
  const { app, client } = await authed();
  try {
    const token = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
    // unknown job
    const unknown = await fetch(`${app.url}/api/uploads/does-not-exist/chunks/0`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-csrf-token': token.csrfToken,
        cookie: client.jar.header(),
      },
      body: Buffer.alloc(16),
    });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code?: string }).code, 'job_not_found');

    // a negative index is refused before any work
    const badIndex = await fetch(`${app.url}/api/uploads/whatever/chunks/-1`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-csrf-token': token.csrfToken,
        cookie: client.jar.header(),
      },
      body: Buffer.alloc(4),
    });
    assert.equal(badIndex.status, 400);
  } finally {
    await app.close();
  }
});

test('the raw chunk route enforces CSRF without parsing a JSON body', async () => {
  const { app, client } = await authed();
  try {
    const res = await fetch(`${app.url}/api/uploads/any-job/chunks/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', cookie: client.jar.header() },
      body: Buffer.alloc(8),
    });
    // without a CSRF token the request is rejected; it is never treated as JSON
    assert.ok([403, 401].includes(res.status));
  } finally {
    await app.close();
  }
});

test('upload status APIs return no-store and never leak credentials', async () => {
  const { app, client } = await authed();
  try {
    const res = await client.get('/api/uploads');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const summary = await client.get('/api/dashboard/summary');
    assert.equal(summary.headers.get('cache-control'), 'no-store');
    const files = await client.get('/api/files');
    assert.equal(files.headers.get('cache-control'), 'no-store');
    const serialized = JSON.stringify([res.body, summary.body, files.body]);
    for (const forbidden of ['credential', 'accessToken', 'refreshToken', 'session-secret']) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must never appear`);
    }
  } finally {
    await app.close();
  }
});

test('a resume manifest for an unknown job is a safe 404', async () => {
  const { app, client } = await authed();
  try {
    const res = await client.get('/api/uploads/nope/resume-manifest');
    assert.equal(res.status, 404);
    assert.equal((res.body as { code?: string }).code, 'job_not_found');
  } finally {
    await app.close();
  }
});

test('pause and resume validate the job and report honest state', async () => {
  const { app, client } = await authed();
  try {
    assert.equal((await client.post('/api/uploads/nope/pause')).status, 404);
    seedAccount(app.dbPath, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const key = crypto.randomUUID();
    const plan = await client.post('/api/uploads/plan',
      { originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: key },
      { 'idempotency-key': key } as never);
    const jobId = (plan.body as { jobId: string }).jobId;
    const paused = await client.post(`/api/uploads/${jobId}/pause`);
    assert.equal(paused.status, 200);
    assert.equal((paused.body as { job: { state: string } }).job.state, 'paused');
    const resumed = await client.post(`/api/uploads/${jobId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body as { job: { state: string } }).job.state, 'running');
  } finally {
    await app.close();
  }
});

test('cancelling a job reports cleanup state honestly rather than claiming success', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, { id: 'acc-a', provider: 'google_drive', total: 100 * MIB, used: 0 });
    const key = crypto.randomUUID();
    const plan = await client.post('/api/uploads/plan',
      { originalName: 'a.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, idempotencyKey: key },
      { 'idempotency-key': key } as never);
    const jobId = (plan.body as { jobId: string }).jobId;
    const cancelled = await client.post(`/api/uploads/${jobId}/cancel`);
    assert.equal(cancelled.status, 200);
    const job = (cancelled.body as { job: { state: string } | null }).job;
    assert.ok(job);
    // either fully cancelled, or explicitly flagged as still cleaning up
    assert.ok(['cancelled', 'deletion_pending'].includes(job!.state));
  } finally {
    await app.close();
  }
});
