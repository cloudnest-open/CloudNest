import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * Backup and restore (M12.c).
 *
 * Rules enforced here:
 * - the backup uses SQLite's own online backup API, so it is consistent while
 *   WAL writes continue; copying just the .db file is explicitly never done;
 * - the archive is labelled a METADATA/CONFIGURATION backup: it holds manifests,
 *   jobs, shares and account references, never the remote chunk bytes;
 * - the credential-encryption key is deliberately NOT part of an ordinary
 *   backup, and the API says so, because a restore without it leaves provider
 *   accounts unusable;
 * - restore writes into a fresh directory and never overwrites the live data
 *   directory: both sides are compared after symlink resolution, so a symlinked
 *   alias, a `..` spelling or a relative path that lands on the live data
 *   directory is refused as well;
 * - the caller must name an absolute target explicitly, and an existing
 *   destination database is never replaced without an explicit
 *   `confirmOverwrite` acknowledgement.
 */

export const BACKUP_FORMAT_VERSION = 1;

/** lstat that reports a missing or dangling path as null instead of throwing. */
function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** Cap on the `-N` suffixes tried when a timestamped backup directory already exists. */
const BACKUP_DIRECTORY_SUFFIX_LIMIT = 100;

export class MaintenanceError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  appVersion: string;
  kind: 'metadata-configuration';
  /** Deliberately documents what is NOT included. */
  excludes: string[];
  includes: string[];
  databaseBytes: number;
  databaseSha256: string;
  counts: Record<string, number>;
  keyPresent: boolean;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Resolve a path with symlinks followed, even when the path itself does not
 * exist yet: the deepest existing ancestor is resolved with `fs.realpathSync`
 * and the not-yet-created trailing segments are appended to it. `realpathSync`
 * alone cannot be used, because the restore is allowed to create the target
 * directory. String comparison alone is not enough, because `path.resolve`
 * never follows symlinks.
 */
function realpathResolve(input: string): string {
  const absolute = path.resolve(input);
  let current = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute; // reached the root: nothing to resolve
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Options a restore caller must set deliberately; nothing is overwritten by default. */
export interface RestoreOptions {
  /**
   * A restore never replaces an existing destination database unless the caller
   * explicitly acknowledges it. Without this flag an occupied destination is
   * refused with `restore_target_exists`.
   */
  confirmOverwrite?: boolean;
}

export interface BackupResult {
  directory: string;
  databasePath: string;
  manifest: BackupManifest;
}

export class MaintenanceService {
  constructor(
    private readonly db: Database.Database,
    private readonly dataDir: string,
    private readonly appVersion: string,
  ) {}

  /** Create a consistent online backup into a new timestamped directory. */
  backup(dbPath: string, counts: Record<string, number>): BackupResult {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Two backups can be requested within the same millisecond. The timestamp
    // alone would name the same directory twice and the second `VACUUM INTO`
    // would fail with "destination exists", so a numeric suffix keeps the
    // human-readable stamp while guaranteeing a unique directory.
    let directory = path.join(this.dataDir, 'backups', stamp);
    for (let attempt = 1; fs.existsSync(directory); attempt += 1) {
      if (attempt > BACKUP_DIRECTORY_SUFFIX_LIMIT) {
        throw new MaintenanceError('backup_directory_unavailable', 500);
      }
      directory = path.join(this.dataDir, 'backups', `${stamp}-${attempt}`);
    }
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, 'cloudnest.db');

    // SQLite's own backup API: safe while writers continue, unlike a file copy
    this.db.prepare('VACUUM INTO ?').run(destination);

    const keyPath = path.join(this.dataDir, 'credential-master.key');
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: this.appVersion,
      kind: 'metadata-configuration',
      includes: [
        'file and chunk manifests (names, sizes, per-chunk SHA-256, placements)',
        'upload/download/delete job history',
        'share link records (token hashes only)',
        'provider account references and quota snapshots',
        'application settings',
      ],
      excludes: [
        'the actual file bytes — those live only as objects inside each provider',
        'the credential-encryption key (credential-master.key)',
        'provider OAuth tokens in readable form (they are encrypted in the database)',
      ],
      databaseBytes: fs.statSync(destination).size,
      databaseSha256: sha256File(destination),
      counts,
      keyPresent: fs.existsSync(keyPath),
    };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { directory, databasePath: destination, manifest };
  }

  listBackups(): Array<{ directory: string; createdAt: string; databaseBytes: number; appVersion: string }> {
    const root = path.join(this.dataDir, 'backups');
    if (!fs.existsSync(root)) return [];
    const out: Array<{ directory: string; createdAt: string; databaseBytes: number; appVersion: string }> = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(root, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
        out.push({
          directory: path.join(root, entry.name),
          createdAt: manifest.createdAt,
          databaseBytes: manifest.databaseBytes,
          appVersion: manifest.appVersion,
        });
      } catch {
        // an unreadable manifest is skipped rather than reported as a valid backup
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Verify a backup by opening it and checking structural integrity plus that
   * every manifest row still points at a placement. Reports missing objects
   * instead of claiming the file contents were restored.
   */
  verifyBackup(backupDatabasePath: string): {
    readable: boolean;
    foreignKeyCheckClean: boolean;
    integrityCheck: string;
    fileCount: number;
    chunksWithoutPlacement: number;
    error?: string;
  } {
    if (!fs.existsSync(backupDatabasePath)) {
      throw new MaintenanceError('backup_not_found', 404);
    }
    // open read-only so verification can never mutate the backup
    let handle: Database.Database | null = null;
    try {
      handle = new Database(backupDatabasePath, { readonly: true });
      const integrity = handle.pragma('integrity_check', { simple: true }) as string;
      const violations = handle.pragma('foreign_key_check');
      const fileCount = (handle.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
      // a chunk with no active placement cannot be reconstructed
      const orphaned = (handle.prepare(
        `SELECT COUNT(*) AS n FROM file_chunks c
         WHERE NOT EXISTS (SELECT 1 FROM chunk_placements p WHERE p.chunk_id = c.id AND p.is_active = 1)`,
      ).get() as { n: number }).n;
      return {
        readable: true,
        foreignKeyCheckClean: Array.isArray(violations) ? violations.length === 0 : !violations,
        integrityCheck: integrity,
        fileCount,
        chunksWithoutPlacement: orphaned,
      };
    } catch (err) {
      return {
        readable: false,
        foreignKeyCheckClean: false,
        integrityCheck: 'not-run',
        fileCount: 0,
        chunksWithoutPlacement: 0,
        error: err instanceof Error ? err.message : 'unreadable',
      };
    } finally {
      handle?.close();
    }
  }

  /**
   * Restore into a NEW directory. The live data directory is never overwritten —
   * both sides of the comparison are resolved with symlinks followed, so an
   * alias of the live directory (symlink, `..` spelling or relative path) is
   * refused too, as is a destination database that is itself a symlink — and a
   * failed restore cannot destroy working state. The target must be an explicit
   * absolute path, and an existing destination database is only replaced when
   * `confirmOverwrite` is set.
   */
  restoreInto(
    backupDatabasePath: string,
    targetDir: string,
    options: RestoreOptions = {},
  ): { restoredPath: string; overwritten: boolean } {
    if (!fs.existsSync(backupDatabasePath)) throw new MaintenanceError('backup_not_found', 404);

    // An empty or relative target must never be interpreted as the working
    // directory: the caller has to name the destination explicitly.
    if (typeof targetDir !== 'string' || targetDir.trim() === '' || !path.isAbsolute(targetDir)) {
      throw new MaintenanceError('restore_target_invalid', 400);
    }

    const resolvedTarget = realpathResolve(targetDir);
    const resolvedLive = realpathResolve(this.dataDir);
    if (resolvedTarget === resolvedLive) {
      throw new MaintenanceError('restore_target_is_live_directory', 409);
    }

    // An existing path that is not a directory can never be a restore target.
    if (fs.existsSync(resolvedTarget) && !fs.statSync(resolvedTarget).isDirectory()) {
      throw new MaintenanceError('restore_target_invalid', 400);
    }

    const destination = path.join(resolvedTarget, 'cloudnest.db');
    // A restore never writes *through* a link: a symlinked destination could
    // point back at the live database or outside the target directory entirely.
    const destinationStat = lstatOrNull(destination);
    if (destinationStat !== null && destinationStat.isSymbolicLink()) {
      if (realpathResolve(destination) === path.join(resolvedLive, 'cloudnest.db')) {
        throw new MaintenanceError('restore_target_is_live_directory', 409);
      }
      throw new MaintenanceError('restore_target_invalid', 400);
    }
    const destinationExists = destinationStat !== null;
    if (destinationExists && options.confirmOverwrite !== true) {
      throw new MaintenanceError('restore_target_exists', 409);
    }
    const verification = this.verifyBackup(backupDatabasePath);
    if (!verification.readable) throw new MaintenanceError('backup_unreadable', 409);
    fs.mkdirSync(resolvedTarget, { recursive: true });
    fs.copyFileSync(backupDatabasePath, destination);
    // a restore must never silently claim the provider objects came back too
    fs.writeFileSync(
      path.join(resolvedTarget, 'RESTORE-NOTES.txt'),
      [
        'CloudNest restore notes',
        '',
        'This is a metadata/configuration restore. It does NOT recreate any file',
        'bytes: those live only as chunk objects inside your connected providers.',
        '',
        'To use this restore, provider OAuth tokens are encrypted with the key at',
        'DATA_DIR/credential-master.key. If that key file is missing, provider',
        'accounts in this restored database must be reconnected.',
        '',
        `chunks without an active placement: ${verification.chunksWithoutPlacement}`,
        'Any such chunk cannot be reconstructed; the affected files are reported as',
        'needing repair rather than silently shown as healthy.',
      ].join('\n'),
      { mode: 0o600 },
    );
    return { restoredPath: destination, overwritten: destinationExists };
  }

  /** Secret-encryption key status and the warning the UI must show. */
  keyStatus(): { keyPresent: boolean; warning: string | null } {
    const keyPath = path.join(this.dataDir, 'credential-master.key');
    const keyPresent = fs.existsSync(keyPath);
    return {
      keyPresent,
      warning: keyPresent
        ? 'The credential key exists on this machine. It is NOT included in an ordinary backup: keep a separate secure copy, or restoring elsewhere will leave provider accounts unusable.'
        : null,
    };
  }
}
