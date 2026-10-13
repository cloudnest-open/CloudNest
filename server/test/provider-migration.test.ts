import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cn-pmig-')), 't.db');
}

test('provider migration creates provider_app_configs and canonical statuses', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    const applied = runMigrations(db, allMigrations);
    assert.equal(applied.length, allMigrations.length);
    const cols = (db.prepare('PRAGMA table_info(provider_accounts)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['quota_status', 'last_quota_error_code', 'last_quota_error_at', 'last_error_code', 'last_error_at']) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
    const cfgCols = (db.prepare('PRAGMA table_info(provider_app_configs)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['provider', 'config_ciphertext', 'config_nonce', 'config_auth_tag', 'config_key_version', 'verification_status', 'last_verified_at']) {
      assert.ok(cfgCols.includes(c), `missing ${c}`);
    }
  } finally {
    close();
  }
});

test('canonical account states only', () => {
  const { db, close } = openDatabase(tempDb());
  try {
    runMigrations(db, allMigrations);
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(crypto.randomUUID(), 'google_drive', 'a', 'connected', now, now);
    insert.run(crypto.randomUUID(), 'dropbox', 'b', 'needs_reauth', now, now);
    insert.run(crypto.randomUUID(), 'pcloud', 'c', 'disconnected', now, now);
    insert.run(crypto.randomUUID(), 'onedrive', 'd', 'error', now, now);
    assert.throws(() => insert.run(crypto.randomUUID(), 'mega', 'e', 'reauth_required', now, now));
    assert.throws(() => insert.run(crypto.randomUUID(), 'bogus', 'f', 'connected', now, now));
    // duplicate identity is prevented
    db.prepare(`UPDATE provider_accounts SET account_identifier = 'same-id' WHERE display_label = 'a'`).run();
    assert.throws(() =>
      db.prepare(`INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, created_at, updated_at)
        VALUES (?, 'google_drive', 'dup', 'same-id', 'connected', ?, ?)`).run(crypto.randomUUID(), now, now));
    // quota_status constrained
    assert.throws(() => db.prepare(`UPDATE provider_accounts SET quota_status = 'bogus'`).run());
    const fk = db.pragma('foreign_key_check');
    assert.deepEqual(fk, []);
  } finally {
    close();
  }
});

test('repeat startup is safe and existing data is preserved through the rebuild', () => {
  const p = tempDb();
  const first = openDatabase(p);
  try {
    runMigrations(first.db, allMigrations);
    const now = new Date().toISOString();
    first.db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, created_at, updated_at)
       VALUES ('keep-me', 'mega', 'preserved', 'mega-1', 'connected', ?, ?)`,
    ).run(now, now);
  } finally {
    first.close();
  }
  const second = openDatabase(p);
  try {
    const again = runMigrations(second.db, allMigrations);
    assert.equal(again.length, 0, 'no migration re-applied on second startup');
    const row = second.db.prepare("SELECT display_label, provider FROM provider_accounts WHERE id = 'keep-me'").get() as { display_label: string; provider: string };
    assert.equal(row.display_label, 'preserved');
    assert.equal(row.provider, 'mega');
  } finally {
    second.close();
  }
});
