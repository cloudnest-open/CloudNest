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
const sessionSecret = loadOrCreateSessionSecret(config.dataDir);

// Open the database and run transactional migrations BEFORE accepting traffic.
const opened = openDatabase(config.dbPath);
const applied = runMigrations(opened.db, allMigrations);
for (const migration of applied) {
  console.log(`[cloudnest] migration applied: ${migration.version} ${migration.name}`);
}

const app = createApp({ appVersion: config.appVersion, db: opened.db, sessionSecret, dataDir: config.dataDir, appBaseUrl: config.appBaseUrl });
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[cloudnest] listening on http://127.0.0.1:${config.port}`);
  console.log(`[cloudnest] data directory: ${config.dataDir}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cloudnest] received ${signal}; shutting down gracefully`);
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
