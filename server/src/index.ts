import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { openDatabase, runMigrations } from './db/index.js';
import { allMigrations } from './db/migrations.js';
import { loadOrCreateSessionSecret } from './config/secret.js';

/**
 * CloudNest server entry point (Step 1).
 * The only file that binds a port. Binds to loopback only.
 */
const config = loadConfig();
const sessionCredential = loadOrCreateSessionSecret(config.dataDir);

// Open the database and run transactional migrations BEFORE accepting traffic.
const opened = openDatabase(config.dbPath);
const applied = runMigrations(opened.db, allMigrations);
for (const migration of applied) {
  console.log(`[cloudnest] migration applied: ${migration.version} ${migration.name}`);
}

const app = createApp({
  appVersion: config.appVersion,
  db: opened.db,
  sessionCredential,
  dataDir: config.dataDir,
  appBaseUrl: config.appBaseUrl,
  dbPath: config.dbPath,
  port: config.port,
});
// a stream cannot survive a restart: report interrupted downloads truthfully
const downloads = app.get('downloads') as { recoverDownloadsOnStartup: () => number } | undefined;
if (downloads) {
  const interrupted = downloads.recoverDownloadsOnStartup();
  if (interrupted > 0) console.log(`[cloudnest] marked ${interrupted} interrupted download(s) as failed`);
}

// BE-03: bounded, periodic cleanup of expired session rows, share download
// sessions, and unlock grants. Previously these only died lazily when read,
// so long-running instances accumulated dead rows forever.
const shares = app.get('shares') as {
  cleanupExpiredSessions?: () => number;
  cleanupExpiredUnlockGrants?: () => number;
} | undefined;
const sessionStoreCleanup = (app.get('sessionStore') as { cleanupExpired?: () => number } | undefined)?.cleanupExpired;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for metadata rows
function sweepExpiredRows(): void {
  try {
    let swept = 0;
    if (sessionStoreCleanup) swept += sessionStoreCleanup();
    if (shares?.cleanupExpiredSessions) swept += shares.cleanupExpiredSessions();
    if (shares?.cleanupExpiredUnlockGrants) swept += shares.cleanupExpiredUnlockGrants();
    if (swept > 0) console.log(`[cloudnest] cleanup: expired ${swept} session/grant row(s)`);
  } catch {
    // cleanup is best-effort; rows remain for the next sweep
  }
}
sweepExpiredRows();
const cleanupTimer = setInterval(sweepExpiredRows, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// deletions that were interrupted must not be silently abandoned
const deletions = app.get('deletions') as { resumePending: () => Promise<{ attempted: number; completed: number }> } | undefined;
if (deletions) {
  void deletions.resumePending().then((r) => {
    if (r.attempted > 0) console.log(`[cloudnest] deletion recovery: ${r.completed}/${r.attempted} completed`);
  }).catch(() => {
    // pending obligations remain recorded for a later retry
  });
}

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[cloudnest] listening on http://127.0.0.1:${config.port}`);
  console.log(`[cloudnest] data directory: ${config.dataDir}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cloudnest] received ${signal}; shutting down gracefully`);
  // stop the connector this process owns and remove the runtime token file
  const tunnel = app.get('tunnel') as { stop: () => unknown } | undefined;
  try {
    tunnel?.stop();
  } catch {
    // a failed tunnel stop must not prevent the database from closing cleanly
  }
  server.close(() => {
    try {
      opened.close();
      console.log('[cloudnest] database closed; bye');
    } catch (err) {
      console.error('[cloudnest] error while closing database', err);
    }
    process.exit(0);
  });
  // hard exit if graceful close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[cloudnest] port ${config.port} is already in use. Stop the other process or set PORT=<free port> in .env, then start CloudNest again.`,
    );
    opened.close();
    process.exit(1);
  }
  console.error(`[cloudnest] server error: ${err.message}`);
  opened.close();
  process.exit(1);
});
