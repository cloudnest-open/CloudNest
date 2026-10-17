import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, Client, type TestApp } from './helpers.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { installTestAdapter, clearTestAdapters } from '../src/providers/registry.js';
import { makeFakeAdapter, type FakeAdapterHandle } from './fake-adapter.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { TrashService } from '../src/files/trash-service.js';
import { NotificationService } from '../src/notifications/notification-service.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * Roadmap Phase 4 — folders/tree, trash with a restore window, the real
 * notification feed, and the auto-spread routing toggle, over the real HTTP
 * API. All storage runs on mocked adapters and a temp database; no live
 * provider is touched.
 */

const MIB = 1024 * 1024;
const GOOD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member test passphrase 7';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

async function createMember(admin: Client, app: TestApp, email: string): Promise<{ client: Client; userId: string }> {
  const invited = await admin.post('/api/users', {
    email, displayName: email.split('@')[0] ?? email, role: 'member', allowanceBytes: null,
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const { user, acceptUrl } = invited.body as { user: { id: string }; acceptUrl: string };
  const token = new URL(acceptUrl).searchParams.get('token') ?? '';
  const claimer = new Client(app.url);
  const claimed = await claimer.post('/api/auth/accept-invite', { token, password: MEMBER_PASSWORD, confirm: MEMBER_PASSWORD });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const client = new Client(app.url);
  const login = await client.send('POST', '/api/auth/login', { username: email, password: MEMBER_PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { client, userId: user.id };
}

/** Seed a completed file row directly (no provider round-trip). */
function seedFile(app: TestApp, opts: { id: string; userId: string; name: string }): void {
  const { db, close } = openDatabase(app.dbPath);
  try {
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
       VALUES (?, ?, ?, 12, 8388608, 0, 'completed', 'personal', ?)`,
    ).run(opts.id, opts.userId, opts.name, new Date().toISOString());
  } finally {
    close();
  }
}

function bundleFor(provider: 'google_drive', token: string): ProviderCredentialBundle {
  return { schemaVersion: 1, provider, accessToken: token, refreshToken: `refresh-${token}`, grantedScopes: [] };
}

function seedAccount(app: TestApp, opts: { id: string; token: string; total: number }): void {
  const { db, close } = openDatabase(app.dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
        quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
       VALUES (?, 'google_drive', ?, ?, 'connected', ?, 0, 'current', 0, 0, ?, ?)`,
    ).run(opts.id, `${opts.id} label`, `ident-${opts.id}`, opts.total, now, now);
    const store = new CredentialsStore(db, app.dataDir);
    store.saveAccountBundle(opts.id, 'google_drive', bundleFor('google_drive', opts.token));
  } finally {
    close();
  }
}

async function withFake<T>(run: (fake: FakeAdapterHandle) => Promise<T> | T): Promise<T> {
  const fake = makeFakeAdapter('google_drive', undefined);
  installTestAdapter('google_drive', fake.adapter);
  try {
    return await run(fake);
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

interface NotificationView { id: string; kind: string; payload: Record<string, unknown>; readAt: string | null; createdAt: string }

async function listNotifications(client: Client): Promise<{ notifications: NotificationView[]; unreadCount: number }> {
  const res = await client.get('/api/notifications');
  assert.equal(res.status, 200);
  return res.body as { notifications: NotificationView[]; unreadCount: number };
}

// ---- M0014 migration ----

test('M0014 adds folders/trash/notification structures and leaves legacy rows NULL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-m14-'));
  let closed = false;
  let dbRef: { close: () => void } | null = null;
  try {
    const { db, close } = openDatabase(path.join(dir, 't.db'));
    dbRef = db;
    runMigrations(db, allMigrations.filter((m) => m.version <= 13));
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
       VALUES ('f-legacy', 'usr_admin', 'legacy.bin', 12, 8388608, 0, 'completed', 'personal', ?)`,
    ).run(new Date().toISOString());
    runMigrations(db, allMigrations);

    const legacy = db.prepare("SELECT parent_id, trashed_at FROM files WHERE id = 'f-legacy'").get() as
      | { parent_id: string | null; trashed_at: string | null };
    assert.equal(legacy.parent_id, null, "pre-Phase-4 files stay in their owner's root");
    assert.equal(legacy.trashed_at, null);

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES ('f1', 'usr_admin', NULL, 'Work', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES ('f2', 'usr_admin', 'f1', '2026', ?, ?)",
    ).run(now, now);
    assert.throws(
      () => db.prepare(
        "INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES ('f3', 'usr_admin', NULL, 'Work', ?, ?)",
      ).run(now, now),
      /UNIQUE constraint failed/,
      'the same name twice in one parent is refused',
    );
    assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0);
    close();
    closed = true;
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (!closed) dbRef?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- folders ----

test('folders: create, nest, duplicate-name 409, rename, empty-only delete, breadcrumb', async () => {
  const { app, client } = await authed();
  try {
    const root = await client.post('/api/folders', { name: 'Work', parentId: null });
    assert.equal(root.status, 201, JSON.stringify(root.body));
    const work = (root.body as { folder: { id: string } }).folder;

    const nested = await client.post('/api/folders', { name: '2026', parentId: work.id });
    assert.equal(nested.status, 201);
    const inner = (nested.body as { folder: { id: string } }).folder;

    const dup = await client.post('/api/folders', { name: 'Work', parentId: null });
    assert.equal(dup.status, 409);
    assert.equal((dup.body as { code: string }).code, 'folder_name_exists');

    // the same name is fine in a different folder
    const sibling = await client.post('/api/folders', { name: 'Work', parentId: work.id });
    assert.equal(sibling.status, 201);

    const children = await client.get(`/api/folders/${work.id}/children`);
    assert.equal(children.status, 200);
    const childBody = children.body as { breadcrumb: Array<{ id: string; name: string }>; folders: Array<{ id: string; name: string; owned: boolean }> };
    assert.deepEqual(childBody.breadcrumb, [{ id: work.id, name: 'Work' }]);
    assert.deepEqual(childBody.folders.map((f) => f.name).sort(), ['2026', 'Work']);
    assert.ok(childBody.folders.every((f) => f.owned === true));

    // delete refuses a non-empty folder, works on an empty one
    const busyDelete = await client.send('DELETE', `/api/folders/${work.id}`);
    assert.equal(busyDelete.status, 409);
    assert.equal((busyDelete.body as { code: string }).code, 'folder_not_empty');
    const renamed = await client.send('PATCH', `/api/folders/${inner.id}`, { name: '2027' });
    assert.equal(renamed.status, 200);
    const gone = await client.send('DELETE', `/api/folders/${inner.id}`);
    assert.equal(gone.status, 200);

    // root listing works with the 'root' sentinel
    const rootChildren = await client.get('/api/folders/root/children');
    assert.equal(rootChildren.status, 200);
    assert.ok(((rootChildren.body as { folders: Array<{ name: string }> }).folders.some((f) => f.name === 'Work')));
  } finally {
    await app.close();
  }
});

test('folders: a member has their own tree and foreign ids answer the same 404', async () => {
  const { app, client } = await authed();
  try {
    const adminFolder = await client.post('/api/folders', { name: 'Admin-only', parentId: null });
    assert.equal(adminFolder.status, 201);
    const adminFolderId = (adminFolder.body as { folder: { id: string } }).folder.id;

    const { client: member } = await createMember(client, app, 'tree-member@fixture.test');
    // the admin's tree is invisible to the member: same 404 as a missing folder
    const peek = await member.get(`/api/folders/${adminFolderId}/children`);
    assert.equal(peek.status, 404);
    const nest = await member.post('/api/folders', { name: 'Sneaky', parentId: adminFolderId });
    assert.equal(nest.status, 404);
    const rename = await member.send('PATCH', `/api/folders/${adminFolderId}`, { name: 'Hijacked' });
    assert.equal(rename.status, 404);

    // members build their own tree freely
    const memberRoot = await member.post('/api/folders', { name: 'Work', parentId: null });
    assert.equal(memberRoot.status, 201, 'a member may reuse a name the admin used');
    const memberChildren = await member.get('/api/folders/root/children');
    assert.deepEqual(
      ((memberChildren.body as { folders: Array<{ name: string }> }).folders).map((f) => f.name),
      ['Work'],
      'the member sees only their own tree',
    );
  } finally {
    await app.close();
  }
});

test('folders: files move into folders, respect tree ownership and show in the folder filter', async () => {
  const { app, client } = await authed();
  try {
    const folder = await client.post('/api/folders', { name: 'Docs', parentId: null });
    const folderId = (folder.body as { folder: { id: string } }).folder.id;
    seedFile(app, { id: 'fl-1', userId: 'usr_admin', name: 'one.bin' });
    seedFile(app, { id: 'fl-2', userId: 'usr_admin', name: 'two.bin' });

    const moved = await client.send('POST', '/api/files/fl-1/move', { folderId });
    assert.equal(moved.status, 200);
    assert.equal((moved.body as { moved: number }).moved, 1);

    const inFolder = await client.get(`/api/files?folderId=${folderId}`);
    assert.deepEqual((inFolder.body as { files: Array<{ id: string }> }).files.map((f) => f.id), ['fl-1']);
    assert.equal((inFolder.body as { total: number }).total, 1);
    // the response carries the parent so the UI can render location honestly
    assert.equal((inFolder.body as { files: Array<{ parentId: string | null }> }).files[0]!.parentId, folderId);

    const inRoot = await client.get('/api/files?folderId=root');
    assert.deepEqual((inRoot.body as { files: Array<{ id: string }> }).files.map((f) => f.id), ['fl-2']);
    const flat = await client.get('/api/files');
    assert.equal((flat.body as { total: number }).total, 2, 'no folderId keeps the flat library');

    // tree purity: an admin file cannot move into a member's folder
    const { client: member, userId } = await createMember(client, app, 'mover@fixture.test');
    const memberFolder = await member.post('/api/folders', { name: 'Mine', parentId: null });
    const memberFolderId = (memberFolder.body as { folder: { id: string } }).folder.id;
    seedFile(app, { id: 'fl-3', userId, name: 'mine.bin' });
    const cross = await member.send('POST', '/api/files/fl-1/move', { folderId: memberFolderId });
    assert.equal(cross.status, 200);
    const body = cross.body as { moved: number; failed: Array<{ id: string; code: string }> };
    assert.equal(body.moved, 0);
    assert.deepEqual(body.failed, [{ id: 'fl-1', code: 'file_not_found' }], 'a foreign file is unknown to the member');
    const own = await member.send('POST', '/api/files/fl-3/move', { folderId: memberFolderId });
    assert.equal((own.body as { moved: number }).moved, 1);
  } finally {
    await app.close();
  }
});

// ---- trash ----

test('trash: delete hides from the library, restore brings back, purge runs the engine', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app, { id: 'fl-t1', userId: 'usr_admin', name: 'gone.bin' });

    const trashed = await client.send('DELETE', '/api/files/fl-t1');
    assert.equal(trashed.status, 200);
    const trashedBody = trashed.body as { trashedAt: string; purgeAfter: string };
    assert.ok(Date.parse(trashedBody.purgeAfter) > Date.now() + 6 * 24 * 3600 * 1000, 'the restore window is about seven days');

    const list = await client.get('/api/files');
    assert.equal((list.body as { files: Array<{ id: string }> }).files.some((f) => f.id === 'fl-t1'), false);
    const trashList = await client.get('/api/trash');
    const trashBody = trashList.body as { files: Array<{ id: string; trashedAt: string }>; total: number; retentionDays: number };
    assert.equal(trashBody.total, 1);
    assert.equal(trashBody.retentionDays, 7);
    assert.equal(trashBody.files[0]!.id, 'fl-t1');

    const restore = await client.post('/api/files/fl-t1/restore');
    assert.equal(restore.status, 200);
    const back = await client.get('/api/files');
    assert.equal((back.body as { files: Array<{ id: string }> }).files.some((f) => f.id === 'fl-t1'), true);
    assert.equal(((await client.get('/api/trash')).body as { total: number }).total, 0);

    // purge: the durable engine completes a file with no remote objects
    await client.send('DELETE', '/api/files/fl-t1');
    const purge = await client.post('/api/files/fl-t1/purge');
    assert.equal(purge.status, 202);
    const jobId = (purge.body as { jobId: string }).jobId;
    const retry = await client.post(`/api/deletions/${jobId}/retry`);
    assert.equal((retry.body as { result: { state: string } }).result.state, 'completed');
    const row = (await client.get('/api/files')).body as { files: Array<{ id: string }> };
    assert.equal(row.files.some((f) => f.id === 'fl-t1'), false);
  } finally {
    await app.close();
  }
});

test('trash: members see only their own trash; foreign ids are 404; empty-trash is owner-scoped', async () => {
  const { app, client } = await authed();
  try {
    const { client: member, userId } = await createMember(client, app, 'trash-member@fixture.test');
    seedFile(app, { id: 'fl-a', userId: 'usr_admin', name: 'admin.bin' });
    seedFile(app, { id: 'fl-b', userId, name: 'member.bin' });

    await client.send('DELETE', '/api/files/fl-a');
    await member.send('DELETE', '/api/files/fl-b');

    // the admin role sees the whole trash; the member only their own
    const adminTrash = (await client.get('/api/trash')).body as { files: Array<{ id: string }> };
    assert.deepEqual([...adminTrash.files.map((f) => f.id)].sort(), ['fl-a', 'fl-b']);
    const memberTrash = (await member.get('/api/trash')).body as { files: Array<{ id: string }> };
    assert.deepEqual(memberTrash.files.map((f) => f.id), ['fl-b']);

    // a member cannot touch the admin's trashed file
    assert.equal((await member.post('/api/files/fl-a/restore')).status, 404);
    assert.equal((await member.post('/api/files/fl-a/purge')).status, 404);

    // empty-trash only enqueues the caller's own files
    const emptied = await member.post('/api/trash/empty');
    assert.equal((emptied.body as { purged: number }).purged, 1);
    const jobs = app.db.prepare("SELECT COUNT(*) AS n FROM transfer_jobs WHERE job_type = 'delete'").get() as { n: number };
    assert.equal(jobs.n, 1, "the admin's trashed file was not swept by the member's empty");
  } finally {
    await app.close();
  }
});

test('trash: purgeExpired enqueues only files past the restore window', async () => {
  const { app } = await authed();
  try {
    seedFile(app, { id: 'fl-old', userId: 'usr_admin', name: 'old.bin' });
    seedFile(app, { id: 'fl-new', userId: 'usr_admin', name: 'new.bin' });
    const now = new Date().toISOString();
    app.db.prepare("UPDATE files SET trashed_at = ? WHERE id = 'fl-old'")
      .run(new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());
    app.db.prepare("UPDATE files SET trashed_at = ? WHERE id = 'fl-new'").run(now);

    const enqueued: string[] = [];
    const trash = new TrashService(app.db, (fileId) => {
      enqueued.push(fileId);
      return { jobId: crypto.randomUUID(), state: 'queued' };
    });
    const purged = trash.purgeExpired();
    assert.equal(purged, 1);
    assert.deepEqual(enqueued, ['fl-old'], 'a file inside the window is never swept');
  } finally {
    await app.close();
  }
});

// ---- notifications ----

test("notifications: a finished upload lands in the owner's feed with an unread count", async () => {
  const { app, client } = await authed();
  try {
    await withFake(async () => {
      seedAccount(app, { id: 'acc-up', token: 'tok-up', total: 32 * MIB });
      // 24 MiB sits above the 20 MiB single-object threshold, so this stays a
      // real multi-chunk upload (3 × 8 MiB) — which is what the feed test needs
      const plan = await client.post('/api/uploads/plan',
        { originalName: 'notify.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-notify-1' },
        { 'idempotency-key': 'key-notify-1' } as never);
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const planBody = plan.body as { jobId: string };
      assert.equal(await putChunk(app, client, planBody.jobId, 0, crypto.randomBytes(8 * MIB)), 200);
      assert.equal(await putChunk(app, client, planBody.jobId, 1, crypto.randomBytes(8 * MIB)), 200);
      assert.equal(await putChunk(app, client, planBody.jobId, 2, crypto.randomBytes(8 * MIB)), 200);

      const feed = await listNotifications(client);
      assert.equal(feed.unreadCount, 1, JSON.stringify(feed));
      const event = feed.notifications.find((n) => n.kind === 'upload_completed');
      assert.ok(event, 'the finished upload is in the feed');
      assert.equal((event!.payload as { fileName: string }).fileName, 'notify.bin');

      const marked = await client.post('/api/notifications/read-all');
      assert.equal((marked.body as { unreadCount: number }).unreadCount, 0);
      assert.equal((await listNotifications(client)).unreadCount, 0);
    });
  } finally {
    await app.close();
  }
});

test('notifications: a used share link reaches its creator; members only ever see their own feed', async () => {
  const { app, client } = await authed();
  try {
    await withFake(async () => {
      seedAccount(app, { id: 'acc-sh', token: 'tok-sh', total: 32 * MIB });
      const plan = await client.post('/api/uploads/plan',
        { originalName: 'shared.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-share-1' },
        { 'idempotency-key': 'key-share-1' } as never);
      const planBody = plan.body as { jobId: string; fileId: string };
      assert.equal(await putChunk(app, client, planBody.jobId, 0, crypto.randomBytes(8 * MIB)), 200);

      const created = await client.post('/api/share-links', { fileIds: [planBody.fileId] });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const token = (created.body as { url: string }).url.split('/s/')[1]!;

      const { client: member } = await createMember(client, app, 'feed-member@fixture.test');
      const csrf = (await member.get('/api/auth/csrf-token')).body as { csrfToken: string };
      const started = await fetch(`${app.url}/api/public/shares/${token}/files/${planBody.fileId}/download-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken, cookie: member.jar.header() },
      });
      assert.equal(started.status, 200, JSON.stringify(await started.json().catch(() => null)));

      const feed = await listNotifications(client);
      const event = feed.notifications.find((n) => n.kind === 'share_used');
      assert.ok(event, "the used share is in the creator's feed");
      assert.equal((event!.payload as { fileName: string }).fileName, 'shared.bin');
      assert.equal((event!.payload as { downloads: number }).downloads, 1);

      // a member's feed is their own: nothing from the admin's events
      const memberFeed = await listNotifications(member);
      assert.equal(memberFeed.notifications.length, 0);
    });
  } finally {
    await app.close();
  }
});

test('notifications: account-level events go to every active admin, never to members', async () => {
  const { app, client } = await authed();
  try {
    const { client: member } = await createMember(client, app, 'quiet@fixture.test');
    const notifications = new NotificationService(app.db);
    const delivered = notifications.pushToAdmins('quota_stale', { accountLabel: 'Drive-B', reasonCode: 'provider_no_space' });
    assert.equal(delivered, 1, 'only the built-in admin exists so far');

    const feed = await listNotifications(client);
    const event = feed.notifications.find((n) => n.kind === 'quota_stale');
    assert.ok(event);
    assert.equal((event!.payload as { accountLabel: string }).accountLabel, 'Drive-B');
    assert.equal((await listNotifications(member)).notifications.length, 0, 'members never receive account events');
  } finally {
    await app.close();
  }
});

// ---- auto-spread (routing strategy) ----

test('auto-spread: capacity-aware fills the largest pool first; the key is strategy-bound', async () => {
  const { app, client } = await authed();
  try {
    await withFake(async () => {
      // 16 MiB per account forces the 24 MiB file to span both, so spilling is visible
      seedAccount(app, { id: 'acc-x', token: 'tok-x', total: 16 * MIB });
      seedAccount(app, { id: 'acc-y', token: 'tok-y', total: 16 * MIB });

      const fill = await client.post('/api/uploads/plan',
        { originalName: 'fill.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-fill-1', routingStrategy: 'capacity-aware' },
        { 'idempotency-key': 'key-fill-1' } as never);
      assert.equal(fill.status, 201, JSON.stringify(fill.body));

      const placementsOf = (jobId: string): string[] => {
        // the plan's durable reservations: one allocation row per chunk
        const rows = app.db.prepare(
          'SELECT provider_account_id AS acc FROM upload_chunk_allocations WHERE job_id = ? ORDER BY chunk_index',
        ).all(jobId) as Array<{ acc: string }>;
        return rows.map((r) => r.acc);
      };
      const fillBody = fill.body as { jobId: string };

      // capacity-aware: the largest pool takes 2 chunks before spilling
      assert.deepEqual(placementsOf(fillBody.jobId), ['acc-x', 'acc-x', 'acc-y']);

      // the same idempotency key may not silently switch routing behaviour
      const reuse = await client.post('/api/uploads/plan',
        { originalName: 'fill.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-fill-1', routingStrategy: 'balanced' },
        { 'idempotency-key': 'key-fill-1' } as never);
      assert.equal(reuse.status, 409);
      assert.equal((reuse.body as { code: string }).code, 'idempotency_key_reused');

      // /api/uploads exposes the saved default so the toggle starts honest
      const list = await client.get('/api/uploads');
      assert.equal(typeof (list.body as { spaceAwareRouting?: boolean }).spaceAwareRouting, 'boolean');
    });
  } finally {
    await app.close();
  }
});

test('auto-spread: balanced walks the pools round-robin from the first chunk', async () => {
  const { app, client } = await authed();
  try {
    await withFake(async () => {
      seedAccount(app, { id: 'acc-x', token: 'tok-x', total: 16 * MIB });
      seedAccount(app, { id: 'acc-y', token: 'tok-y', total: 16 * MIB });

      const spread = await client.post('/api/uploads/plan',
        { originalName: 'spread.bin', sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-spread-1', routingStrategy: 'balanced' },
        { 'idempotency-key': 'key-spread-1' } as never);
      assert.equal(spread.status, 201, JSON.stringify(spread.body));

      const placementsOf = (jobId: string): string[] => {
        const rows = app.db.prepare(
          'SELECT provider_account_id AS acc FROM upload_chunk_allocations WHERE job_id = ? ORDER BY chunk_index',
        ).all(jobId) as Array<{ acc: string }>;
        return rows.map((r) => r.acc);
      };
      const spreadBody = spread.body as { jobId: string };

      // balanced: the round-robin cursor walks both pools from the first chunk
      assert.deepEqual(placementsOf(spreadBody.jobId), ['acc-x', 'acc-y', 'acc-x']);
    });
  } finally {
    await app.close();
  }
});

test('auto-spread: an unknown strategy is refused, an absent one uses the saved setting', async () => {
  const { app, client } = await authed();
  try {
    await withFake(async () => {
      seedAccount(app, { id: 'acc-z', token: 'tok-z', total: 32 * MIB });
      const bad = await client.post('/api/uploads/plan',
        { originalName: 'bad.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-bad-1', routingStrategy: 'chaotic' },
        { 'idempotency-key': 'key-bad-1' } as never);
      assert.equal(bad.status, 400);

      const good = await client.post('/api/uploads/plan',
        { originalName: 'default.bin', sizeBytes: 8 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: 'key-default-1' },
        { 'idempotency-key': 'key-default-1' } as never);
      assert.equal(good.status, 201, JSON.stringify(good.body));
    });
  } finally {
    await app.close();
  }
});
