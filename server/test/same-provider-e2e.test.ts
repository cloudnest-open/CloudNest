import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, Client, type TestApp } from './helpers.js';
import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { installTestAdapter, clearTestAdapters } from '../src/providers/registry.js';
import { makeFakeAdapter, type FakeAdapterHandle } from './fake-adapter.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * Task §4.C + §4.D + §4.E (and the HTTP half of §4.A.8) — same-provider
 * multi-account behaviour through the REAL HTTP API: capacity routing, chunk
 * placement, download reconstruction, deletion cleanup, disconnect isolation
 * and concurrent OAuth callbacks. Everything runs on mocked adapters and an
 * isolated temp database; no live provider credentials are used.
 */

const MIB = 1024 * 1024;
const GOOD = 'correct horse battery staple';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function bundleFor(provider: 'google_drive' | 'dropbox' | 'mega', token: string): ProviderCredentialBundle {
  if (provider === 'mega') return { schemaVersion: 1, provider: 'mega', email: token, password: 'fake-test-only-password' };
  return { schemaVersion: 1, provider, accessToken: token, refreshToken: `refresh-${token}`, grantedScopes: [] };
}

function seedAccount(app: TestApp, opts: {
  id: string; provider: 'google_drive' | 'dropbox' | 'mega'; token: string;
  total: number; used: number; status?: string; quotaStatus?: string;
}): void {
  const { db, close } = openDatabase(app.dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
        quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(opts.id, opts.provider, `${opts.id}@example.com`, `ident-${opts.id}`, opts.status ?? 'connected', opts.total, opts.used, opts.quotaStatus ?? 'current', now, now);
    const store = new CredentialsStore(db, app.dataDir);
    store.saveAccountBundle(opts.id, opts.provider, bundleFor(opts.provider, opts.token));
  } finally {
    close();
  }
}

interface PlacementRow { chunk_index: number; provider_account_id: string; remote_object_id: string | null }

function activePlacements(app: TestApp, fileId: string): PlacementRow[] {
  const { db, close } = openDatabase(app.dbPath);
  try {
    return db.prepare(
      `SELECT c.chunk_index, p.provider_account_id, p.remote_object_id
       FROM chunk_placements p JOIN file_chunks c ON c.id = p.chunk_id
       WHERE c.file_id = ? AND p.is_active = 1 ORDER BY c.chunk_index`,
    ).all(fileId) as unknown as PlacementRow[];
  } finally {
    close();
  }
}

function reservedInflight(app: TestApp, accountId: string): number {
  const { db, close } = openDatabase(app.dbPath);
  try {
    return (db.prepare('SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?').get(accountId) as { reserved_inflight_bytes: number }).reserved_inflight_bytes;
  } finally {
    close();
  }
}

async function putChunk(app: TestApp, client: Client, jobId: string, index: number, body: Buffer): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const token = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
  const res = await fetch(`${app.url}/api/uploads/${jobId}/chunks/${index}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': token.csrfToken, cookie: client.jar.header() },
    body: new Uint8Array(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function downloadFile(baseUrl: string, client: Client, fileId: string): Promise<{ status: number; bytes: Buffer }> {
  const res = await fetch(`${baseUrl}/api/files/${fileId}/download`, { headers: { cookie: client.jar.header() } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

async function withFake<T>(provider: 'google_drive' | 'dropbox', options: Parameters<typeof makeFakeAdapter>[1] | undefined, run: (fake: FakeAdapterHandle) => Promise<T> | T): Promise<T> {
  const fake = makeFakeAdapter(provider, options);
  installTestAdapter(provider, fake.adapter);
  try {
    return await run(fake);
  } finally {
    clearTestAdapters();
  }
}

test('D-main: a file spans two same-provider accounts end to end — plan, upload, download, delete', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', undefined, async (fake) => {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-A', total: 16 * MIB, used: 0 });
      seedAccount(app, { id: 'acc-b', provider: 'google_drive', token: 'tok-B', total: 16 * MIB, used: 0 });

      // 24 MiB in 8 MiB chunks → 3 chunks; capacity-aware routing must use BOTH accounts
      const plan = await client.post('/api/uploads/plan',
        { originalName: 'span.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: 'application/octet-stream', idempotencyKey: 'key-span-1' },
        { 'idempotency-key': 'key-span-1' } as never);
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const planBody = plan.body as { jobId: string; fileId: string; chunkCount: number };
      assert.equal(planBody.chunkCount, 3);
      // The API deliberately hides provider details from the client (no account
      // ids in the plan response), so the same-provider split is proven by the
      // per-account durable reservations: 16 + 8 = 24 MiB, never double-counted.
      assert.equal(reservedInflight(app, 'acc-a'), 16 * MIB, 'first account reserved its whole share');
      assert.equal(reservedInflight(app, 'acc-b'), 8 * MIB, 'second account reserved exactly the spill-over');

      // upload each chunk exactly as planned
      const chunks = [0, 1, 2].map(() => crypto.randomBytes(8 * MIB));
      for (let i = 0; i < 3; i++) {
        const put = await putChunk(app, client, planBody.jobId, i, chunks[i]!);
        assert.equal(put.status, 200, JSON.stringify(put.json));
        assert.equal((put.json as { ok?: boolean }).ok, true);
      }
      const job = await client.get(`/api/uploads/${planBody.jobId}`);
      assert.equal((job.body as { job?: { state?: string } }).job?.state, 'completed', JSON.stringify(job.body));

      // D.1/D.2: every chunk is assigned to the planned account; the client
      // never had (and never needed) a way to override the allocation
      const placements = activePlacements(app, planBody.fileId);
      assert.deepEqual(placements.map((p) => p.provider_account_id), ['acc-a', 'acc-a', 'acc-b']);
      assert.ok(placements.every((p) => typeof p.remote_object_id === 'string' && p.remote_object_id.length > 0));

      // D.3: the fake stores objects per credential identity — prove each
      // upload landed under its OWN account's namespace
      assert.deepEqual(fake.log.uploads.map((u) => u.accountKey).sort(), ['tok-A', 'tok-A', 'tok-B']);

      // D.4/D.5: download reconstructs the logical file and verifies checksums
      const dl = await downloadFile(app.url, client, planBody.fileId);
      assert.equal(dl.status, 200, `download failed: ${dl.bytes.toString('utf8').slice(0, 200)}`);
      assert.ok(Buffer.concat(chunks).equals(dl.bytes), 'reconstructed bytes are identical');
      assert.deepEqual(fake.log.downloads.map((d) => d.accountKey).sort(), ['tok-A', 'tok-A', 'tok-B'], 'each chunk was fetched with its own account credentials');

      // D.7: deleting the logical file cleans up objects across BOTH accounts.
      // Phase 4: DELETE trashes; the purge is what starts the real cleanup.
      const del = await client.send('DELETE', `/api/files/${planBody.fileId}`);
      assert.equal(del.status, 200);
      const purge = await client.post(`/api/files/${planBody.fileId}/purge`);
      assert.equal(purge.status, 202);
      const delJobId = (purge.body as { jobId: string }).jobId;
      const retry = await client.post(`/api/deletions/${delJobId}/retry`);
      assert.equal(retry.status, 200);
      const result = (retry.body as { result?: { state?: string; deleted?: number; failed?: number } }).result;
      assert.equal(result?.state, 'completed', JSON.stringify(retry.body));
      assert.equal(result?.deleted, 3);
      assert.equal(result?.failed, 0);
      assert.deepEqual(fake.log.deleteAttempts.map((d) => d.accountKey).sort(), ['tok-A', 'tok-A', 'tok-B'], 'cleanup used each object’s originating account');
    });
  } finally {
    await app.close();
  }
});

test('D-restart: placements survive a process restart and still resolve per account', async () => {
  const app = await startTestApp();
  try {
    const client = new Client(app.url);
    await client.setup(GOOD);
    await withFake('google_drive', undefined, async (fake) => {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-A', total: 8 * MIB, used: 0 });
      seedAccount(app, { id: 'acc-b', provider: 'google_drive', token: 'tok-B', total: 8 * MIB, used: 0 });
      const plan = await client.post('/api/uploads/plan',
        { originalName: 'restart.bin', sizeBytes: 16 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-restart-1' },
        { 'idempotency-key': 'key-restart-1' } as never);
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const planBody = plan.body as { jobId: string; fileId: string };
      const parts = [crypto.randomBytes(8 * MIB), crypto.randomBytes(8 * MIB)];
      for (let i = 0; i < 2; i++) {
        const put = await putChunk(app, client, planBody.jobId, i, parts[i]!);
        assert.equal(put.status, 200);
      }

      // simulate a process restart: a second app instance over the SAME
      // database and data dir (the first one stays open but idle)
      const { db, close } = openDatabase(app.dbPath);
      const app2 = createApp({
        appVersion: 'test',
        db,
        sessionCredential: crypto.randomBytes(32).toString('base64url'),
        dataDir: app.dataDir,
        appBaseUrl: 'http://127.0.0.1:8787',
        dbPath: app.dbPath,
        port: 0,
        webDistDir: app.dataDir,
      });
      const server2 = app2.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server2.once('listening', resolve));
      try {
        const client2 = new Client(`http://127.0.0.1:${(server2.address() as { port: number }).port}`);
        await client2.login(GOOD);
        const dl = await downloadFile(baseUrlOf(client2), client2, planBody.fileId);
        assert.equal(dl.status, 200);
        assert.ok(Buffer.concat(parts).equals(dl.bytes), 'recovered mappings reconstruct the file after restart');
        assert.deepEqual(fake.log.downloads.map((d) => d.accountKey).sort(), ['tok-A', 'tok-B'], 'post-restart reads still use each account’s own credentials');
      } finally {
        await new Promise<void>((resolve) => server2.close(() => resolve()));
        close();
      }
    });
  } finally {
    await app.close();
  }
});

test('D.8: disconnecting one account never serves its chunks from the sibling account', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', undefined, async (fake) => {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-A', total: 16 * MIB, used: 0 });
      seedAccount(app, { id: 'acc-b', provider: 'google_drive', token: 'tok-B', total: 16 * MIB, used: 0 });
      const plan = await client.post('/api/uploads/plan',
        { originalName: 'iso.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-iso-1' },
        { 'idempotency-key': 'key-iso-1' } as never);
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const planBody = plan.body as { jobId: string; fileId: string };
      const chunks = [0, 1, 2].map(() => crypto.randomBytes(8 * MIB));
      for (let i = 0; i < 3; i++) {
        const put = await putChunk(app, client, planBody.jobId, i, chunks[i]!);
        assert.equal(put.status, 200, `chunk ${i}: ${JSON.stringify(put.json)}`);
      }
      const job = await client.get(`/api/uploads/${planBody.jobId}`);
      assert.equal((job.body as { job?: { state?: string } }).job?.state, 'completed', 'the file must be complete before the disconnect is tested');
      const full = Buffer.concat(chunks);
      const downloadsBeforeFailedRead = fake.log.downloads.length;

      // disconnect acc-a through the real API
      const disc = await client.post('/api/provider-accounts/acc-a/disconnect');
      assert.equal(disc.status, 200);

      // the download must FAIL, not silently fall back to acc-b's namespace
      const dl = await downloadFile(app.url, client, planBody.fileId);
      assert.notEqual(dl.status, 200, 'a file with a disconnected placement account must not download');
      assert.ok(!full.equals(dl.bytes), 'sibling bytes were never served');

      // D.8 precise invariant: after the disconnect, the only successful remote
      // reads belong to acc-b's OWN objects — acc-a's object keys were never
      // fetched under acc-b's (or any other) credentials
      const accAKeys = new Set(fake.log.uploads.filter((u) => u.accountKey === 'tok-A').map((u) => u.objectKey));
      const accBKeys = new Set(fake.log.uploads.filter((u) => u.accountKey === 'tok-B').map((u) => u.objectKey));
      const postDisc = fake.log.downloads.slice(downloadsBeforeFailedRead);
      assert.ok(postDisc.every((d) => d.accountKey === 'tok-B' && accBKeys.has(d.remoteObjectId)), 'only acc-b read its own objects');
      assert.ok(postDisc.every((d) => !accAKeys.has(d.remoteObjectId)), 'acc-a objects were never served cross-account');
      assert.ok(postDisc.every((d) => d.accountKey !== 'tok-A'), 'the disconnected account performed no fetches');

      // the sibling account is still fully usable
      const accounts = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; status: string }> };
      assert.equal(accounts.accounts.find((a) => a.id === 'acc-b')?.status, 'connected');
    });
  } finally {
    await app.close();
  }
});

test('A8: concurrent OAuth callbacks for two identities create two accounts, never a merge', async () => {
  const { app, client } = await authed();
  const realFetch = globalThis.fetch;
  try {
    await withFake('google_drive', { connectDelayMs: 40 }, async (fake) => {
      // configure the provider app (required by the OAuth flow)
      const cfg = await client.put('/api/providers/google_drive/config', { clientId: 'cid-test', clientSecret: 'secret-test' });
      assert.equal(cfg.status, 200, JSON.stringify(cfg.body));

      // intercept ONLY the token exchange: code → deterministic token pair
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'https://oauth2.googleapis.com/token' && init?.method === 'POST') {
          const code = new URLSearchParams(String(init.body ?? '')).get('code') ?? '';
          return new Response(JSON.stringify({ access_token: code, refresh_token: `refresh-${code}`, expires_in: 3600, scope: 'drive.file' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return realFetch(input, init);
      }) as typeof fetch;

      // start two authorization flows on the same admin session
      const starts = await Promise.all([
        client.post('/api/providers/google_drive/oauth/start'),
        client.post('/api/providers/google_drive/oauth/start'),
      ]);
      const states = starts.map((s) => {
        assert.equal(s.status, 200, JSON.stringify(s.body));
        return new URL((s.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')!;
      });
      assert.notEqual(states[0], states[1]);

      // both provider callbacks arrive concurrently with distinct identities
      const codes = ['tok-A', 'tok-B'];
      const callbacks = await Promise.all(states.map((state, i) =>
        fetch(`${app.url}/api/providers/google_drive/oauth/callback?state=${encodeURIComponent(state!)}&code=${encodeURIComponent(codes[i]!)}`, {
          headers: { cookie: client.jar.header() }, redirect: 'manual',
        })));
      for (const cb of callbacks) {
        assert.equal(cb.status, 303);
        assert.ok((cb.headers.get('location') ?? '').includes('connect=connected'), cb.headers.get('location') ?? '');
      }
      assert.deepEqual(fake.log.connects.sort(), ['tok-A', 'tok-B'], 'both identities connected');

      const list = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; accountIdentifier: string; provider: string }> };
      const drives = list.accounts.filter((a) => a.provider === 'google_drive');
      assert.equal(drives.length, 2, 'two distinct rows — no identity merge');
      assert.deepEqual(new Set(drives.map((a) => a.accountIdentifier)), new Set(['ident-tok-A', 'ident-tok-B']));
    });
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('E: the accounts API exposes and mutates same-provider accounts independently', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', { failQuotaFor: ['tok-B'] }, async (fake) => {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-A', total: 100, used: 10 });
      seedAccount(app, { id: 'acc-b', provider: 'google_drive', token: 'tok-B', total: 200, used: 20 });

      const list1 = (await client.get('/api/provider-accounts')).body as { accounts: Array<Record<string, unknown>> };
      assert.equal(list1.accounts.length, 2);
      const [a1, b1] = list1.accounts;
      assert.equal(a1!['id'], 'acc-a');
      assert.equal(b1!['id'], 'acc-b');
      assert.equal((a1!['quota'] as { totalBytes: number }).totalBytes, 100);
      assert.equal((b1!['quota'] as { totalBytes: number }).totalBytes, 200);

      // rename A → B unchanged
      const patch = await client.patch('/api/provider-accounts/acc-a', { displayLabel: 'Renamed via API' });
      assert.equal(patch.status, 200);
      const list2 = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; displayLabel: string }> };
      assert.equal(list2.accounts.find((x) => x.id === 'acc-a')!.displayLabel, 'Renamed via API');
      assert.equal(list2.accounts.find((x) => x.id === 'acc-b')!.displayLabel, 'acc-b@example.com');

      // quota refresh isolation: A refreshes fine, B fails — results are per account
      const refreshAll = await client.post('/api/provider-accounts/refresh-quotas');
      assert.equal(refreshAll.status, 200);
      const results = (refreshAll.body as { results: Array<{ id: string; ok: boolean }> }).results;
      assert.equal(results.find((r) => r.id === 'acc-a')!.ok, true);
      assert.equal(results.find((r) => r.id === 'acc-b')!.ok, false, 'B’s quota failure is B’s alone');
      const list3 = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; quota: { status: string } }> };
      assert.equal(list3.accounts.find((x) => x.id === 'acc-a')!.quota.status, 'current');
      assert.notEqual(list3.accounts.find((x) => x.id === 'acc-b')!.quota.status, 'current');
      assert.equal(fake.log.quotaReads.length, 2, 'both accounts attempted exactly once');
    });
  } finally {
    await app.close();
  }
});

test('C: capacity routing excludes unhealthy accounts and fails clearly when nothing fits', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', undefined, async () => {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-A', total: 16 * MIB, used: 0, status: 'disconnected' });
      seedAccount(app, { id: 'acc-b', provider: 'google_drive', token: 'tok-B', total: 16 * MIB, used: 0 });

      // 24 MiB cannot fit in the ONE healthy account → clear 409
      const tooBig = await client.post('/api/uploads/plan',
        { originalName: 'big.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-c-1' },
        { 'idempotency-key': 'key-c-1' } as never);
      assert.equal(tooBig.status, 409);
      assert.equal((tooBig.body as { code?: string }).code, 'capacity_insufficient');

      // a smaller file fits and lands entirely on the healthy account
      const fits = await client.post('/api/uploads/plan',
        { originalName: 'fit.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-c-2' },
        { 'idempotency-key': 'key-c-2' } as never);
      assert.equal(fits.status, 201, JSON.stringify(fits.body));
      // the plan response hides account ids by design — read the reservation split
      assert.equal(reservedInflight(app, 'acc-b'), 8 * MIB, 'the healthy account received the whole reservation');
      assert.equal(reservedInflight(app, 'acc-a'), 0, 'the disconnected account was never a placement target');
    });
  } finally {
    await app.close();
  }
});

test('C: MEGA stays excluded from upload routing by its own capability gate', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', undefined, async () => {
      seedAccount(app, { id: 'acc-mega', provider: 'mega', token: 'mega@example.com', total: 10 * 1024 * MIB, used: 0 });
      seedAccount(app, { id: 'acc-g', provider: 'google_drive', token: 'tok-G', total: 16 * MIB, used: 0 });
      // 24 MiB > google-only capacity even though MEGA reports 10 GiB
      const plan = await client.post('/api/uploads/plan',
        { originalName: 'mega.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-mega-1' },
        { 'idempotency-key': 'key-mega-1' } as never);
      assert.equal(plan.status, 409, 'MEGA must not be counted as upload capacity');
      assert.equal((plan.body as { code?: string }).code, 'capacity_insufficient');
    });
  } finally {
    await app.close();
  }
});

test('C: parallel plans cannot overbook the same account’s capacity', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', undefined, async () => {
      seedAccount(app, { id: 'acc-solo', provider: 'google_drive', token: 'tok-S', total: 10 * MIB, used: 0 });
      // two concurrent 8 MiB plans against one 10 MiB account: exactly one wins
      const attempts = await Promise.all([
        client.post('/api/uploads/plan', { originalName: 'p1.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-p1' }, { 'idempotency-key': 'key-p1' } as never),
        client.post('/api/uploads/plan', { originalName: 'p2.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-p2' }, { 'idempotency-key': 'key-p2' } as never),
      ]);
      assert.deepEqual(attempts.map((a) => a.status).sort(), [201, 409], 'one plan succeeds, the other fails clearly — never double-booked');
      assert.equal(reservedInflight(app, 'acc-solo'), 8 * MIB, 'reservation equals exactly the winning plan');
    });
  } finally {
    await app.close();
  }
});

// Client stores its base URL privately; a typed peek keeps the restart test honest
// without changing the helper's public surface.
function baseUrlOf(client: Client): string {
  return (client as unknown as { baseUrl: string }).baseUrl;
}
void baseUrlOf;

test('§5 UX: tracked-usage disconnect warning + file availability reflect the right account', async () => {
  const { app, client } = await authed();
  try {
    await withFake('google_drive', undefined, async () => {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-A', total: 16 * MIB, used: 0 });
      seedAccount(app, { id: 'acc-b', provider: 'google_drive', token: 'tok-B', total: 16 * MIB, used: 0 });
      // an account with no files: its tracked usage must honestly be zero
      seedAccount(app, { id: 'acc-c', provider: 'google_drive', token: 'tok-C', total: 16 * MIB, used: 0 });

      const plan = await client.post('/api/uploads/plan',
        { originalName: 'warn.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-ux-1' },
        { 'idempotency-key': 'key-ux-1' } as never);
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const planBody = plan.body as { jobId: string; fileId: string };
      for (let i = 0; i < 3; i++) {
        const put = await putChunk(app, client, planBody.jobId, i, crypto.randomBytes(8 * MIB));
        assert.equal(put.status, 200, JSON.stringify(put.json));
      }

      // §5.A: the accounts API reports the real per-account tracked usage
      const list = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; usage: { trackedFiles: number; trackedChunks: number } }> };
      const a = list.accounts.find((x) => x.id === 'acc-a')!;
      const b = list.accounts.find((x) => x.id === 'acc-b')!;
      const c = list.accounts.find((x) => x.id === 'acc-c')!;
      assert.deepEqual(a.usage, { trackedFiles: 1, trackedChunks: 2 }, 'acc-a holds two chunks of the one file');
      assert.deepEqual(b.usage, { trackedFiles: 1, trackedChunks: 1 }, 'acc-b holds one chunk of the same file');
      assert.deepEqual(c.usage, { trackedFiles: 0, trackedChunks: 0 }, 'an unused account holds nothing');

      // §5.B: files list marks the file unavailable once acc-a goes offline
      const disc = await client.post('/api/provider-accounts/acc-a/disconnect');
      assert.equal(disc.status, 200);
      const files = (await client.get('/api/files')).body as { files: Array<{ id: string; storageHealth: { status: string; unavailable: Array<{ label: string; accountStatus: string }> } }> };
      const file = files.files.find((f) => f.id === planBody.fileId)!;
      assert.equal(file.storageHealth.status, 'account_unavailable');
      assert.deepEqual(file.storageHealth.unavailable.map((u) => u.label), ['acc-a@example.com']);
      assert.equal(file.storageHealth.unavailable[0]!.accountStatus, 'disconnected');

      // details route carries the same derived health
      const detail = (await client.get(`/api/files/${planBody.fileId}`)).body as { file: { storageHealth: { status: string } } };
      assert.equal(detail.file.storageHealth.status, 'account_unavailable');

      // the health is derived, never stored: restoring the account returns the
      // file to fully usable without touching the file row
      {
        const { openDatabase: open } = await import('../src/db/index.js');
        const { db, close } = open(app.dbPath);
        try {
          const store = new CredentialsStore(db, app.dataDir);
          db.prepare("UPDATE provider_accounts SET status = 'connected' WHERE id = ?").run('acc-a');
          store.saveAccountBundle('acc-a', 'google_drive', bundleFor('google_drive', 'tok-A'));
        } finally {
          close();
        }
      }
      const filesAfter = (await client.get('/api/files')).body as { files: Array<{ id: string; storageHealth: { status: string } }> };
      assert.equal(filesAfter.files.find((f) => f.id === planBody.fileId)!.storageHealth.status, 'ok', 'reconnecting the account restores availability');
    });
  } finally {
    await app.close();
  }
});
