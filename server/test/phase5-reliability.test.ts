import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, Client, type TestApp } from './helpers.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { installTestAdapter, clearTestAdapters } from '../src/providers/registry.js';
import { makeFakeAdapter, fakeAccountKey, type FakeAdapterHandle } from './fake-adapter.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { makeProviderQueries } from '../src/db/provider-queries.js';
import { ProviderAccountService } from '../src/services/provider-account-service.js';
import { ProviderMetrics } from '../src/metrics/provider-metrics.js';
import { createBackgroundScheduler } from '../src/scheduler/background-scheduler.js';
import { UploadService } from '../src/uploads/upload-service.js';
import { DeletionService } from '../src/deletions/deletion-service.js';
import { ShareService } from '../src/shares/share-service.js';
import { ProviderError, type DecryptedProviderAppConfig, type ProviderCredentialBundle, type UploadObjectStreamParams } from '../src/providers/types.js';

/**
 * Roadmap Phase 5 — reliability: optional chunk mirror (M0015, MirrorService,
 * download mirror-fallback), the background scheduler (quota refresh, cleanup
 * retry, orphan reconcile) and per-provider metrics + the health badge. All
 * storage runs on mocked adapters and temp databases; no live provider is
 * touched.
 */

const MIB = 1024 * 1024;
const GOOD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member test passphrase 8';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function bundleFor(provider: 'google_drive' | 'dropbox', token: string): ProviderCredentialBundle {
  return { schemaVersion: 1, provider, accessToken: token, refreshToken: `refresh-${token}`, grantedScopes: [] };
}

interface SeedAccountOpts {
  id: string;
  provider: 'google_drive' | 'dropbox';
  token: string;
  total?: number;
  status?: string;
}

function seedAccount(app: TestApp, opts: SeedAccountOpts): void {
  const now = new Date().toISOString();
  app.db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'current', 0, 0, ?, ?)`,
  ).run(opts.id, opts.provider, `${opts.id} label`, `ident-${opts.id}`, opts.status ?? 'connected', opts.total ?? 10 * 1024 * 1024 * 1024, now, now);
  const store = new CredentialsStore(app.db, app.dataDir);
  store.saveAccountBundle(opts.id, opts.provider, bundleFor(opts.provider, opts.token));
}

async function withFakes<T>(run: (fakes: { drive: FakeAdapterHandle; dropbox: FakeAdapterHandle }) => Promise<T> | T): Promise<T> {
  const drive = makeFakeAdapter('google_drive');
  const dropbox = makeFakeAdapter('dropbox');
  installTestAdapter('google_drive', drive.adapter);
  installTestAdapter('dropbox', dropbox.adapter);
  try {
    return await run({ drive, dropbox });
  } finally {
    clearTestAdapters();
  }
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

/** Upload a real file through the HTTP engine (plan → chunk PUTs → completed). */
async function uploadFile(
  app: TestApp,
  client: Client,
  opts: { name: string; sizeBytes: number; chunkMiB?: number; content?: Buffer },
): Promise<{ jobId: string; fileId: string; chunkCount: number }> {
  const chunkMiB = opts.chunkMiB ?? 8;
  const plan = await client.post('/api/uploads/plan', {
    originalName: opts.name,
    sizeBytes: opts.sizeBytes,
    chunkSizeMiB: chunkMiB,
    idempotencyKey: `p5-${crypto.randomUUID()}`,
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const { jobId, fileId, chunkCount } = plan.body as { jobId: string; fileId: string; chunkCount: number };
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkMiB * MIB;
    const len = Math.min(chunkMiB * MIB, opts.sizeBytes - start);
    const body = opts.content
      ? opts.content.subarray(start, start + len)
      : crypto.randomBytes(len);
    const status = await putChunk(app, client, jobId, i, body);
    assert.equal(status, 200, `chunk ${i} PUT failed with ${status}`);
  }
  return { jobId, fileId, chunkCount };
}

interface MirrorView {
  job: { jobId: string; state: string; chunksCompleted: number; chunksTotal: number; safeErrorCode: string | null } | null;
  chunkCount: number;
  mirroredChunks: number;
}

async function mirrorView(client: Client, fileId: string): Promise<MirrorView> {
  const res = await client.get(`/api/files/${fileId}/mirror`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as MirrorView;
}

async function waitForMirrorState(client: Client, fileId: string, states: string[], timeoutMs = 15000): Promise<MirrorView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await mirrorView(client, fileId);
    if (view.job && states.includes(view.job.state)) return view;
    if (Date.now() > deadline) {
      assert.fail(`mirror did not reach ${states.join('/')} in time (last: ${JSON.stringify(view)})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startMirror(client: Client, fileId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await client.post(`/api/files/${fileId}/mirror`, {});
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function rawDownload(app: TestApp, client: Client, fileId: string): Promise<{ status: number; bytes: Buffer }> {
  const res = await fetch(`${app.url}/api/files/${fileId}/download`, { headers: { cookie: client.jar.header() } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

// ---- M0015 migration ----

test('M0015 widens job_type with mirror, allows a second active placement on another account, and keeps legacy rows', () => {
  const { db, close } = openDatabase(`/tmp/cn-p15-${crypto.randomUUID()}.db`);
  try {
    runMigrations(db, allMigrations.filter((m) => m.version <= 14));
    const now = new Date().toISOString();
    for (const id of ['acc-a', 'acc-b']) {
      db.prepare(
        `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
          quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'connected', 100, 0, 'current', 0, 0, ?, ?)`,
      ).run(id, id === 'acc-a' ? 'google_drive' : 'dropbox', id, `ident-${id}`, now, now);
    }
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
       VALUES ('f-legacy', 'usr_admin', 'legacy.bin', 12, 8388608, 1, 'completed', 'personal', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
       VALUES ('ch-legacy', 'f-legacy', 0, 0, 12, 'aa', 'uploaded', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, created_at, updated_at)
       VALUES ('pl-legacy', 'ch-legacy', 'acc-a', 'obj-legacy', 'uploaded', 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_total, created_at, updated_at)
       VALUES ('job-legacy', 'f-legacy', 'upload', 'completed', 1, ?, ?)`,
    ).run(now, now);

    runMigrations(db, allMigrations);

    // legacy rows survive the transfer_jobs rebuild untouched
    const legacy = db.prepare("SELECT job_type, state, chunks_total FROM transfer_jobs WHERE id = 'job-legacy'").get() as
      | { job_type: string; state: string; chunks_total: number };
    assert.equal(legacy.job_type, 'upload');
    assert.equal(legacy.state, 'completed');
    assert.equal(legacy.chunks_total, 1);
    // the legacy active placement survives with primary semantics
    const legacyPlacement = db.prepare("SELECT placement_role, is_active FROM chunk_placements WHERE id = 'pl-legacy'").get() as
      | { placement_role: string | null; is_active: number };
    assert.equal(legacyPlacement.is_active, 1);
    assert.equal(legacyPlacement.placement_role, null, 'pre-mirror rows stay NULL, which means primary');

    // a mirror job is now a legal job_type
    db.prepare(
      `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_total, created_at, updated_at)
       VALUES ('job-m', 'f-legacy', 'mirror', 'queued', 1, ?, ?)`,
    ).run(now, now);

    // a second ACTIVE placement on a DIFFERENT account is legal (the mirror copy)
    db.prepare(
      `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, placement_role, created_at, updated_at)
       VALUES ('pl-m', 'ch-legacy', 'acc-b', 'obj-m', 'uploaded', 1, 'mirror', ?, ?)`,
    ).run(now, now);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, placement_role, created_at, updated_at)
         VALUES ('pl-dup', 'ch-legacy', 'acc-a', 'obj-dup', 'uploaded', 1, 'mirror', ?, ?)`,
      ).run(now, now);
    }, /UNIQUE/, 'the same account may not hold two active copies of one chunk');
    assert.throws(() => {
      db.prepare(
        `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, placement_role, created_at, updated_at)
         VALUES ('pl-bad', 'ch-legacy', 'acc-b', 'obj-bad', 'uploaded', 1, 'bogus', ?, ?)`,
      ).run(now, now);
    }, /CHECK/, 'placement_role stays a closed set');

    // metrics buckets upsert cleanly
    const metrics = new ProviderMetrics(db);
    metrics.recordCall('google_drive', true, null);
    metrics.recordCall('google_drive', false, 'provider_unavailable');
    metrics.recordBytes('google_drive', 'up', 12);
    const row = db.prepare("SELECT requests_total, requests_failed, bytes_uploaded FROM provider_metrics WHERE provider = 'google_drive'").get() as
      | { requests_total: number; requests_failed: number; bytes_uploaded: number };
    assert.equal(row.requests_total, 2);
    assert.equal(row.requests_failed, 1);
    assert.equal(row.bytes_uploaded, 12);
  } finally {
    close();
  }
});

// ---- mirror e2e over the real HTTP API ----

test('a completed file mirrors every chunk to a second same-tier account, honestly labelled', async () => {
  await withFakes(async ({ drive, dropbox }) => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });
      const payload = Buffer.from('mirror me, please');
      const { fileId } = await uploadFile(app, client, { name: 'mirror.bin', sizeBytes: payload.length, content: payload });

      const started = await startMirror(client, fileId);
      assert.equal(started.status, 202, JSON.stringify(started.body));

      const view = await waitForMirrorState(client, fileId, ['completed']);
      assert.equal(view.mirroredChunks, 1);
      assert.equal(view.chunkCount, 1);

      // both copies are live, roles and honesty intact
      const placements = app.db.prepare(
        `SELECT p.provider_account_id, p.state, p.placement_role, p.remote_object_id FROM chunk_placements p
         JOIN file_chunks c ON c.id = p.chunk_id WHERE c.file_id = ? AND p.is_active = 1`,
      ).all(fileId) as Array<{ provider_account_id: string; state: string; placement_role: string | null; remote_object_id: string | null }>;
      assert.equal(placements.length, 2, JSON.stringify(placements));
      const primary = placements.find((p) => p.provider_account_id === 'acc-a');
      const mirror = placements.find((p) => p.provider_account_id === 'acc-b');
      assert.ok(primary && mirror);
      assert.equal(primary.placement_role ?? 'primary', 'primary');
      // the fake adapter returns no comparable checksum: 'uploaded', never 'verified'
      assert.equal(mirror.state, 'uploaded');
      assert.equal(mirror.placement_role, 'mirror');

      // the mirror copy holds the exact same bytes the primary holds
      const primaryStored = drive.store.get(`tok-a/${primary.remote_object_id}`);
      const stored = dropbox.store.get(`tok-b/${mirror.remote_object_id}`);
      assert.ok(primaryStored && stored, 'both copies exist on their accounts');
      assert.ok(stored!.bytes.equals(primaryStored!.bytes), 'the mirrored bytes are identical to the primary copy');

      // the mirror reservation follows the §6.1 rule: held until a CURRENT
      // quota observation proves the provider accounted for the bytes
      const allocation = app.db.prepare(
        `SELECT a.state FROM upload_chunk_allocations a JOIN transfer_jobs j ON j.id = a.job_id
         WHERE j.job_type = 'mirror' AND j.file_id = ?`,
      ).get(fileId) as { state: string };
      assert.equal(allocation.state, 'uploaded_pending_quota');

      // the upload itself was recorded in the metrics
      const up = app.db.prepare(
        "SELECT requests_total, bytes_uploaded FROM provider_metrics WHERE provider = 'google_drive'",
      ).get() as { requests_total: number; bytes_uploaded: number };
      assert.ok(up.requests_total >= 1);
      assert.ok(up.bytes_uploaded >= payload.length);
      void drive;
    } finally {
      await app.close();
    }
  });
});

test('a failed mirror retries honestly and completes the missing chunks only', async () => {
  const dropbox = makeFakeAdapter('dropbox');
  let failSmallUploads = true;
  const realUpload = dropbox.adapter.uploadObjectStream!;
  const dropboxAdapter = {
    ...dropbox.adapter,
    async uploadObjectStream(bundle: ProviderCredentialBundle, params: UploadObjectStreamParams, cfg?: DecryptedProviderAppConfig) {
      if (failSmallUploads && params.sizeBytes === 4 * MIB) {
        throw new ProviderError('provider_unavailable', 502, 'injected second-chunk failure');
      }
      return realUpload(bundle, params, cfg);
    },
  };
  installTestAdapter('google_drive', makeFakeAdapter('google_drive').adapter);
  installTestAdapter('dropbox', dropboxAdapter);
  const { app, client } = await authed();
  try {
    seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
    seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });
    // 12 MiB with 8 MiB chunks = two chunks: 8 MiB + 4 MiB
    const { fileId } = await uploadFile(app, client, { name: 'two-chunks.bin', sizeBytes: 12 * MIB });

    const started = await startMirror(client, fileId);
    assert.equal(started.status, 202);
    const failedView = await waitForMirrorState(client, fileId, ['failed']);
    assert.equal(failedView.mirroredChunks, 1, 'the first chunk mirrored before the failure');
    assert.equal(failedView.job?.safeErrorCode, 'provider_unavailable');

    // the same POST retries the failed job and finishes ONLY the missing chunk
    failSmallUploads = false;
    const retried = await startMirror(client, fileId);
    assert.equal(retried.status, 202);
    const doneView = await waitForMirrorState(client, fileId, ['completed']);
    assert.equal(doneView.mirroredChunks, 2);
  } finally {
    clearTestAdapters();
    await app.close();
  }
});

test('mirror preflight is honest: no target, wrong state, trash, empty file, foreign file', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      const { fileId } = await uploadFile(app, client, { name: 'solo.bin', sizeBytes: 5 });

      // only one account exists: a mirror cannot even start
      const noTarget = await startMirror(client, fileId);
      assert.equal(noTarget.status, 409);
      assert.equal(noTarget.body['code'], 'mirror_no_target');

      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });

      // non-completed files are refused
      const now = new Date().toISOString();
      app.db.prepare(
        `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
         VALUES ('f-upload', 'usr_admin', 'wip.bin', 12, 8388608, 1, 'uploading', 'personal', ?)`,
      ).run(now);
      const wip = await startMirror(client, 'f-upload');
      assert.equal(wip.status, 409);
      assert.equal(wip.body['code'], 'file_not_complete');

      // trashed files are refused
      app.db.prepare("UPDATE files SET trashed_at = ? WHERE id = ?").run(now, fileId);
      const trashed = await startMirror(client, fileId);
      assert.equal(trashed.status, 409);
      assert.equal(trashed.body['code'], 'file_trashed');
      app.db.prepare("UPDATE files SET trashed_at = NULL WHERE id = ?").run(fileId);

      // empty files have nothing to mirror
      app.db.prepare(
        `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
         VALUES ('f-empty', 'usr_admin', 'empty.bin', 0, 8388608, 0, 'completed', 'personal', ?)`,
      ).run(now);
      const empty = await startMirror(client, 'f-empty');
      assert.equal(empty.status, 409);
      assert.equal(empty.body['code'], 'nothing_to_mirror');

      // a member naming a foreign file gets the same 404 as a missing one
      const invited = await client.post('/api/users', {
        email: 'member-fixture@example.com', displayName: 'm', role: 'member', allowanceBytes: null,
      });
      assert.equal(invited.status, 201);
      const { acceptUrl } = invited.body as { acceptUrl: string };
      const claimer = new Client(app.url);
      await claimer.post('/api/auth/accept-invite', { token: new URL(acceptUrl).searchParams.get('token') ?? '', password: MEMBER_PASSWORD, confirm: MEMBER_PASSWORD });
      const member = new Client(app.url);
      await member.send('POST', '/api/auth/login', { username: 'member-fixture@example.com', password: MEMBER_PASSWORD });
      const foreign = await member.post(`/api/files/${fileId}/mirror`, {});
      assert.equal(foreign.status, 404);
      const foreignGet = await member.get(`/api/files/${fileId}/mirror`);
      assert.equal(foreignGet.status, 404);
    } finally {
      await app.close();
    }
  });
});

test('a mirror target must genuinely fit the chunk: no invented capacity', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      // 4 MiB total cannot take an 8 MiB chunk
      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b', total: 4 * MIB });
      const { fileId } = await uploadFile(app, client, { name: 'big.bin', sizeBytes: 8 * MIB });

      const started = await startMirror(client, fileId);
      assert.equal(started.status, 202);
      const view = await waitForMirrorState(client, fileId, ['failed']);
      assert.equal(view.job?.safeErrorCode, 'mirror_no_target');

      // nothing was placed and the failed attempt holds no reservation — a
      // copy that cannot start never even creates its allocation row
      const mirrorPlacements = app.db.prepare(
        "SELECT COUNT(*) AS n FROM chunk_placements p JOIN file_chunks c ON c.id = p.chunk_id WHERE c.file_id = ? AND p.placement_role = 'mirror'",
      ).get(fileId) as { n: number };
      assert.equal(mirrorPlacements.n, 0);
      const maybeAllocation = app.db.prepare(
        `SELECT a.state FROM upload_chunk_allocations a JOIN transfer_jobs j ON j.id = a.job_id WHERE j.file_id = ? AND j.job_type = 'mirror'`,
      ).get(fileId) as { state: string } | undefined;
      if (maybeAllocation) assert.equal(maybeAllocation.state, 'released');
    } finally {
      await app.close();
    }
  });
});

test('an interrupted mirror copy leaves a durable cleanup obligation, not an orphan', async () => {
  await withFakes(async ({ dropbox }) => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });
      const { fileId } = await uploadFile(app, client, { name: 'orphan.bin', sizeBytes: 6 });

      // simulate a crash mid-copy: the attempt wrote a remote object but the
      // placement never committed, and the job was left running
      const now = new Date().toISOString();
      const jobId = crypto.randomUUID();
      app.db.prepare(
        `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_total, created_at, updated_at)
         VALUES (?, ?, 'mirror', 'running', 1, ?, ?)`,
      ).run(jobId, fileId, now, now);
      const orphanKey = `cn-${fileId}-c0-orphan`;
      dropbox.store.set(`tok-b/${orphanKey}`, {
        accountKey: 'tok-b', objectKey: orphanKey,
        bytes: Buffer.from('half-written'), deleted: false,
      });
      app.db.prepare(
        `INSERT INTO upload_attempts (id, job_id, chunk_index, provider_account_id, object_key, state, bytes_received, remote_object_id, created_at, updated_at)
         VALUES (?, ?, 0, 'acc-b', ?, 'uploaded_uncommitted', 6, ?, ?, ?)`,
      ).run(crypto.randomUUID(), jobId, orphanKey, orphanKey, now, now);

      // startup reconcile records the obligation before anything else
      const uploads = new UploadService(app.db, new CredentialsStore(app.db, app.dataDir));
      uploads.recoverOnStartup();
      const attempt = app.db.prepare('SELECT state FROM upload_attempts WHERE object_key = ?').get(orphanKey) as { state: string };
      assert.equal(attempt.state, 'cleanup_pending');

      // the retry closes it: the remote object is really gone
      const result = await uploads.retryPendingCleanups();
      assert.equal(result.cleaned, 1);
      const cleaned = app.db.prepare('SELECT state FROM upload_attempts WHERE object_key = ?').get(orphanKey) as { state: string };
      assert.equal(cleaned.state, 'cleaned');
      assert.equal(dropbox.store.get(`tok-b/${orphanKey}`)?.deleted, true);

      // the interrupted mirror job itself stays a durable row the scheduler drives
      const mirrorJob = app.db.prepare("SELECT state FROM transfer_jobs WHERE id = ?").get(jobId) as { state: string };
      assert.equal(mirrorJob.state, 'running');
      void client;
    } finally {
      await app.close();
    }
  });
});

// ---- download mirror-fallback ----

test('a download falls back to the mirror copy when the primary fails or is corrupt', async () => {
  const drive = makeFakeAdapter('google_drive');
  const dropbox = makeFakeAdapter('dropbox');
  let failPrimaryDownloads = false;
  const realDownload = drive.adapter.downloadObjectStream!;
  const driveAdapter = {
    ...drive.adapter,
    async downloadObjectStream(bundle: ProviderCredentialBundle, remoteId: string, cfg?: DecryptedProviderAppConfig, range?: { start: number; end: number }) {
      if (failPrimaryDownloads && fakeAccountKey(bundle) === 'tok-a') {
        throw new ProviderError('provider_unavailable', 502, 'primary offline');
      }
      return realDownload(bundle, remoteId, cfg, range);
    },
  };
  installTestAdapter('google_drive', driveAdapter);
  installTestAdapter('dropbox', dropbox.adapter);
  const { app, client } = await authed();
  try {
    seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
    seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });
    const payload = Buffer.from('download me from either copy');
    const { fileId } = await uploadFile(app, client, { name: 'fallback.bin', sizeBytes: payload.length, content: payload });
    const mirrorStart = await startMirror(client, fileId);
    assert.equal(mirrorStart.status, 202);
    await waitForMirrorState(client, fileId, ['completed']);

    // 1. primary offline → the mirror copy serves the file
    failPrimaryDownloads = true;
    const viaMirror = await rawDownload(app, client, fileId);
    assert.equal(viaMirror.status, 200);
    assert.ok(viaMirror.bytes.equals(payload), 'the mirror copy must hold the exact bytes');

    // 2. primary corrupt → the mirror copy still serves (mismatch falls through)
    failPrimaryDownloads = false;
    const primaryObj = [...drive.store.values()][0]!;
    primaryObj.bytes = Buffer.from('corrupted bytes on the primary');
    const viaHealthyMirror = await rawDownload(app, client, fileId);
    assert.equal(viaHealthyMirror.status, 200);
    assert.ok(viaHealthyMirror.bytes.equals(payload), 'a corrupt primary must not corrupt the download');
    // the file is NOT condemned while a good copy exists
    const state = app.db.prepare('SELECT state FROM files WHERE id = ?').get(fileId) as { state: string };
    assert.equal(state.state, 'completed');
  } finally {
    clearTestAdapters();
    await app.close();
  }
});

// ---- background scheduler ----

test('the scheduler refreshes quotas, retries pending deletions, and prunes metrics', async () => {
  await withFakes(async ({ dropbox }) => {
    const { app } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });

      // a pending deletion with a live remote object
      const now = new Date().toISOString();
      app.db.prepare(
        `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
         VALUES ('f-del', 'usr_admin', 'gone.bin', 4, 8388608, 1, 'deletion_pending', 'personal', ?)`,
      ).run(now);
      app.db.prepare(
        `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
         VALUES ('ch-del', 'f-del', 0, 0, 4, 'bb', 'uploaded', ?, ?)`,
      ).run(now, now);
      dropbox.store.set('tok-b/obj-del', { accountKey: 'tok-b', objectKey: 'obj-del', bytes: Buffer.from('data'), deleted: false });
      app.db.prepare(
        `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, created_at, updated_at)
         VALUES ('pl-del', 'ch-del', 'acc-b', 'obj-del', 'uploaded', 1, ?, ?)`,
      ).run(now, now);
      const delJobId = crypto.randomUUID();
      app.db.prepare(
        `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_total, created_at, updated_at)
         VALUES (?, 'f-del', 'delete', 'deletion_pending', 1, ?, ?)`,
      ).run(delJobId, now, now);

      // a metrics bucket older than the retention window
      const metrics = new ProviderMetrics(app.db);
      app.db.prepare(
        `INSERT INTO provider_metrics (provider, day, requests_total, updated_at)
         VALUES ('google_drive', ?, 9, ?)`,
      ).run(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), now);

      const store = new CredentialsStore(app.db, app.dataDir);
      const scheduler = createBackgroundScheduler({
        accounts: new ProviderAccountService(app.db, makeProviderQueries(app.db), store),
        store,
        metrics,
        deletions: new DeletionService(app.db, store, new ShareService(app.db)),
        uploads: new UploadService(app.db, store),
        trash: { purgeExpired: () => 0 },
      });
      await scheduler.runAllOnce();

      // quota refresh ran for both accounts
      const refreshed = app.db.prepare(
        'SELECT id, last_quota_check_at FROM provider_accounts ORDER BY id',
      ).all() as Array<{ id: string; last_quota_check_at: string | null }>;
      for (const row of refreshed) {
        assert.ok(row.last_quota_check_at, `${row.id} quota was refreshed by the scheduler`);
      }

      // the pending deletion completed and the remote object is really gone
      const job = app.db.prepare('SELECT state FROM transfer_jobs WHERE id = ?').get(delJobId) as { state: string };
      assert.equal(job.state, 'completed');
      assert.equal(dropbox.store.get('tok-b/obj-del')?.deleted, true);

      // the stale metrics bucket was pruned
      const stale = app.db.prepare('SELECT COUNT(*) AS n FROM provider_metrics WHERE requests_total = 9').get() as { n: number };
      assert.equal(stale.n, 0);
    } finally {
      await app.close();
    }
  });
});

// ---- provider metrics + health badge ----

test('uploads, downloads and failures feed the per-provider metrics; the badge derives honestly', async () => {
  await withFakes(async () => {
    const { app, client } = await authed();
    try {
      seedAccount(app, { id: 'acc-a', provider: 'google_drive', token: 'tok-a' });
      seedAccount(app, { id: 'acc-b', provider: 'dropbox', token: 'tok-b' });
      const payload = Buffer.from('metric bytes');
      const { fileId } = await uploadFile(app, client, { name: 'metrics.bin', sizeBytes: payload.length });

      // the upload recorded calls + bytes for google_drive
      const up = app.db.prepare(
        "SELECT requests_total, requests_failed, bytes_uploaded FROM provider_metrics WHERE provider = 'google_drive'",
      ).get() as { requests_total: number; requests_failed: number; bytes_uploaded: number };
      assert.ok(up.requests_total >= 1);
      assert.equal(up.requests_failed, 0);
      assert.ok(up.bytes_uploaded >= payload.length);

      // a download records bytes_downloaded
      const dl = await rawDownload(app, client, fileId);
      assert.equal(dl.status, 200);
      const down = app.db.prepare(
        "SELECT bytes_downloaded FROM provider_metrics WHERE provider = 'google_drive'",
      ).get() as { bytes_downloaded: number };
      assert.ok(down.bytes_downloaded >= payload.length);

      // a failing quota refresh records a failed call: this account's provider
      // fake refuses its quota reads
      const failingDropbox = makeFakeAdapter('dropbox', { failQuotaFor: ['tok-b'] });
      installTestAdapter('dropbox', failingDropbox.adapter);
      await client.post('/api/provider-accounts/acc-b/refresh-quota', {});
      const failRow = app.db.prepare(
        "SELECT requests_failed, last_error_code FROM provider_metrics WHERE provider = 'dropbox' AND requests_failed > 0",
      ).get() as { requests_failed: number; last_error_code: string | null } | undefined;
      assert.ok(failRow, 'a failed provider call must be recorded');

      // the health badge endpoint (admin-only) derives from live rows
      const health = await client.get('/api/metrics/providers');
      assert.equal(health.status, 200);
      const providers = (health.body as { providers: Array<{ provider: string; health: string; accounts: { total: number; connected: number }; storedBytes: number }> }).providers;
      const driveHealth = providers.find((p) => p.provider === 'google_drive');
      assert.ok(driveHealth);
      assert.equal(driveHealth.health, 'healthy');
      assert.equal(driveHealth.accounts.connected, 1);
      assert.ok(driveHealth.storedBytes >= payload.length, 'stored bytes are the tracked placement sum');

      // unconfigured provider says so instead of pretending
      const mega = providers.find((p) => p.provider === 'mega');
      assert.equal(mega?.health, 'unconfigured');

      // members cannot read provider reliability data (admin knowledge)
      const invited = await client.post('/api/users', {
        email: 'member-metrics@example.com', displayName: 'm2', role: 'member', allowanceBytes: null,
      });
      const { acceptUrl } = invited.body as { acceptUrl: string };
      const claimer = new Client(app.url);
      await claimer.post('/api/auth/accept-invite', { token: new URL(acceptUrl).searchParams.get('token') ?? '', password: MEMBER_PASSWORD, confirm: MEMBER_PASSWORD });
      const member = new Client(app.url);
      await member.send('POST', '/api/auth/login', { username: 'member-metrics@example.com', password: MEMBER_PASSWORD });
      const forbidden = await member.get('/api/metrics/providers');
      assert.equal(forbidden.status, 403);
    } finally {
      await app.close();
    }
  });
});

test('the badge degrades and downs honestly from account status and error rate', async () => {
  await withFakes(async () => {
    const app = await startTestApp();
    try {
      const now = new Date().toISOString();
      // degraded: one account needs reauth
      app.db.prepare(
        `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
          quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
         VALUES ('acc-r', 'google_drive', 'R', 'ident-r', 'needs_reauth', 100, 0, 'current', 0, 0, ?, ?)`,
      ).run(now, now);
      // down: every pcloud account disconnected
      app.db.prepare(
        `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
          quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
         VALUES ('acc-d', 'pcloud', 'D', 'ident-d', 'disconnected', 100, 0, 'current', 0, 0, ?, ?)`,
      ).run(now, now);

      // metrics need a session at all
      const anonymous = await new Client(app.url).get('/api/metrics/providers');
      assert.equal(anonymous.status, 401);

      const client = new Client(app.url);
      await client.setup(GOOD);
      const ok = await client.get('/api/metrics/providers');
      assert.equal(ok.status, 200);
      const providers = (ok.body as { providers: Array<{ provider: string; health: string }> }).providers;
      assert.equal(providers.find((p) => p.provider === 'google_drive')?.health, 'degraded');
      assert.equal(providers.find((p) => p.provider === 'pcloud')?.health, 'down');

      // a high error rate (≥5 samples) pulls a connected provider down
      const dropboxNow = new Date().toISOString();
      app.db.prepare(
        `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
          quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
         VALUES ('acc-c', 'dropbox', 'C', 'ident-c', 'connected', 100, 0, 'current', 0, 0, ?, ?)`,
      ).run(dropboxNow, dropboxNow);
      const metrics = new ProviderMetrics(app.db);
      for (let i = 0; i < 10; i++) metrics.recordCall('dropbox', false, 'provider_unavailable');
      const worse = await client.get('/api/metrics/providers');
      const dropboxHealth = (worse.body as { providers: Array<{ provider: string; health: string }> }).providers
        .find((p) => p.provider === 'dropbox');
      assert.equal(dropboxHealth?.health, 'down', 'a mostly-failing provider is down, not healthy');
    } finally {
      await app.close();
    }
  });
});
