import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite foundation (Step 1): single connection per process, WAL mode,
 * strict durability pragmas, and a tiny transactional migration runner.
 *
 * Business tables (accounts, files, chunks, jobs, shares) are NOT created
 * here; they belong to Step 2 and later.
 */

export const REQUIRED_PRAGMAS = {
  journalMode: 'wal',
  foreignKeys: 1,
  synchronous: 2, // FULL
  busyTimeout: 5000,
} as const;

export interface OpenedDatabase {
  db: Database.Database;
  close: () => void;
}

/** Ensure the data directory exists before opening SQLite. */
export function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function openDatabase(dbPath: string): OpenedDatabase {
  ensureDataDir(path.dirname(dbPath));
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');

  verifyPragmas(db);

  return {
    db,
    close: () => {
      // checkpoint + close so the -wal/-shm sidecars are cleaned up
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    },
  };
}

/** Fail loudly at startup if durability settings could not be applied. */
export function verifyPragmas(db: Database.Database): void {
  const journalMode = (
    db.pragma('journal_mode', { simple: true }) as string
  ).toLowerCase();
  if (journalMode !== REQUIRED_PRAGMAS.journalMode) {
    throw new Error(
      `SQLite journal_mode is "${journalMode}", expected "wal". The data directory must be on a local filesystem that supports WAL.`,
    );
  }
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeys !== REQUIRED_PRAGMAS.foreignKeys) {
    throw new Error(`SQLite foreign_keys pragma could not be enabled.`);
  }
  const synchronous = db.pragma('synchronous', { simple: true }) as number;
  if (synchronous !== REQUIRED_PRAGMAS.synchronous) {
    throw new Error(`SQLite synchronous pragma is ${synchronous}, expected 2 (FULL).`);
  }
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

/**
 * Minimal transactional migration runner.
 * Each migration runs inside one transaction; a failure rolls back that
 * migration and stops startup. The schema_migrations table is the single
 * source of truth for which migrations have been applied.
 */
export function runMigrations(
  db: Database.Database,
  migrations: ReadonlyArray<{ version: number; name: string; up: (db: Database.Database) => void }>,
): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied: AppliedMigration[] = [];
  const alreadyApplied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (alreadyApplied.has(migration.version)) continue;
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    tx(); // throws -> rolled back -> startup fails; no half-applied schema
    applied.push({
      version: migration.version,
      name: migration.name,
      appliedAt: new Date().toISOString(),
    });
  }
  return applied;
}

/**
 * Step 1 has no business schema yet; this placeholder migration only
 * proves the transactional migration mechanism works end to end.
 * Step 2 replaces it with the real metadata schema from the approved plans.
 */
export const step1Migrations = [
  {
    version: 1,
    name: '0001-migration-infrastructure-check',
    up: (db: Database.Database): void => {
      // No business tables in Step 1. Create nothing user-visible.
      // Keep a tiny marker table so the mechanism is verifiably exercised.
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
] as const;
