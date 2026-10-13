import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  runMigrations,
  verifyPragmas,
} from '../src/db/index.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cloudnest-db-')), 'test.db');
}

test('opens with WAL, foreign_keys, synchronous=FULL, busy_timeout=5000', () => {
  const { db, close } = openDatabase(tempDbPath());
  try {
    assert.equal(
      (db.pragma('journal_mode', { simple: true }) as string).toLowerCase(),
      'wal',
    );
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    close();
  }
});

test('migrations run transactionally and are recorded once', () => {
  const dbPath = tempDbPath();
  const first = openDatabase(dbPath);
  try {
    const applied = runMigrations(first.db, [
      {
        version: 1,
        name: 'test-migration',
        up: (db) => {
          db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY)');
        },
      },
    ]);
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.version, 1);

    // second run: nothing re-applied
    const again = runMigrations(first.db, [
      { version: 1, name: 'test-migration', up: () => {} },
    ]);
    assert.equal(again.length, 0);
    verifyPragmas(first.db);
  } finally {
    first.close();
  }

  // reopen: migrations are not re-run (persistent record)
  const reopened = openDatabase(dbPath);
  try {
    const rows = reopened.db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    assert.deepEqual(rows, [{ version: 1, name: 'test-migration' }]);
  } finally {
    reopened.close();
  }
});

test('a failing migration rolls back completely and throws', () => {
  const { db, close } = openDatabase(tempDbPath());
  try {
    assert.throws(() =>
      runMigrations(db, [
        {
          version: 1,
          name: 'broken-migration',
          up: (database) => {
            database.exec('CREATE TABLE half_written (id INTEGER)');
            throw new Error('boom mid-migration');
          },
        },
      ]),
    );
    // no schema_migrations row, and the half-written table must not exist
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    ).n;
    assert.equal(count, 0);
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='half_written'",
      )
      .get();
    assert.equal(table, undefined);
  } finally {
    close();
  }
});

test('close() closes the database cleanly', () => {
  const { db, close } = openDatabase(tempDbPath());
  db.exec('CREATE TABLE t (x)');
  close();
  assert.throws(() => db.prepare('SELECT 1').get(), /not open/i);
});
