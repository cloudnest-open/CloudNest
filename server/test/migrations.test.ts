import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { REQUIRED_PRAGMAS } from '../src/db/index.js';

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cn-mig-')), 't.db');
}

/**
 * A delegating stand-in for the database that executes every statement for
 * real and then throws once `killerSql` has run — simulating a process crash
 * exactly there (statements before it applied, nothing after).
 */
function crashAfterExec(db: Database.Database, killerSql: string): Database.Database {
  const realExec = db.exec.bind(db);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          realExec(sql);
          if (sql === killerSql) throw new Error('SIMULATED CRASH');
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Database.Database;
}

test('migrates a fresh DB to the latest schema; safe on second startup', () => {
  const p = tempDb();
  const first = openDatabase(p);
  try {
    const applied = runMigrations(first.db, allMigrations);
    assert.equal(applied.length, allMigrations.length);
    const tables = (
      first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const expected of [
      'schema_migrations', 'admin_users', 'sessions', 'app_settings', 'provider_accounts',
      'files', 'file_chunks', 'chunk_placements', 'transfer_jobs', 'share_links',
      'share_link_items', 'audit_events',
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    // second startup: nothing re-applied
    const again = runMigrations(first.db, allMigrations);
    assert.equal(again.length, 0);
  } finally {
    first.close();
  }
  const second = openDatabase(p);
  try {
    const again = runMigrations(second.db, allMigrations);
    assert.equal(again.length, 0);
  } finally {
    second.close();
  }
});

test('WAL and durability pragmas hold during migrations', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations);
    assert.equal((db.pragma('journal_mode', { simple: true }) as string).toLowerCase(), REQUIRED_PRAGMAS.journalMode);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('synchronous', { simple: true }), REQUIRED_PRAGMAS.synchronous);
    assert.equal(db.pragma('busy_timeout', { simple: true }), REQUIRED_PRAGMAS.busyTimeout);
  } finally {
    close();
  }
});

test('enumerated values are constrained in SQLite', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations);
    const now = new Date().toISOString();
    const uuid = () => crypto.randomUUID();

    // provider enum
    assert.throws(() =>
      db.prepare(`INSERT INTO provider_accounts (id, provider, display_label, status, created_at, updated_at)
        VALUES (?, 'bogus', 'x', 'connected', ?, ?)`).run(uuid(), now, now));
    db.prepare(`INSERT INTO provider_accounts (id, provider, display_label, status, created_at, updated_at)
      VALUES (?, 'google_drive', 'x', 'connected', ?, ?)`).run(uuid(), now, now);
    assert.throws(() =>
      db.prepare(`UPDATE provider_accounts SET status='broken'`).run());

    // negative quota rejected
    assert.throws(() =>
      db.prepare(`UPDATE provider_accounts SET quota_total_bytes = -5`).run());

    // file state enum + negative size
    const fileId = uuid();
    db.prepare(`INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, created_at)
      VALUES (?, 'usr_admin', 'a.txt', 10, 5, 2, 'completed', ?)`).run(fileId, now);
    assert.throws(() => db.prepare(`UPDATE files SET size_bytes = -1`).run());
    assert.throws(() => db.prepare(`UPDATE files SET state = 'bogus'`).run());
    assert.throws(() => db.prepare(`UPDATE files SET chunk_size_bytes = 0`).run());

    // file_chunks: unique (file_id, chunk_index), FK, negative checks
    const chunkId = uuid();
    db.prepare(`INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
      VALUES (?, ?, 0, 0, 10, 'abc', 'uploaded', ?, ?)`).run(chunkId, fileId, now, now);
    assert.throws(() =>
      db.prepare(`INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
        VALUES (?, ?, 0, 0, 10, 'abc', 'uploaded', ?, ?)`).run(uuid(), fileId, now, now));
    assert.throws(() =>
      db.prepare(`INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
        VALUES (?, ?, 1, -1, 10, 'abc', 'uploaded', ?, ?)`).run(uuid(), fileId, now, now));

    // placements: one active per chunk (partial unique index)
    const accountId = (
      db.prepare('SELECT id FROM provider_accounts LIMIT 1').get() as { id: string }
    ).id;
    // canonical placement state (migration v7 widened these to the Step-4 set)
    const place = db.prepare(`INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'verified', 1, ?, ?)`);
    place.run(uuid(), chunkId, accountId, 'obj-1', now, now);
    assert.throws(() => place.run(uuid(), chunkId, accountId, 'obj-2', now, now));
    // inactive duplicates allowed
    // an inactive duplicate is allowed (cleanup history is preserved)
    db.prepare(`INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'obj-2', 'deleted', 0, ?, ?)`).run(uuid(), chunkId, accountId, now, now);
    // a non-canonical state is still rejected by the CHECK constraint
    assert.throws(() =>
      db.prepare(`INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, state, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 'obj-3', 'inactive', 0, ?, ?)`).run(uuid(), chunkId, accountId, now, now));

    // FK enforcement: deleting a referenced file/account/chunk is blocked
    assert.throws(() => db.prepare('DELETE FROM files WHERE id = ?').run(fileId));
    assert.throws(() => db.prepare('DELETE FROM file_chunks WHERE id = ?').run(chunkId));
    assert.throws(() => db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(accountId));

    // transfer_jobs: file_id NULL only for reconcile
    assert.throws(() =>
      db.prepare(`INSERT INTO transfer_jobs (id, job_type, state, created_at, updated_at)
        VALUES (?, 'upload', 'queued', ?, ?)`).run(uuid(), now, now));
    db.prepare(`INSERT INTO transfer_jobs (id, job_type, state, created_at, updated_at)
      VALUES (?, 'reconcile', 'queued', ?, ?)`).run(uuid(), now, now);

    // share link download_count non-negative
    const linkId = uuid();
    db.prepare(`INSERT INTO share_links (id, token_hash, state, created_at, updated_at)
      VALUES (?, 'hash1', 'active', ?, ?)`).run(linkId, now, now);
    assert.throws(() => db.prepare('UPDATE share_links SET download_count = -1').run());
  } finally {
    close();
  }
});

test('no fake rows are seeded', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations);
    for (const table of ['admin_users', 'provider_accounts', 'files', 'file_chunks', 'chunk_placements', 'transfer_jobs', 'share_links']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(row.n, 0, `${table} should be empty`);
    }
  } finally {
    close();
  }
});

test('M0012 resume: a crash after the parent DROP keeps the data and completes on re-run', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations.filter((m) => m.version <= 11));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, status, created_at, updated_at)
       VALUES ('acc-crash', 'google_drive', 'survived', 'connected', ?, ?)`,
    ).run(now, now);

    // simulate a process crash inside M0012: run its up() for real and kill it
    // right after the parent DROP — the populated staging table is then the
    // only copy of the account rows
    const m0012 = allMigrations.find((m) => m.version === 12)!;
    assert.throws(
      () => m0012.up(crashAfterExec(db, 'DROP TABLE provider_accounts;')),
      /SIMULATED CRASH/,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM provider_accounts_new').get() as { n: number }).n,
      1,
    );

    // re-run the real runner: M0012 must resume from staging, not destroy it
    runMigrations(db, allMigrations);
    const row = db.prepare('SELECT display_label, tier FROM provider_accounts WHERE id = ?').get('acc-crash') as {
      display_label: string;
      tier: string;
    };
    assert.equal(row.display_label, 'survived');
    assert.equal(row.tier, 'personal');
    const applied = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    ).map((r) => r.version);
    assert.deepEqual(applied, allMigrations.map((m) => m.version));
  } finally {
    close();
  }
});

test('M0015 resume: a crash after the parent DROP keeps the job rows and completes on re-run', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations.filter((m) => m.version <= 14));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO transfer_jobs (id, job_type, state, created_at, updated_at)
       VALUES ('job-crash', 'reconcile', 'completed', ?, ?)`,
    ).run(now, now);

    const m0015 = allMigrations.find((m) => m.version === 15)!;
    assert.throws(
      () => m0015.up(crashAfterExec(db, 'DROP TABLE transfer_jobs;')),
      /SIMULATED CRASH/,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM transfer_jobs_new').get() as { n: number }).n,
      1,
    );

    runMigrations(db, allMigrations);
    const row = db.prepare('SELECT job_type, state FROM transfer_jobs WHERE id = ?').get('job-crash') as {
      job_type: string;
      state: string;
    };
    assert.equal(row.job_type, 'reconcile');
    assert.equal(row.state, 'completed');
    const applied = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    ).map((r) => r.version);
    assert.deepEqual(applied, allMigrations.map((m) => m.version));
  } finally {
    close();
  }
});

test('transfer_jobs.job_type is indexed for the dashboard job list', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT j.* FROM transfer_jobs j JOIN files f ON f.id = j.file_id
         WHERE j.job_type = 'upload' AND f.user_id = ? ORDER BY j.created_at DESC LIMIT ?`,
      )
      .all('usr_admin', 50) as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join(' | ');
    assert.match(details, /idx_transfer_jobs_type/, `expected the job_type index in the plan, got: ${details}`);
  } finally {
    close();
  }
});
