import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { openDatabase, runMigrations } from './db/index.js';
import { allMigrations } from './db/migrations.js';
import { loadOrCreateSessionSecret } from './config/secret.js';
import { createBackgroundScheduler } from './scheduler/background-scheduler.js';

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

// a crash must never leave upload jobs "running" or stale in-flight attempts
// holding the per-account concurrency cap: the upload engine's durable state
// is recovered at startup exactly like downloads (B2)
const uploads = app.get('uploads') as {
  recoverOnStartup: () => { recovered: number; reservationsRecomputed: number; attemptsReconciled: number };
} | undefined;
if (uploads) {
  const uploadRecovery = uploads.recoverOnStartup();
  if (uploadRecovery.recovered > 0 || uploadRecovery.attemptsReconciled > 0) {
    console.log(
      `[cloudnest] upload recovery: paused ${uploadRecovery.recovered} job(s), ` +
      `reconciled ${uploadRecovery.attemptsReconciled} in-flight attempt(s)`,
    );
  }
}

// BE-03 + Roadmap Phase 5: the background scheduler — the extended form of
// the hourly sweep. One module owns every recurring task: the original
// expired-row sweep (behaviour and logs unchanged), the cleanup-obligation
// retry (upload cleanups, pending deletions, interrupted mirrors), the 6-hour
// quota refresh, and the metrics prune/summary. Tasks are best-effort and
// every timer is unref'd so none can hold the process open.
const scheduler = createBackgroundScheduler({
  sessionStore: app.get('sessionStore') as { cleanupExpired?: () => number } | undefined,
  shares: app.get('shares') as
    | { cleanupExpiredSessions?: () => number; cleanupExpiredUnlockGrants?: () => number }
    | undefined,
  trash: app.get('trash') as { purgeExpired: () => number } | undefined,
  deletions: app.get('deletions') as
    | { resumePending: () => Promise<{ attempted: number; completed: number }> }
    | undefined,
  uploads: app.get('uploads') as
    | { retryPendingCleanups: () => Promise<{ retried: number; cleaned: number; stillPending: number }> }
    | undefined,
  mirror: app.get('mirror') as
    | { resumePending: () => Promise<{ attempted: number; completed: number }> }
    | undefined,
  accounts: app.get('providerAccounts') as import('./services/provider-account-service.js').ProviderAccountService | undefined,
  store: app.get('credentialsStore') as import('./providers/credentials-store.js').CredentialsStore | undefined,
  metrics: app.get('providerMetrics') as import('./metrics/provider-metrics.js').ProviderMetrics | undefined,
});
void scheduler.runAllOnce();
scheduler.start();

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
