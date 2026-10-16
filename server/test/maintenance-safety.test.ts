import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { MaintenanceService } from '../src/maintenance/maintenance-service.js';

/**
 * M12.c restore-target safety.
 *
 * `restoreInto` used to compare `path.resolve(targetDir)` with `path.resolve(dataDir)`.
 * `path.resolve` is a pure string operation: it never follows symlinks, so a
 * symlinked alias of the live data directory passed the guard and the following
 * copy overwrote the live database. `path.resolve('')` is the process working
 * directory, so an empty target wrote a database into the CWD.
 *
 * Every test below fails if any of those properties come back.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-m12-safety-'));

after(() => {
  // only this file's own directory is removed; other runs' /tmp/cn-m12-* stay
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let sequence = 0;

/** A fresh live data directory with a migrated database, like the real app. */
function live() {
  const dir = path.join(ROOT, `live-${sequence++}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cloudnest.db');
  const { db, close } = openDatabase(dbPath);
  runMigrations(db, allMigrations);
  db.prepare(
    `INSERT INTO files (id, user_id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, created_at)
     VALUES ('f1','usr_admin','a.bin',100,100,1,'completed',?)`,
  ).run(new Date().toISOString());
  return { db, close, dir, dbPath, maintenance: new MaintenanceService(db, dir, '0.1.0') };
}

/** Size, mtime and content hash: an in-place overwrite cannot leave all three intact. */
function fingerprint(file: string) {
  const stats = fs.statSync(file);
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

function refuses(action: () => unknown, safeCode: string, why = ''): void {
  assert.throws(
    action,
    (err: unknown) => (err as { safeCode?: string }).safeCode === safeCode,
    `expected the safe code ${safeCode}${why ? ` (${why})` : ''}`,
  );
}

test('restore refuses a symlinked alias of the live data directory and leaves the live database byte-identical', () => {
  const { close, dir, dbPath, maintenance } = live();
  try {
    const backup = maintenance.backup(dbPath, { files: 1 });
    // the alias is a different string than the live directory; only resolution
    // that follows symlinks shows that both are the same directory
    const alias = path.join(ROOT, `alias-to-live-${sequence++}`);
    fs.symlinkSync(dir, alias);

    const before = fingerprint(dbPath);
    refuses(() => maintenance.restoreInto(backup.databasePath, alias), 'restore_target_is_live_directory', 'symlink alias');

    // the same directory, spelled through the alias and a `..` segment
    refuses(
      () => maintenance.restoreInto(backup.databasePath, path.join(alias, '..', path.basename(alias))),
      'restore_target_is_live_directory',
      'symlink plus .. spelling',
    );

    assert.deepEqual(fingerprint(dbPath), before, 'the live database must be untouched');
    assert.ok(!fs.existsSync(path.join(dir, 'RESTORE-NOTES.txt')), 'nothing may be written into the live directory');
  } finally {
    close();
  }
});

test('restore refuses every absolute spelling that resolves onto the live data directory', () => {
  const { close, dir, dbPath, maintenance } = live();
  try {
    const backup = maintenance.backup(dbPath, {});
    const alias = path.join(ROOT, `spelling-alias-${sequence++}`);
    fs.symlinkSync(dir, alias);
    // the first four are spelled lexically, the last four only resolve onto the
    // live directory once symlinks are followed
    const spellings = [
      path.join(dir, '.'),
      path.join(dir, 'sub', '..'),
      `${dir}${path.sep}`,
      path.join(dir, 'backups', '..'),
      alias,
      path.join(alias, '.'),
      path.join(alias, 'backups', '..'),
      `${alias}${path.sep}`,
    ];
    const before = fingerprint(dbPath);
    for (const spelling of spellings) {
      refuses(() => maintenance.restoreInto(backup.databasePath, spelling), 'restore_target_is_live_directory', spelling);
    }
    assert.deepEqual(fingerprint(dbPath), before, 'the live database must be untouched');
  } finally {
    close();
  }
});

test('restore refuses an empty or relative target and writes nothing to the working directory', () => {
  const { close, dbPath, maintenance } = live();
  const cwdDir = path.join(ROOT, `cwd-${sequence++}`);
  fs.mkdirSync(cwdDir, { recursive: true });
  const originalCwd = process.cwd();
  try {
    const backup = maintenance.backup(dbPath, {});
    process.chdir(cwdDir);
    // the empty string used to be turned into the process working directory
    refuses(() => maintenance.restoreInto(backup.databasePath, ''), 'restore_target_invalid', 'empty target');
    refuses(() => maintenance.restoreInto(backup.databasePath, '   '), 'restore_target_invalid', 'blank target');
    refuses(() => maintenance.restoreInto(backup.databasePath, 'restored'), 'restore_target_invalid', 'relative target');
    refuses(() => maintenance.restoreInto(backup.databasePath, '../restored'), 'restore_target_invalid', 'relative with ..');
    assert.deepEqual(fs.readdirSync(cwdDir), [], 'an empty target must never be read as the working directory');
  } finally {
    process.chdir(originalCwd);
    close();
  }
});

test('restore refuses a target that is an existing plain file, not a directory', () => {
  const { close, dir, dbPath, maintenance } = live();
  try {
    const backup = maintenance.backup(dbPath, {});
    const fileTarget = path.join(ROOT, `plain-file-${sequence++}`);
    fs.writeFileSync(fileTarget, 'i am a file');

    refuses(() => maintenance.restoreInto(backup.databasePath, fileTarget), 'restore_target_invalid', 'existing plain file');
    assert.equal(fs.readFileSync(fileTarget, 'utf8'), 'i am a file', 'the file was not replaced');
    assert.equal(path.dirname(backup.databasePath), path.join(dir, 'backups', path.basename(path.dirname(backup.databasePath))), 'the backup stayed in the live backups directory');
  } finally {
    close();
  }
});

test('restore into a legitimate new absolute directory works and writes the notes', () => {
  const { close, dbPath, maintenance } = live();
  try {
    const backup = maintenance.backup(dbPath, { files: 1 });
    const target = path.join(ROOT, `out-${sequence++}`, 'restored');
    const restored = maintenance.restoreInto(backup.databasePath, target);

    assert.equal(restored.restoredPath, path.join(target, 'cloudnest.db'));
    assert.equal(restored.overwritten, false, 'a fresh target was not overwritten');
    assert.ok(fs.existsSync(restored.restoredPath), 'the database was written');
    assert.equal(fingerprint(restored.restoredPath).sha256, fingerprint(backup.databasePath).sha256, 'the restored database is the verified backup');

    const notes = fs.readFileSync(path.join(target, 'RESTORE-NOTES.txt'), 'utf8');
    assert.ok(notes.includes('does NOT recreate'), 'the notes state that file bytes are not restored');
    assert.ok(notes.includes('credential-master.key'), 'the credential-key requirement is spelled out');
    // the key itself is never part of a restore
    assert.ok(!fs.existsSync(path.join(target, 'credential-master.key')), 'no credential key is copied');
  } finally {
    close();
  }
});

test('restore refuses an occupied destination unless the caller confirms the overwrite', () => {
  const { close, dbPath, maintenance } = live();
  try {
    const backup = maintenance.backup(dbPath, { files: 1 });
    const target = path.join(ROOT, `occupied-${sequence++}`);
    fs.mkdirSync(target, { recursive: true });
    const destination = path.join(target, 'cloudnest.db');
    fs.writeFileSync(destination, 'do-not-clobber');

    refuses(() => maintenance.restoreInto(backup.databasePath, target), 'restore_target_exists', 'existing destination');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'do-not-clobber', 'the existing database was left alone');

    const restored = maintenance.restoreInto(backup.databasePath, target, { confirmOverwrite: true });
    assert.equal(restored.overwritten, true, 'the confirmed overwrite is reported');
    assert.equal(fingerprint(destination).sha256, fingerprint(backup.databasePath).sha256, 'the confirmed restore replaced the database');
  } finally {
    close();
  }
});

test('restore never writes through a link that points at the live database', () => {
  const { close, dir, dbPath, maintenance } = live();
  try {
    const backup = maintenance.backup(dbPath, {});

    // a destination symlink pointing at the live database would redirect the copy
    const toLive = path.join(ROOT, `dest-link-live-${sequence++}`);
    fs.mkdirSync(toLive, { recursive: true });
    fs.symlinkSync(dbPath, path.join(toLive, 'cloudnest.db'));
    const before = fingerprint(dbPath);
    refuses(() => maintenance.restoreInto(backup.databasePath, toLive), 'restore_target_is_live_directory', 'destination links at the live db');

    // a destination symlink pointing anywhere else is refused as an invalid target
    const elsewhere = path.join(ROOT, `dest-link-elsewhere-${sequence++}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    const decoy = path.join(dir, 'decoy.db');
    fs.writeFileSync(decoy, 'decoy');
    fs.symlinkSync(decoy, path.join(elsewhere, 'cloudnest.db'));
    refuses(() => maintenance.restoreInto(backup.databasePath, elsewhere), 'restore_target_invalid', 'destination is a link');

    // a target that is itself a symlink to the live database file is refused too
    const linkToDb = path.join(ROOT, `link-to-live-db-${sequence++}`);
    fs.symlinkSync(dbPath, linkToDb);
    refuses(() => maintenance.restoreInto(backup.databasePath, linkToDb), 'restore_target_invalid', 'target is a link to the live db');

    assert.deepEqual(fingerprint(dbPath), before, 'the live database must be untouched');
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'decoy', 'no copy went through the link');
  } finally {
    close();
  }
});

test('an unsafe target is refused on its own merits, before the backup is even repaired or written', () => {
  const { close, dir, dbPath, maintenance } = live();
  try {
    const target = path.join(ROOT, `unreadable-${sequence++}`);
    refuses(() => maintenance.restoreInto(path.join(ROOT, 'missing.db'), target), 'backup_not_found', 'missing backup');

    const corrupt = path.join(ROOT, `corrupt-${sequence++}.db`);
    fs.writeFileSync(corrupt, 'this is not a sqlite database\n'.repeat(64));
    refuses(() => maintenance.restoreInto(corrupt, target), 'backup_unreadable', 'unreadable backup');
    assert.ok(!fs.existsSync(target), 'a refused restore creates no target directory');

    // an unsafe target is refused even when the backup is unreadable, i.e. the
    // target check is not a side effect of the verification result
    const alias = path.join(ROOT, `order-alias-${sequence++}`);
    fs.symlinkSync(dir, alias);
    refuses(() => maintenance.restoreInto(corrupt, alias), 'restore_target_is_live_directory', 'unsafe target checked first');
    assert.equal(maintenance.verifyBackup(dbPath).readable, true);
  } finally {
    close();
  }
});

test('two backups taken in the same millisecond land in distinct directories', () => {
  const { close, dbPath, maintenance } = live();
  const frozen = '2026-01-02T03:04:05.678Z';
  const expectedStamp = '2026-01-02T03-04-05-678Z';
  const originalToIsoString = Date.prototype.toISOString;
  // the directory stamp has millisecond resolution, so a frozen clock forces a collision
  Date.prototype.toISOString = function frozenStamp(): string {
    return frozen;
  };
  try {
    const first = maintenance.backup(dbPath, {});
    const second = maintenance.backup(dbPath, {});
    assert.equal(path.basename(first.directory), expectedStamp, 'the first backup keeps the readable stamp');
    assert.notEqual(second.directory, first.directory, 'the second backup must not reuse the first directory');
    assert.ok(fs.existsSync(first.databasePath), 'the first backup database exists');
    assert.ok(fs.existsSync(second.databasePath), 'the second backup database exists');
  } finally {
    Date.prototype.toISOString = originalToIsoString;
    close();
  }
});
