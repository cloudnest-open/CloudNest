import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp, Client } from './helpers.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { UserService, UserError } from '../src/users/user-service.js';

/**
 * Roadmap Phase 3 — multi-user foundation over the real HTTP API:
 * M0013 schema (users/user_tokens, files.user_id, share_links.created_by),
 * invite → accept → member login, per-user allowance in plan(), ownership
 * isolation between members, admin-surface guards, disable/reset lifecycles.
 * No real provider is touched: capacity comes from a seeded fake account row.
 */

const PASSWORD = 'test-access-code-123';
const GB = 1024 * 1024 * 1024;

function seedAccount(db: TestApp['db'], opts: { id: string; total: number }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
     VALUES (?, 'dropbox', 'Fake pool', 'ident-fake', 'connected', ?, 0, 'current', 0, 0, ?, ?)`,
  ).run(opts.id, opts.total, now, now);
}

function seedFile(db: TestApp['db'], opts: { userId: string; name: string; sizeBytes: number }): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
     VALUES (?, ?, ?, ?, 8388608, 0, 'completed', 'personal', ?)`,
  ).run(id, opts.userId, opts.name, opts.sizeBytes, new Date().toISOString());
  return id;
}

function seedUploadJob(db: TestApp['db'], fileId: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO transfer_jobs (id, file_id, job_type, state, chunks_completed, chunks_total, bytes_completed,
      retry_count, created_at, updated_at)
     VALUES (?, ?, 'upload', 'completed', 0, 0, 0, 0, ?, ?)`,
  ).run(id, fileId, now, now);
  return id;
}

/** Invite + accept + login one member over the real HTTP surface. */
async function createMember(
  admin: Client,
  app: TestApp,
  email: string,
  password: string,
  opts: { allowanceBytes?: number | null } = {},
): Promise<{ client: Client; userId: string }> {
  const invited = await admin.post('/api/users', {
    email,
    displayName: email.split('@')[0] ?? email,
    role: 'member',
    allowanceBytes: opts.allowanceBytes ?? null,
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const { user, acceptUrl } = invited.body as { user: { id: string }; acceptUrl: string };
  const token = new URL(acceptUrl).searchParams.get('token') ?? '';
  assert.ok(token.length > 20, 'the accept URL carries a real token');
  const claimer = new Client(app.url);
  const claimed = await claimer.post('/api/auth/accept-invite', { token, password, confirm: password });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const client = new Client(app.url);
  const login = await client.send('POST', '/api/auth/login', { username: email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { client, userId: user.id };
}

test('M0013 rebuilds files with an owner column and backfills the built-in admin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-m13-'));
  try {
    const { db, close } = openDatabase(path.join(dir, 't.db'));
    // apply history up to M0012, insert pre-multi-user data, then upgrade
    runMigrations(db, allMigrations.filter((m) => m.version <= 12));
    db.prepare(
      `INSERT INTO files (id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, tier, created_at)
       VALUES ('f-old', 'legacy.bin', 12, 8388608, 0, 'completed', 'personal', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO share_links (id, token_hash, state, created_at, updated_at)
       VALUES ('sl-old', 'deadbeef', 'active', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    runMigrations(db, allMigrations);

    const admin = db.prepare("SELECT id, role, status FROM users WHERE email = 'admin'").get() as
      | { id: string; role: string; status: string }
      | undefined;
    assert.ok(admin, 'the built-in admin attribution row exists');
    assert.equal(admin!.id, 'usr_admin');
    assert.equal(admin!.role, 'admin');
    assert.equal(admin!.status, 'active');
    const file = db.prepare('SELECT user_id FROM files WHERE id = ?').get('f-old') as { user_id: string };
    assert.equal(file.user_id, 'usr_admin', 'pre-existing files belong to the built-in admin');
    const link = db.prepare('SELECT created_by FROM share_links WHERE id = ?').get('sl-old') as { created_by: string };
    assert.equal(link.created_by, 'usr_admin', 'pre-existing links belong to the built-in admin');
    const violations = db.pragma('foreign_key_check', { simple: true });
    assert.ok(!violations, 'foreign_key_check is clean after M0013');
    close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invite → accept → member login → member me, with single-use tokens', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);

    const { client: member, userId } = await createMember(admin, app, 'rahim@example.com', 'member passphrase here');

    const me = await member.get('/api/auth/me');
    assert.equal(me.status, 200);
    const meBody = me.body as { authenticated: boolean; kind: string; role: string; email?: string };
    assert.equal(meBody.authenticated, true);
    assert.equal(meBody.kind, 'user');
    assert.equal(meBody.role, 'member');
    assert.equal(meBody.email, 'rahim@example.com');

    const adminList = await admin.get('/api/users');
    assert.equal(adminList.status, 200);
    const users = (adminList.body as { users: Array<{ id: string; email: string; status: string }> }).users;
    const invited = users.find((u) => u.id === userId);
    assert.ok(invited);
    assert.equal(invited!.status, 'active');

    // duplicate email refuses
    const dup = await admin.post('/api/users', { email: 'rahim@example.com', displayName: 'x', role: 'member', allowanceBytes: null });
    assert.equal(dup.status, 409);
    assert.equal((dup.body as { code?: string }).code, 'email_already_exists');

    // an expired token refuses
    app.db.prepare(
      `INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_at)
       VALUES ('expired-hash', ?, 'password_reset', ?, ?)`,
    ).run(userId, Date.now() - 1000, new Date().toISOString());
    const stale = new Client(app.url);
    const staleClaim = await stale.post('/api/auth/accept-invite', { token: 'expired-hash', password: 'whatever passphrase', confirm: 'whatever passphrase' });
    assert.equal(staleClaim.status, 400);
  } finally {
    await app.close();
  }
});

test('per-user allowance is enforced in plan(), independently of pool capacity', async () => {
  const app = await startTestApp();
  try {
    seedAccount(app.db, { id: 'acc-big', total: 100 * GB });
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { client: member, userId } = await createMember(admin, app, 'quota@example.com', 'member passphrase here', { allowanceBytes: GB });

    // over the allowance: refused with the honest detail, pool still half empty
    const tooBig = await member.post('/api/uploads/plan', {
      originalName: 'big.bin', sizeBytes: 2 * GB, chunkSizeMiB: 8,
    }, { 'idempotency-key': 'allowance-1' });
    assert.equal(tooBig.status, 403, JSON.stringify(tooBig.body));
    assert.equal((tooBig.body as { code?: string }).code, 'allowance_exceeded');
    assert.equal((tooBig.body as { allowanceBytes?: number }).allowanceBytes, GB);

    // inside the allowance: planned and OWNED by the member
    const ok = await member.post('/api/uploads/plan', {
      originalName: 'small.bin', sizeBytes: 512 * 1024 * 1024, chunkSizeMiB: 8,
    }, { 'idempotency-key': 'allowance-2' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const fileId = (ok.body as { fileId: string }).fileId;
    const owner = app.db.prepare('SELECT user_id FROM files WHERE id = ?').get(fileId) as { user_id: string };
    assert.equal(owner.user_id, userId);

    // usage now blocks a second full-allowance file: 512 MiB used, 1 GiB cap
    const second = await member.post('/api/uploads/plan', {
      originalName: 'more.bin', sizeBytes: GB, chunkSizeMiB: 8,
    }, { 'idempotency-key': 'allowance-3' });
    assert.equal(second.status, 403);
    assert.equal((second.body as { usedBytes?: number }).usedBytes, 512 * 1024 * 1024);
  } finally {
    await app.close();
  }
});

test('members see and touch only their own files and jobs; admin sees everything', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const a = await createMember(admin, app, 'a@example.com', 'member passphrase here');
    const b = await createMember(admin, app, 'b@example.com', 'member passphrase here');

    const adminFile = seedFile(app.db, { userId: 'usr_admin', name: 'admin.bin', sizeBytes: 10 });
    const bFile = seedFile(app.db, { userId: b.userId, name: 'b.bin', sizeBytes: 20 });
    const bJob = seedUploadJob(app.db, bFile);

    // a member's listing is their own library only
    const list = await a.client.get('/api/files');
    assert.equal(list.status, 200);
    const names = (list.body as { files: Array<{ originalName: string }> }).files.map((f) => f.originalName);
    assert.deepEqual(names, []);

    // a foreign file is indistinguishable from a missing one
    const foreignDetails = await a.client.get(`/api/files/${bFile}`);
    assert.equal(foreignDetails.status, 404);
    const foreignDownload = await a.client.get(`/api/files/${bFile}/download`);
    assert.equal(foreignDownload.status, 404);
    const foreignDelete = await a.client.send('DELETE', `/api/files/${bFile}`);
    assert.equal(foreignDelete.status, 404);
    const foreignJob = await a.client.get(`/api/uploads/${bJob}`);
    assert.equal(foreignJob.status, 404);
    const foreignJobAction = await a.client.post(`/api/uploads/${bJob}/pause`);
    assert.equal(foreignJobAction.status, 404);

    // the admin sees and manages everything
    const adminList = await admin.get('/api/files');
    const adminNames = (adminList.body as { files: Array<{ originalName: string }> }).files.map((f) => f.originalName).sort();
    assert.deepEqual(adminNames, ['admin.bin', 'b.bin']);
    const adminJob = await admin.get(`/api/uploads/${bJob}`);
    assert.equal(adminJob.status, 200);
  } finally {
    await app.close();
  }
});

test('admin surfaces stay admin-only and unauthenticated requests stay 401', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { client: member } = await createMember(admin, app, 'm@example.com', 'member passphrase here');

    const users = await member.get('/api/users');
    assert.equal(users.status, 403);
    const invite = await member.post('/api/users', { email: 'x@example.com', displayName: 'x', role: 'member', allowanceBytes: null });
    assert.equal(invite.status, 403);
    const accounts = await member.get('/api/provider-accounts');
    assert.equal(accounts.status, 403);
    const settings = await member.get('/api/settings');
    assert.equal(settings.status, 403);

    const anonymous = new Client(app.url);
    const anonFiles = await anonymous.get('/api/files');
    assert.equal(anonFiles.status, 401);
    const anonUsers = await anonymous.get('/api/users');
    assert.equal(anonUsers.status, 401);
  } finally {
    await app.close();
  }
});

test('disable kicks the live session and blocks login; enable restores it', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { client: member, userId } = await createMember(admin, app, 'd@example.com', 'member passphrase here');
    assert.equal((await member.get('/api/files')).status, 200);

    const disabled = await admin.patch(`/api/users/${userId}`, { status: 'disabled' });
    assert.equal(disabled.status, 200);

    // the old session is dead and the credentials no longer log in
    assert.equal((await member.get('/api/files')).status, 401);
    const relogin = new Client(app.url);
    const blocked = await relogin.send('POST', '/api/auth/login', { username: 'd@example.com', password: 'member passphrase here' });
    assert.equal(blocked.status, 401);

    const enabled = await admin.patch(`/api/users/${userId}`, { status: 'active' });
    assert.equal(enabled.status, 200);
    const again = new Client(app.url);
    const ok = await again.send('POST', '/api/auth/login', { username: 'd@example.com', password: 'member passphrase here' });
    assert.equal(ok.status, 200);
    assert.equal((await again.get('/api/files')).status, 200);
  } finally {
    await app.close();
  }
});

test('password reset replaces the password and invalidates old sessions', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { client: member, userId } = await createMember(admin, app, 'r@example.com', 'member passphrase here');

    const issued = await admin.post(`/api/users/${userId}/password-reset`);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const resetUrl = (issued.body as { resetUrl: string }).resetUrl;
    const token = new URL(resetUrl).searchParams.get('token') ?? '';

    const claimer = new Client(app.url);
    const claimed = await claimer.post('/api/auth/accept-invite', { token, password: 'brand new passphrase', confirm: 'brand new passphrase' });
    assert.equal(claimed.status, 200);

    // the token is single-use
    const reuse = await claimer.post('/api/auth/accept-invite', { token, password: 'another passphrase here', confirm: 'another passphrase here' });
    assert.equal(reuse.status, 400);

    // the old password no longer works; the new one does
    const oldLogin = new Client(app.url);
    const oldTry = await oldLogin.send('POST', '/api/auth/login', { username: 'r@example.com', password: 'member passphrase here' });
    assert.equal(oldTry.status, 401);
    const newLogin = new Client(app.url);
    const newTry = await newLogin.send('POST', '/api/auth/login', { username: 'r@example.com', password: 'brand new passphrase' });
    assert.equal(newTry.status, 200);
    // and the member's old session (pre-reset) was invalidated by the bump
    assert.equal((await member.get('/api/files')).status, 401);
  } finally {
    await app.close();
  }
});

test('the built-in admin is immutable and users with files cannot be deleted', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { userId } = await createMember(admin, app, 'del@example.com', 'member passphrase here');

    const immutable = await admin.patch('/api/users/usr_admin', { status: 'disabled' });
    assert.equal(immutable.status, 409);
    assert.equal((immutable.body as { code?: string }).code, 'user_admin_immutable');
    const removeAdmin = await admin.send('DELETE', '/api/users/usr_admin');
    assert.equal(removeAdmin.status, 409);

    seedFile(app.db, { userId, name: 'owned.bin', sizeBytes: 5 });
    const withFiles = await admin.send('DELETE', `/api/users/${userId}`);
    assert.equal(withFiles.status, 409);
    assert.equal((withFiles.body as { code?: string }).code, 'user_has_files');

    // a user with no files can be removed, and then cannot log in
    const { userId: freshId } = await createMember(admin, app, 'fresh@example.com', 'member passphrase here');
    const removed = await admin.send('DELETE', `/api/users/${freshId}`);
    assert.equal(removed.status, 200);
    const removedLogin = new Client(app.url);
    const after = await removedLogin.send('POST', '/api/auth/login', { username: 'fresh@example.com', password: 'member passphrase here' });
    assert.equal(after.status, 401);
  } finally {
    await app.close();
  }
});

test('a member changing their own password keeps working sessions consistent', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { client: member } = await createMember(admin, app, 'cp@example.com', 'member passphrase here');

    const changed = await member.post('/api/auth/change-password', {
      currentPassword: 'member passphrase here', newPassword: 'rotated passphrase now', confirmNew: 'rotated passphrase now',
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    // the current session was regenerated and still works
    assert.equal((await member.get('/api/files')).status, 200);
    // the old password is gone; the new one signs in
    const oldTry = new Client(app.url);
    assert.equal((await oldTry.send('POST', '/api/auth/login', { username: 'cp@example.com', password: 'member passphrase here' })).status, 401);
    const newTry = new Client(app.url);
    assert.equal((await newTry.send('POST', '/api/auth/login', { username: 'cp@example.com', password: 'rotated passphrase now' })).status, 200);
  } finally {
    await app.close();
  }
});

test('share links record their creator and a member lists only their own', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const { client: member, userId } = await createMember(admin, app, 's@example.com', 'member passphrase here');

    const mine = seedFile(app.db, { userId, name: 'mine.bin', sizeBytes: 30 });
    const foreign = seedFile(app.db, { userId: 'usr_admin', name: 'theirs.bin', sizeBytes: 40 });

    // a member sharing a foreign file gets the same 404 as a missing file
    const foreignShare = await member.post('/api/share-links', { fileIds: [foreign] });
    assert.equal(foreignShare.status, 404);

    const created = await member.post('/api/share-links', { fileIds: [mine] });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // the member sees only their own link; the admin sees everything
    const memberLinks = await member.get('/api/share-links');
    const memberIds = (memberLinks.body as { links: Array<{ id: string }> }).links.map((l) => l.id);
    assert.deepEqual(memberIds, [(created.body as { id: string }).id]);
    const adminLinks = await admin.get('/api/share-links');
    assert.equal((adminLinks.body as { links: Array<{ id: string }> }).links.length >= 1, true);
    const stored = app.db.prepare('SELECT created_by FROM share_links WHERE id = ?')
      .get((created.body as { id: string }).id) as { created_by: string };
    assert.equal(stored.created_by, userId);
  } finally {
    await app.close();
  }
});

test('a failed token claim is audited with its safe code', async () => {
  const app = await startTestApp();
  try {
    const anonymous = new Client(app.url);
    const claim = await anonymous.post('/api/auth/accept-invite', { token: 'no-such-token', password: 'whatever passphrase', confirm: 'whatever passphrase' });
    assert.equal(claim.status, 400);
    assert.equal((claim.body as { code?: string }).code, 'token_invalid');

    const row = app.db.prepare(
      "SELECT success, reason_code FROM audit_events WHERE event_type = 'user_token_claimed' AND success = 0 ORDER BY created_at DESC LIMIT 1",
    ).get() as { success: number; reason_code: string } | undefined;
    assert.ok(row, 'the failed claim is audited');
    assert.equal(row!.reason_code, 'token_invalid');
  } finally {
    await app.close();
  }
});

test('an invite that loses the email race returns 409, not a 500', async () => {
  const app = await startTestApp();
  try {
    const admin = new Client(app.url);
    await admin.setup(PASSWORD);
    const svc = new UserService(app.db);
    svc.inviteUser({ email: 'race@example.com', displayName: 'first', role: 'member', allowanceBytes: null, baseUrl: app.url });

    // simulate the concurrent invite: its pre-check ran before the first
    // insert committed, so it misses the duplicate and only the UNIQUE
    // constraint on users.email can stop it
    const q = (svc as unknown as { q: { getUserByEmail: { get: (email: string) => unknown } } }).q;
    const original = q.getUserByEmail;
    q.getUserByEmail = { get: () => undefined };
    try {
      assert.throws(
        () => svc.inviteUser({ email: 'race@example.com', displayName: 'second', role: 'member', allowanceBytes: null, baseUrl: app.url }),
        (err: unknown) => err instanceof UserError && (err as UserError).safeCode === 'email_already_exists' && (err as UserError).httpStatus === 409,
      );
    } finally {
      q.getUserByEmail = original;
    }
  } finally {
    await app.close();
  }
});
