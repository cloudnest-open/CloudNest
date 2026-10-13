import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { openDatabase, runMigrations } from '../db/index.js';
import { allMigrations } from '../db/migrations.js';
import { loadConfig } from '../config/env.js';

/**
 * Local-only admin password reset (recovery path).
 * - Reuses the exact same config/data-dir resolver as the server.
 * - Requires an explicit terminal confirmation phrase.
 * - Removes ONLY the admin row and all sessions; never provider/file/chunk/
 *   placement/job/share metadata and never the session-signing secret.
 * - Never exposed as an HTTP route.
 */

const CONFIRM_PHRASE = 'RESET CLOUDNEST ADMIN';

async function main(): Promise<void> {
  console.log('============================================================');
  console.log(' CloudNest admin password reset (local recovery command)');
  console.log('------------------------------------------------------------');
  console.log(' STOP CloudNest before running this command.');
  console.log(' This deletes the admin account and ALL login sessions.');
  console.log(' Cloud files, provider metadata and settings are preserved.');
  console.log(' Next start will show the first-run setup screen again.');
  console.log('============================================================');

  // single source of truth: the same config resolver the server uses
  const config = loadConfig();
  const dbPath = config.dbPath;

  if (!fs.existsSync(dbPath)) {
    console.error(`No CloudNest database found at: ${dbPath}`);
    console.error('Nothing to reset.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Type "${CONFIRM_PHRASE}" to continue (anything else aborts): `, resolve);
  });
  rl.close();
  if (answer.trim() !== CONFIRM_PHRASE) {
    console.log('Aborted. Nothing was changed.');
    process.exit(0);
  }

  const opened = openDatabase(dbPath);
  try {
    runMigrations(opened.db, allMigrations); // ensure schema exists before touching rows
    const txn = opened.db.transaction(() => {
      opened.db.prepare('DELETE FROM admin_users').run();
      opened.db.prepare('DELETE FROM sessions').run();
    });
    txn();
    console.log('Admin account and sessions removed.');
    console.log(`Non-auth metadata preserved: files/chunks/placements/jobs/shares/settings.`);
    console.log('Start CloudNest and open the app to run first-time setup again.');
  } catch (err) {
    console.error('Reset failed; the database was NOT modified:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    opened.close();
  }
}

main().catch((err) => {
  console.error('Reset failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
