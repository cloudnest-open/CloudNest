import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, Client, type TestApp } from './helpers.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';

/**
 * Mode = complete context (approved design 2026-10-18): every read surface is
 * scoped to one storage tier, folders live inside a tier, the switch warning
 * PAUSES (never cancels) the leaving tier's live uploads, and background work
 * keeps running. All data is synthetic on a temp database — no provider call.
 */

const GOOD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'member test passphrase 11';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

async function createMember(app: TestApp, admin: Client, email: string): Promise<Client> {
  const invited = await admin.post('/api/users', {
    email, displayName: email.split('@')[0] ?? email, role: 'member', allowanceBytes: null,
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const { acceptUrl } = invited.body as { acceptUrl: string };
  const token = new URL(acceptUrl).searchParams.get('token') ?? '';
  const claimer = new Client(app.url);
  const claimed = await claimer.post('/api/auth/accept-invite', { token, password: MEMBER_PASSWORD, confirm: MEMBER_PASSWORD });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const client = new Client(app.url);
  const login = await client.send('POST', '/api/auth/login', { username: email, password: MEMBER_PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return client;
}

interface Seeded { fileId: string; jobId: string }

/** Seed one completed file + a matching upload job row (synthetic, no provider). */
function seedFileWithJob(
  app: TestApp,
  opts: { userId: string; name: string; tier: 'personal' | 'business'; jobState?: string },
): Seeded {
  const { db, close } = openDatabase(app.dbPath);
  try {
    const fileId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
       VALUES (?, ?, ?, 12, 8388608, 0, 'completed', ?, ?)`,
    ).run(fileId, opts.userId, opts.name, opts.tier, now);
    db.prepare(
      `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
        retry_count, created_at, updated_at)
       VALUES (?, ?, 'upload', ?, 0, 1, 0, 0, ?, ?)`,
    ).run(jobId, fileId, opts.jobState ?? 'completed', now, now);
    return { fileId, jobId };
  } finally {
    close();
  }
}

function seedDownloadJob(
  app: TestApp,
  opts: { fileId: string; userId: string; tier: 'personal' | 'business'; state?: string },
): string {
  const { db, close } = openDatabase(app.dbPath);
  try {
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
        retry_count, created_at, updated_at)
       VALUES (?, ?, 'download', ?, 0, 1, 0, 0, ?, ?)`,
    ).run(jobId, opts.fileId, opts.state ?? 'completed', now, now);
    return jobId;
  } finally {
    close();
  }
}

function withDb<T>(app: TestApp, run: (db: import('better-sqlite3').Database) => T): T {
  const { db, close } = openDatabase(app.dbPath);
  try {
    return run(db);
  } finally {
    close();
  }
}

// ---- M0018 migration ----

test('M0018 adds folders.tier (personal default) and nullable notifications.tier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-m18-'));
  try {
    const { db, close } = openDatabase(path.join(dir, 't.db'));
    try {
      runMigrations(db, allMigrations);
      db.prepare(
        `INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at)
         VALUES ('f18', 'usr_admin', NULL, 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();
      const row = db.prepare('SELECT tier FROM folders WHERE id = ?').get('f18') as { tier: string };
      assert.equal(row.tier, 'personal');
      // CHECK constraint enforces the two documented values
      assert.throws(() => {
        db.prepare(
          `INSERT INTO folders (id, user_id, parent_id, name, tier, created_at, updated_at)
           VALUES ('f19', 'usr_admin', NULL, 'bad', 'other', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ).run();
      });
      const notifTier = db.prepare(
        `SELECT COUNT(*) AS n FROM pragma_table_info('notifications') WHERE name = 'tier' AND "notnull" = 0`,
      ).get() as { n: number };
      assert.equal(notifTier.n, 1, 'notifications.tier must be nullable');
    } finally {
      close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- file list tier filter ----

test('GET /api/files?tier= ships only the asked tier', async () => {
  const { app, client } = await authed();
  try {
    seedFileWithJob(app, { userId: 'usr_admin', name: 'admin-personal.txt', tier: 'personal' });
    seedFileWithJob(app, { userId: 'usr_admin', name: 'admin-business.bin', tier: 'business' });
    seedFileWithJob(app, { userId: 'usr_admin', name: 'admin-personal-2.txt', tier: 'personal' });

    const personal = await client.get('/api/files?tier=personal');
    assert.equal(personal.status, 200);
    const pBody = personal.body as { files: Array<{ originalName: string }>; total: number };
    assert.ok(pBody.files.every((f) => !f.originalName.includes('business')), JSON.stringify(pBody.files));
    assert.equal(pBody.total, pBody.files.length);

    const business = await client.get('/api/files?tier=business');
    const bBody = business.body as { files: Array<{ originalName: string }>; total: number };
    assert.equal(bBody.total, 1);
    assert.equal(bBody.files[0]?.originalName, 'admin-business.bin');

    // absent tier keeps the legacy whole-pool listing
    const all = await client.get('/api/files');
    assert.equal((all.body as { total: number }).total, 3);
  } finally {
    await app.close();
  }
});

// ---- folder tree per mode ----

test('folder tree is separate per mode: create/children/move/plan enforce the tier', async () => {
  const { app, client } = await authed();
  try {
    const bizRoot = await client.post('/api/folders', { name: 'Biz Root', tier: 'business' });
    assert.equal(bizRoot.status, 201, JSON.stringify(bizRoot.body));
    const bizId = (bizRoot.body as { folder: { id: string } }).folder.id;
    const perRoot = await client.post('/api/folders', { name: 'Personal Root' });
    assert.equal(perRoot.status, 201);
    const perId = (perRoot.body as { folder: { id: string } }).folder.id;

    // a child must stay in the parent's tier
    const badChild = await client.post('/api/folders', { name: 'Mixed Child', parentId: bizId, tier: 'personal' });
    assert.equal(badChild.status, 400);
    assert.equal((badChild.body as { code?: string }).code, 'folder_tier_mismatch');
    const goodChild = await client.post('/api/folders', { name: 'Biz Child', parentId: bizId, tier: 'business' });
    assert.equal(goodChild.status, 201);

    // children listing follows the asked tier
    const seenPersonal = await client.get('/api/folders/root/children?tier=personal');
    const pFolders = (seenPersonal.body as { folders: Array<{ id: string }> }).folders;
    assert.ok(pFolders.every((f) => f.id !== bizId));
    const seenBusiness = await client.get('/api/folders/root/children?tier=business');
    const bFolders = (seenBusiness.body as { folders: Array<{ id: string }> }).folders;
    assert.deepEqual(bFolders.map((f) => f.id), [bizId]);

    // move: a personal file refuses a business folder (per-file honest code)
    const moved = seedFileWithJob(app, { userId: 'usr_admin', name: 'mover.txt', tier: 'personal' });
    const moveRes = await client.post(`/api/files/${moved.fileId}/move`, { fileIds: [moved.fileId], folderId: bizId });
    assert.equal(moveRes.status, 200);
    const moveBody = moveRes.body as { moved: number; failed: Array<{ id: string; code: string }> };
    assert.equal(moveBody.moved, 0);
    assert.deepEqual(moveBody.failed, [{ id: moved.fileId, code: 'folder_tier_mismatch' }]);

    // plan: a business upload refuses a personal folder
    const planRes = await client.post(
      '/api/uploads/plan',
      { originalName: 'biz.bin', sizeBytes: 10, chunkSizeMiB: 8, mimeType: null, tier: 'business', parentId: perId },
      { 'idempotency-key': crypto.randomUUID() },
    );
    assert.equal(planRes.status, 400);
    assert.equal((planRes.body as { code?: string }).code, 'folder_tier_mismatch');
  } finally {
    await app.close();
  }
});

// ---- trash + notifications tier ----

test('trash and the bell feed follow the active tier (NULL-tier rows stay visible)', async () => {
  const { app, client } = await authed();
  try {
    const personal = seedFileWithJob(app, { userId: 'usr_admin', name: 'trash-personal.txt', tier: 'personal' });
    const business = seedFileWithJob(app, { userId: 'usr_admin', name: 'trash-business.bin', tier: 'business' });
    withDb(app, (db) => {
      db.prepare("UPDATE files SET trashed_at = ? WHERE id IN (?, ?)")
        .run(new Date().toISOString(), personal.fileId, business.fileId);
    });

    const trashPersonal = await client.get('/api/trash?tier=personal');
    assert.equal((trashPersonal.body as { total: number }).total, 1);
    const trashBusiness = await client.get('/api/trash?tier=business');
    assert.equal((trashBusiness.body as { total: number }).total, 1);
    const trashAll = await client.get('/api/trash');
    assert.equal((trashAll.body as { total: number }).total, 2);

    // notifications: tiered + NULL-tier rows; NULL visible in both modes
    withDb(app, (db) => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO notifications (id, user_id, kind, payload, tier, read_at, created_at)
         VALUES ('n1', 'usr_admin', 'upload_completed', '{}', 'personal', NULL, ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO notifications (id, user_id, kind, payload, tier, read_at, created_at)
         VALUES ('n2', 'usr_admin', 'share_used', '{}', 'business', NULL, ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO notifications (id, user_id, kind, payload, tier, read_at, created_at)
         VALUES ('n3', 'usr_admin', 'quota_stale', '{}', NULL, NULL, ?)`,
      ).run(now);
    });
    const feedPersonal = await client.get('/api/notifications?tier=personal');
    const pIds = feedPersonal.body as { notifications: Array<{ id: string }>; unreadCount: number };
    assert.deepEqual(pIds.notifications.map((n) => n.id).sort(), ['n1', 'n3']);
    assert.equal(pIds.unreadCount, 2);
    const feedBusiness = await client.get('/api/notifications?tier=business');
    const bIds = feedBusiness.body as { notifications: Array<{ id: string }>; unreadCount: number };
    assert.deepEqual(bIds.notifications.map((n) => n.id).sort(), ['n2', 'n3']);
    assert.equal(bIds.unreadCount, 2);
  } finally {
    await app.close();
  }
});

// ---- jobs: listing + pause-on-switch ----

test('uploads/downloads listings scope by tier; pause-active pauses only the leaving tier', async () => {
  const { app, client } = await authed();
  try {
    const pJob = seedFileWithJob(app, { userId: 'usr_admin', name: 'up-personal.txt', tier: 'personal', jobState: 'running' });
    const bJob = seedFileWithJob(app, { userId: 'usr_admin', name: 'up-business.bin', tier: 'business', jobState: 'queued' });
    seedDownloadJob(app, { fileId: pJob.fileId, userId: 'usr_admin', tier: 'personal' });
    seedDownloadJob(app, { fileId: bJob.fileId, userId: 'usr_admin', tier: 'business' });

    const upPersonal = await client.get('/api/uploads?tier=personal');
    assert.equal((upPersonal.body as { jobs: unknown[] }).jobs.length, 1);
    const upBusiness = await client.get('/api/uploads?tier=business');
    assert.equal((upBusiness.body as { jobs: unknown[] }).jobs.length, 1);

    const downPersonal = await client.get('/api/downloads?tier=personal');
    assert.equal((downPersonal.body as { total: number }).total, 1);
    const downBusiness = await client.get('/api/downloads?tier=business');
    assert.equal((downBusiness.body as { total: number }).total, 1);

    // the modal's honest count: one live job per tier
    const countPersonal = await client.get('/api/uploads/active-jobs-count?tier=personal');
    assert.equal((countPersonal.body as { count: number }).count, 1);
    const countBusiness = await client.get('/api/uploads/active-jobs-count?tier=business');
    assert.equal((countBusiness.body as { count: number }).count, 1);

    // switch away from Personal: pause personal's live uploads, business untouched
    const paused = await client.post('/api/uploads/pause-active', { tier: 'personal' });
    assert.equal(paused.status, 200);
    assert.equal((paused.body as { paused: number }).paused, 1);
    const pRow = withDb(app, (db) => db.prepare('SELECT state FROM transfer_jobs WHERE id = ?').get(pJob.jobId) as { state: string });
    assert.equal(pRow.state, 'paused');
    const bRow = withDb(app, (db) => db.prepare('SELECT state FROM transfer_jobs WHERE id = ?').get(bJob.jobId) as { state: string });
    assert.equal(bRow.state, 'queued');

    // paused, NOT cancelled: resume() brings the job back
    const resume = await client.post(`/api/uploads/${pJob.jobId}/resume`);
    assert.equal(resume.status, 200);
    const pRow2 = withDb(app, (db) => db.prepare('SELECT state FROM transfer_jobs WHERE id = ?').get(pJob.jobId) as { state: string });
    assert.equal(pRow2.state, 'running');

    // invalid tier refused honestly
    const bad = await client.post('/api/uploads/pause-active', { tier: 'everything' });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

// ---- share links + dashboard + file detail ----

test('share links, dashboard summary and file detail scope by tier', async () => {
  const { app, client } = await authed();
  try {
    const personal = seedFileWithJob(app, { userId: 'usr_admin', name: 'share-personal.txt', tier: 'personal' });
    const business = seedFileWithJob(app, { userId: 'usr_admin', name: 'share-business.bin', tier: 'business' });
    // one mixed link (both tiers) — visible in both modes with honest counts
    const linkRes = await client.post('/api/share-links', { fileIds: [personal.fileId, business.fileId] });
    assert.equal(linkRes.status, 201, JSON.stringify(linkRes.body));

    const linksPersonal = await client.get('/api/share-links?tier=personal');
    const pLink = (linksPersonal.body as { links: Array<{ id: string; fileCount: number }> }).links[0];
    assert.equal(pLink?.fileCount, 1);
    const linksBusiness = await client.get('/api/share-links?tier=business');
    const bLink = (linksBusiness.body as { links: Array<{ id: string; fileCount: number }> }).links[0];
    assert.equal(bLink?.id, pLink?.id);
    assert.equal(bLink?.fileCount, 1);

    // dashboard summary: the tier scopes file counts and the recent list
    const summaryPersonal = await client.get('/api/dashboard/summary?tier=personal');
    const sBody = summaryPersonal.body as { totalFiles: number; recentFileList: Array<{ originalName: string }> };
    assert.equal(sBody.totalFiles, 1);
    assert.equal(sBody.recentFileList[0]?.originalName, 'share-personal.txt');

    // file detail: the other tier answers the SAME 404 as missing
    const crossTier = await client.get(`/api/files/${business.fileId}?tier=personal`);
    assert.equal(crossTier.status, 404);
    const sameTier = await client.get(`/api/files/${business.fileId}?tier=business`);
    assert.equal(sameTier.status, 200);
  } finally {
    await app.close();
  }
});

// ---- member isolation survives the tier scoping ----

test('member mode filtering keeps the ownership boundary intact', async () => {
  const { app, client } = await authed();
  try {
    const member = await createMember(app, client, 'member-tier@example.com');
    seedFileWithJob(app, { userId: 'usr_admin', name: 'admin-only.txt', tier: 'personal' });
    seedFileWithJob(app, { userId: 'usr_admin', name: 'admin-biz.bin', tier: 'business' });
    // a member-owned personal file (FK: the member row must exist first)
    const memberId = withDb(app, (db) => (db.prepare('SELECT id FROM users WHERE role = ?').get('member') as { id: string }).id);
    seedFileWithJob(app, { userId: memberId, name: 'mine.txt', tier: 'personal' });
    void member;

    const seen = await member.get('/api/files?tier=personal');
    const body = seen.body as { files: Array<{ originalName: string }>; total: number };
    assert.equal(body.total, 1);
    assert.equal(body.files[0]?.originalName, 'mine.txt');
  } finally {
    await app.close();
  }
});
