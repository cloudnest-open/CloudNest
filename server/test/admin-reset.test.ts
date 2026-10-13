import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';

const run = promisify(execFile);
const GOOD = 'correct horse battery staple';

test('reset removes only admin + sessions; preserves non-auth metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-reset-'));
  const dbPath = path.join(dir, 'cloudnest.db');
  const { db, close } = openDatabase(dbPath);
  try {
    runMigrations(db, allMigrations);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO admin_users (id, username, password_hash, password_changed_at, created_at, updated_at, auth_version)
       VALUES (1, 'admin', 'scrypt$131072$8$1$abc$def', ?, ?, ?, 3)`,
    ).run(now, now, now);
    db.prepare('INSERT INTO sessions (sid_hash, session_json, expires_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('hash', '{}', Date.now() + 1000, now);
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, status, created_at, updated_at)
       VALUES (?, 'mega', 'kept', 'connected', ?, ?)`,
    ).run(crypto.randomUUID(), now, now);
    db.prepare(
      `INSERT INTO files (id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, created_at)
       VALUES (?, 'keep.txt', 1, 1, 1, 'completed', ?)`,
    ).run(crypto.randomUUID(), now);
    db.prepare(
      `INSERT INTO audit_events (id, created_at, event_type, success, reason_code) VALUES (?, ?, 'login', 1, 'success')`,
    ).run(crypto.randomUUID(), now);
  } finally {
    close();
  }

  // run the built reset script with DATA_DIR pointing at the temp dir
  const script = path.resolve('dist/server/scripts/reset-admin.js');
  if (!fs.existsSync(script)) {
    console.log('  (skipping: run npm run build first for the built reset script)');
    return;
  }
  await run('node', [script], {
    env: { ...process.env, DATA_DIR: dir },
    input: 'RESET CLOUDNEST ADMIN\n',
    encoding: 'utf8',
  } as never);

  const reopened = openDatabase(dbPath);
  try {
    const admin = reopened.db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number };
    const sessions = reopened.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    const accounts = reopened.db.prepare('SELECT COUNT(*) AS n FROM provider_accounts').get() as { n: number };
    const files = reopened.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    const audit = reopened.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number };
    assert.equal(admin.n, 0, 'admin removed');
    assert.equal(sessions.n, 0, 'sessions removed');
    assert.equal(accounts.n, 1, 'provider account preserved');
    assert.equal(files.n, 1, 'file preserved');
    assert.equal(audit.n, 1, 'audit events preserved');
  } finally {
    reopened.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reset aborts without the confirmation phrase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-reset-'));
  const dbPath = path.join(dir, 'cloudnest.db');
  const { db, close } = openDatabase(dbPath);
  try {
    runMigrations(db, allMigrations);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO admin_users (id, username, password_hash, password_changed_at, created_at, updated_at, auth_version)
       VALUES (1, 'admin', 'x', ?, ?, ?, 1)`,
    ).run(now, now, now);
  } finally {
    close();
  }
  const script = path.resolve('dist/server/scripts/reset-admin.js');
  if (!fs.existsSync(script)) return;
  await run('node', [script], {
    env: { ...process.env, DATA_DIR: dir },
    input: 'nope\n',
    encoding: 'utf8',
  } as never).catch(() => {});
  const reopened = openDatabase(dbPath);
  try {
    const admin = reopened.db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number };
    assert.equal(admin.n, 1, 'admin untouched without confirmation');
  } finally {
    reopened.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
