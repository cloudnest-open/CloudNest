import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { ShareService, ShareError } from '../src/shares/share-service.js';
import { DeletionService } from '../src/deletions/deletion-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';

/** M11.a/b/d — share-link and deletion rules, without any provider access. */

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sh-'));
  const { db, close } = openDatabase(path.join(dir, 't.db'));
  runMigrations(db, allMigrations);
  const store = new CredentialsStore(db, dir);
  const shares = new ShareService(db);
  const deletions = new DeletionService(db, store, shares);
  return { db, close, shares, deletions, dir };
}

function seedFile(db: import('better-sqlite3').Database, id: string, name: string, size = 100, state = 'completed') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO files (id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, manifest_hash, created_at, completed_at)
     VALUES (?, ?, ?, 'text/plain', 100, 1, ?, ?, ?, ?)`,
  ).run(id, name, size, state, 'a'.repeat(64), now, now);
}

const BASE = 'http://127.0.0.1:8787';

test('a created link returns a raw URL exactly once and stores only its hash', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f1', 'report.txt');
    const created = shares.create({ fileIds: ['f1'], baseUrl: BASE });
    assert.ok(created.url.startsWith(`${BASE}/s/`));
    const raw = created.url.slice(`${BASE}/s/`.length);
    assert.ok(raw.length >= 40, 'the token has high entropy');
    const row = db.prepare('SELECT token_hash FROM share_links WHERE id = ?').get(created.id) as { token_hash: string };
    assert.notEqual(row.token_hash, raw, 'the raw token is never stored');
    assert.equal(row.token_hash, crypto.createHash('sha256').update(raw).digest('hex'));
    // the admin listing never exposes a token or a password hash
    const listed = shares.listLinks();
    const serialized = JSON.stringify(listed);
    assert.ok(!serialized.includes(raw));
    assert.ok(!serialized.includes('token_hash'));
    assert.ok(!serialized.includes('password_hash'));
  } finally {
    close();
  }
});

test('only completed files can be shared', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'up', 'partial.bin', 100, 'uploading');
    assert.throws(() => shares.create({ fileIds: ['up'], baseUrl: BASE }),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'file_not_complete');
    assert.throws(() => shares.create({ fileIds: ['nope'], baseUrl: BASE }),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'file_not_found');
    assert.throws(() => shares.create({ fileIds: [], baseUrl: BASE }),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'invalid_share_metadata');
  } finally {
    close();
  }
});

test('the synchronous create path refuses a password instead of ignoring it', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f2', 'secret.txt');
    assert.throws(
      () => shares.create({ fileIds: ['f2'], password: 'a-strong-passphrase-1', baseUrl: BASE }),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'password_requires_async_creation',
      'a password must never be silently dropped',
    );
  } finally {
    close();
  }
});

test('a password-protected link discloses nothing before unlock', async () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f2', 'secret.txt');
    const created = await shares.createWithPassword({ fileIds: ['f2'], password: 'a-strong-passphrase-1', baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    const locked = shares.publicView(raw, false);
    assert.equal(locked.requiresPassword, true);
    assert.deepEqual(locked.files, [], 'no file names leak before authorization');
    const unlocked = shares.publicView(raw, true);
    assert.equal(unlocked.files.length, 1);
    assert.equal(unlocked.files[0]!.name, 'secret.txt');
    void created;
  } finally {
    close();
  }
});

test('an invalid, revoked or expired token is refused', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f3', 'a.txt');
    assert.throws(() => shares.resolve('not-a-real-token'),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_not_found');

    const created = shares.create({ fileIds: ['f3'], baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    assert.doesNotThrow(() => shares.resolve(raw));
    assert.equal(shares.revoke(created.id), true);
    assert.throws(() => shares.resolve(raw),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_revoked');
    assert.equal(shares.revoke(created.id), false, 'an already-revoked link cannot be revoked twice');
  } finally {
    close();
  }
});

test('an expired link is refused and marked expired', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f4', 'a.txt');
    const created = shares.create({ fileIds: ['f4'], expiresAt: new Date(Date.now() - 1000).toISOString(), baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    assert.throws(() => shares.resolve(raw),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_expired');
    const row = db.prepare('SELECT state FROM share_links WHERE id = ?').get(created.id) as { state: string };
    assert.equal(row.state, 'expired');
  } finally {
    close();
  }
});

test('concurrent download starts cannot exceed the link limit', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f5', 'a.txt');
    const created = shares.create({ fileIds: ['f5'], downloadLimit: 3, baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    let granted = 0;
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      try {
        shares.consumeDownloadStart(raw, 'f5');
        granted++;
      } catch (err) {
        if (err instanceof ShareError && err.safeCode === 'share_download_limit_reached') refused++;
        else throw err;
      }
    }
    assert.equal(granted, 3, 'exactly the limit is granted, even with a burst');
    assert.equal(refused, 7);
    const row = db.prepare('SELECT download_count FROM share_links WHERE id = ?').get(created.id) as { download_count: number };
    assert.equal(row.download_count, 3, 'the counter never exceeds the limit');
  } finally {
    close();
  }
});

test('a download session authorizes only its own file and dies with the link', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f6', 'a.txt');
    seedFile(db, 'f7', 'b.txt');
    const created = shares.create({ fileIds: ['f6'], baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    // a file that is not part of the link cannot be authorized
    assert.throws(() => shares.consumeDownloadStart(raw, 'f7'),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'file_not_found');

    const session = shares.consumeDownloadStart(raw, 'f6');
    const auth = shares.authorizeSession(session.sessionToken);
    assert.equal(auth.fileId, 'f6');
    assert.equal(auth.linkId, created.id);

    // revoking the link immediately invalidates outstanding sessions
    shares.revoke(created.id);
    assert.throws(() => shares.authorizeSession(session.sessionToken),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_revoked');
  } finally {
    close();
  }
});

test('an unknown or expired session token is refused', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f8', 'a.txt');
    assert.throws(() => shares.authorizeSession('bogus'),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_not_found');
    const created = shares.create({ fileIds: ['f8'], baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    const session = shares.consumeDownloadStart(raw, 'f8');
    // force-expire the session
    db.prepare('UPDATE share_download_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1000, crypto.createHash('sha256').update(session.sessionToken).digest('hex'));
    assert.throws(() => shares.authorizeSession(session.sessionToken),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_expired');
  } finally {
    close();
  }
});

test('rotation revokes the previous URL and invalidates its sessions', () => {
  const { db, close, shares } = setup();
  try {
    seedFile(db, 'f9', 'a.txt');
    const created = shares.create({ fileIds: ['f9'], baseUrl: BASE });
    const oldRaw = created.url.slice(`${BASE}/s/`.length);
    const session = shares.consumeDownloadStart(oldRaw, 'f9');
    const rotated = shares.rotate(created.id, BASE);
    const newRaw = rotated.url.slice(`${BASE}/s/`.length);
    assert.notEqual(newRaw, oldRaw);
    assert.doesNotThrow(() => shares.resolve(newRaw));
    assert.throws(() => shares.resolve(oldRaw),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_not_found',
      'the old token no longer resolves');
    assert.throws(() => shares.authorizeSession(session.sessionToken),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_revoked');
  } finally {
    close();
  }
});

test('deleting a file revokes its links first', () => {
  const { db, close, shares, deletions } = setup();
  try {
    seedFile(db, 'f10', 'a.txt');
    const created = shares.create({ fileIds: ['f10'], baseUrl: BASE });
    const raw = created.url.slice(`${BASE}/s/`.length);
    const queued = deletions.enqueue('f10');
    assert.ok(queued.jobId);
    assert.throws(() => shares.resolve(raw),
      (e: unknown) => e instanceof ShareError && e.safeCode === 'share_revoked',
      'a link must not outlive the file it points at');
    const file = db.prepare('SELECT state FROM files WHERE id = ?').get('f10') as { state: string };
    assert.equal(file.state, 'deletion_pending');
  } finally {
    close();
  }
});

test('deletion of a file with no placements completes cleanly', async () => {
  const { db, close, shares, deletions } = setup();
  try {
    seedFile(db, 'f11', 'a.txt');
    const queued = deletions.enqueue('f11');
    const result = await deletions.process(queued.jobId);
    assert.equal(result.state, 'completed');
    const file = db.prepare('SELECT state FROM files WHERE id = ?').get('f11') as { state: string };
    assert.equal(file.state, 'deleted');
    assert.equal(deletions.pendingJobs().length, 0);
    void shares;
  } finally {
    close();
  }
});

test('a placement with no remote object id keeps the deletion pending, never claimed clean', async () => {
  const { db, close, shares, deletions } = setup();
  try {
    seedFile(db, 'f12', 'a.bin');
    // create a chunk + placement whose remote id was never learned
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
       VALUES ('acc-x','google_drive','a','i','connected',1000,0,'current',0,0,?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
       VALUES ('ch-x','f12',0,0,100,?,'uploaded',?,?)`,
    ).run('b'.repeat(64), now, now);
    db.prepare(
      `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, remote_object_key, state, is_active, created_at, updated_at)
       VALUES ('pl-x','ch-x','acc-x',NULL,'cn-key','verified',1,?,?)`,
    ).run(now, now);

    const queued = deletions.enqueue('f12');
    const result = await deletions.process(queued.jobId);
    assert.equal(result.state, 'deletion_pending', 'an unaccounted object blocks a clean finish');
    assert.ok(result.pending >= 1);
    const file = db.prepare('SELECT state FROM files WHERE id = ?').get('f12') as { state: string };
    assert.equal(file.state, 'deletion_pending');
    assert.equal(deletions.pendingJobs().length, 1, 'the obligation stays recorded');
    // retrying is possible and does not claim success either
    const retried = await deletions.retry(queued.jobId);
    assert.equal(retried.state, 'deletion_pending');
    void shares;
  } finally {
    close();
  }
});

test('a completed deletion cannot be retried and reports its attempts', async () => {
  const { db, close, deletions } = setup();
  try {
    seedFile(db, 'f13', 'a.txt');
    const queued = deletions.enqueue('f13');
    await deletions.process(queued.jobId);
    await assert.rejects(() => deletions.retry(queued.jobId),
      (e: unknown) => e instanceof ShareError || (e as { safeCode?: string }).safeCode === 'job_already_completed');
    const status = deletions.jobStatus(queued.jobId);
    assert.equal(status?.state, 'completed');
  } finally {
    close();
  }
});

test('startup recovery surfaces pending deletions instead of forgetting them', async () => {
  const { db, close, deletions } = setup();
  try {
    seedFile(db, 'f14', 'a.txt');
    const queued = deletions.enqueue('f14');
    // simulate a crash mid-deletion
    db.prepare("UPDATE transfer_jobs SET state = 'running' WHERE id = ?").run(queued.jobId);
    const resumed = await deletions.resumePending();
    assert.equal(resumed.attempted, 1);
    assert.equal(resumed.completed, 1, 'a clean deletion is finished on recovery');
    const file = db.prepare('SELECT state FROM files WHERE id = ?').get('f14') as { state: string };
    assert.equal(file.state, 'deleted');
  } finally {
    close();
  }
});
