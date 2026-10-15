import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { UploadService } from '../src/uploads/upload-service.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';

/**
 * B2: the upload engine's startup recovery must run on the REAL live path.
 * Existing tests call service.recoverOnStartup() directly — that proves the
 * service, not the wiring. This test seeds a crashed state into a temp data
 * directory, then boots the actual server entry point (server/src/index.ts)
 * as a child process and asserts that startup itself repaired the state.
 */

const MIB = 1024 * 1024;
const INDEX_TS = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function seedAccount(db: import('better-sqlite3').Database, id: string, total: number): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
      quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
     VALUES (?, 'google_drive', ?, ?, 'connected', ?, 0, 'current', 0, 0, ?, ?)`,
  ).run(id, `${id}@example.com`, `ident-${id}`, total, now, now);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('booting the real server repairs a crashed upload state (live-path recovery)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-startup-'));
  // index.ts derives the database path as DATA_DIR/cloudnest.db
  const { db, close } = openDatabase(path.join(dir, 'cloudnest.db'));
  runMigrations(db, allMigrations);
  seedAccount(db, 'cr-acc', 100 * MIB);
  const store = new CredentialsStore(db, dir);
  const service = new UploadService(db, store);
  const plan = service.plan({
    originalName: 'crashed.bin', sizeBytes: 10 * MIB, chunkSizeMiB: 8, idempotencyKey: 'cr-restart-1',
  });
  service.markRunning(plan.jobId);
  // two mid-flight attempts: without a remote id (plain failure) and with one
  // (a durable cleanup obligation, because a remote object may exist)
  const a0 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 0, accountId: 'cr-acc' });
  const a1 = service.beginAttempt({ jobId: plan.jobId, chunkIndex: 1, accountId: 'cr-acc' });
  db.prepare('UPDATE upload_attempts SET remote_object_id = ? WHERE id = ?').run('cr-remote-stale', a1.attemptId);
  // a stale cache that only recomputeAllReservations can rebuild from rows
  db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = 0 WHERE id = ?').run('cr-acc');
  close();

  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', INDEX_TS], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => { stdout += String(d); });
  child.stderr!.on('data', (d) => { stderr += String(d); });

  const waitFor = async (needle: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stdout.includes(needle)) return;
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`server never printed "${needle}". stdout:\n${stdout}\nstderr:\n${stderr}`);
  };

  let recovered = false;
  try {
    // recovery runs inside index.ts BEFORE the port is bound, so seeing the
    // listening line proves the live path already executed it
    await waitFor('listening on http://127.0.0.1', 60000);
    recovered = true;
    assert.ok(
      stdout.includes('[cloudnest] upload recovery: paused 1 job(s), reconciled 2 in-flight attempt(s)'),
      'the startup log reports the upload recovery ran on the live path',
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  assert.ok(recovered, 'the server booted far enough to bind its port');

  // the durable state must now show the repair the live path performed
  const reopened = openDatabase(path.join(dir, 'cloudnest.db'));
  try {
    const job = reopened.db.prepare(
      'SELECT state, last_safe_error_code FROM transfer_jobs WHERE id = ?',
    ).get(plan.jobId) as { state: string; last_safe_error_code: string };
    assert.equal(job.state, 'paused', 'a crashed job is never left "running" after a real restart');
    assert.equal(job.last_safe_error_code, 'recovered_after_restart');

    const account = reopened.db.prepare(
      'SELECT reserved_inflight_bytes FROM provider_accounts WHERE id = ?',
    ).get('cr-acc') as { reserved_inflight_bytes: number };
    assert.equal(account.reserved_inflight_bytes, 10 * MIB, 'reservations were rebuilt from durable allocation rows');

    const attempts = reopened.db.prepare(
      'SELECT id, state FROM upload_attempts WHERE job_id = ?',
    ).all(plan.jobId) as Array<{ id: string; state: string }>;
    const byId = new Map(attempts.map((a) => [a.id, a.state]));
    assert.equal(byId.get(a0.attemptId), 'failed', 'an attempt without a remote object becomes a plain failure');
    assert.equal(byId.get(a1.attemptId), 'cleanup_pending', 'an attempt with a possible remote object keeps a durable cleanup obligation');
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
