import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, Client, type TestApp } from './helpers.js';
import { installTestAdapter, clearTestAdapters } from '../src/providers/registry.js';
import { makeFakeAdapter } from './fake-adapter.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * M0016 — per-account upload participation: an owner can mark a connected
 * account out of the upload/mirror/reassign pool without disconnecting it.
 * Out = no NEW placements; existing chunks stay readable and downloads are
 * unaffected. All storage runs on mocked adapters and a temp database; no
 * live provider is touched.
 */

const MIB = 1024 * 1024;
const GOOD = 'correct horse battery staple';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function bundleFor(provider: 'google_drive' | 'dropbox', token: string): ProviderCredentialBundle {
  return { schemaVersion: 1, provider, accessToken: token, refreshToken: `refresh-${token}`, grantedScopes: [] };
}

function seedAccount(app: TestApp, opts: { id: string; provider: 'google_drive' | 'dropbox'; token: string; total?: number; participates?: number }): void {
  const now = new Date().toISOString();
  app.db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, participates_in_uploads, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'current', 0, 0, ?, ?, ?)`,
  ).run(opts.id, opts.provider, `${opts.id} label`, `ident-${opts.id}`, 'connected', opts.total ?? 100 * MIB, opts.participates ?? 1, now, now);
  new CredentialsStore(app.db, app.dataDir).saveAccountBundle(opts.id, opts.provider, bundleFor(opts.provider, opts.token));
}

async function putChunk(app: TestApp, client: Client, jobId: string, index: number, body: Buffer): Promise<number> {
  const token = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
  const res = await fetch(`${app.url}/api/uploads/${jobId}/chunks/${index}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': token.csrfToken, cookie: client.jar.header() },
    body: new Uint8Array(body),
  });
  return res.status;
}

async function withFakes<T>(run: () => Promise<T>): Promise<T> {
  installTestAdapter('google_drive', makeFakeAdapter('google_drive').adapter);
  installTestAdapter('dropbox', makeFakeAdapter('dropbox').adapter);
  try {
    return await run();
  } finally {
    clearTestAdapters();
  }
}

test('M0016 defaults every account to participating and the API reports it', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      const list = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; participatesInUploads: boolean }> };
      assert.equal(list.accounts.find((a) => a.id === 'acc-a')!.participatesInUploads, true, 'the default is participating');
    } finally {
      await app.close();
    }
  });
});

test('marking an account out removes it from plan capacity and the PATCH endpoint reports it', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a', total: 100 * MIB });
      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b', total: 100 * MIB });

      const out = await client.patch('/api/provider-accounts/acc-a', { participatesInUploads: false });
      assert.equal(out.status, 200);
      assert.equal((out.body as { account: { participatesInUploads: boolean } }).account.participatesInUploads, false);

      // plan again: every placement must land on the participating account —
      // verified through the durable allocation rows
      const plan = await client.post(
        '/api/uploads/plan',
        { originalName: 'spread.bin', sizeBytes: 30 * MIB, chunkSizeMiB: 8, mimeType: null },
        { 'idempotency-key': crypto.randomUUID() },
      );
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const allocations = app.db.prepare(
        'SELECT DISTINCT provider_account_id FROM upload_chunk_allocations WHERE job_id = ?',
      ).all((plan.body as { jobId: string }).jobId) as Array<{ provider_account_id: string }>;
      assert.deepEqual(allocations.map((r) => r.provider_account_id), ['acc-b'], 'only the participating account received placements');

      // marking back in restores capacity
      const backIn = await client.patch('/api/provider-accounts/acc-a', { participatesInUploads: true });
      assert.equal((backIn.body as { account: { participatesInUploads: boolean } }).account.participatesInUploads, true);
    } finally {
      await app.close();
    }
  });
});

test('a plan is refused when no account participates, even with room left', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a', total: 100 * MIB, participates: 0 });
      const plan = await client.post(
        '/api/uploads/plan',
        { originalName: 'small.bin', sizeBytes: 4 * MIB, chunkSizeMiB: 8, mimeType: null },
        { 'idempotency-key': crypto.randomUUID() },
      );
      assert.equal(plan.status, 409, JSON.stringify(plan.body));
      assert.equal((plan.body as { code: string }).code, 'capacity_insufficient');
    } finally {
      await app.close();
    }
  });
});

test('existing chunks stay readable: marking out never blocks downloads', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a', total: 100 * MIB });
      const payload = crypto.randomBytes(2 * MIB);
      const plan = await client.post(
        '/api/uploads/plan',
        { originalName: 'keep.bin', sizeBytes: payload.length, chunkSizeMiB: 8, mimeType: null },
        { 'idempotency-key': crypto.randomUUID() },
      );
      const { jobId, fileId } = plan.body as { jobId: string; fileId: string };
      assert.equal(await putChunk(app, client, jobId, 0, payload), 200);

      // NOW mark the account out — the already-placed chunk is untouched
      const out = await client.patch('/api/provider-accounts/acc-a', { participatesInUploads: false });
      assert.equal(out.status, 200);

      const detail = await client.get(`/api/files/${fileId}`);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      const download = await client.get(`/api/files/${fileId}/download`);
      assert.equal(download.status, 200, 'existing placements remain downloadable');
    } finally {
      await app.close();
    }
  });
});
