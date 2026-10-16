import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, Client } from './helpers.js';
import { openDatabase } from '../src/db/index.js';

/**
 * M12 Dashboard summary (the numbers the Dashboard page renders).
 *
 * The design contract for this endpoint is honesty: a value is only reported
 * when real stored data supports it; unknown/stale quota is `null` and the UI
 * shows "Unknown" — never 0, never a guess. These tests drive the shipped HTTP
 * API, so a UI that invents numbers cannot pass them.
 */

const GOOD = 'correct horse battery staple';
const MIB = 1024 * 1024;

interface Summary {
  accounts: Array<{ id: string; provider: string; status: string; quotaStatus: string }>;
  activeJobs: number;
  recentFiles: number;
  totalFiles: number;
  accountsDetailed: Array<{
    id: string; provider: string; status: string; quotaStatus: string;
    quotaTotalBytes: number | null; quotaUsedBytes: number | null;
    reserveBytes: number; outstandingBytes: number;
    usableBytes: number | null; lastQuotaCheckAt: string | null;
  }>;
  storage: {
    knownAccounts: number; unknownAccounts: number;
    totalBytes: number | null; usedBytes: number | null; reservedBytes: number;
    usableBytes: number | null; lastCheckedAt: string | null;
  };
  activeShareLinks: number;
  recentFileList: Array<{ id: string; originalName: string; sizeBytes: number; chunkCount: number; state: string; storedAcross: string[] }>;
}

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

async function summary(client: Client): Promise<Summary> {
  const res = await client.get('/api/dashboard/summary');
  assert.equal(res.status, 200);
  return res.body as Summary;
}

/** Insert a provider account row exactly as the connect flow would. */
function seedAccount(
  dbPath: string,
  opts: { id: string; provider: string; status?: string; quotaStatus?: string; total?: number | null; used?: number | null; reserve?: number; checkedAt?: string | null },
): void {
  const { db, close } = openDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts
         (id, provider, display_label, account_identifier, status, quota_total_bytes, used_bytes, quota_status,
          reserve_bytes, reserved_inflight_bytes, last_quota_check_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      opts.id, opts.provider, `${opts.provider}-label`, `id-${opts.id}`,
      opts.status ?? 'connected', opts.total ?? null, opts.used ?? null,
      opts.quotaStatus ?? 'unknown', opts.reserve ?? 0, opts.checkedAt ?? null, now, now,
    );
  } finally {
    close();
  }
}

function seedFile(dbPath: string, id: string, name: string, size = 100): void {
  const { db, close } = openDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, manifest_hash, created_at, completed_at)
       VALUES (?, 'usr_admin', ?, ?, 'text/plain', ?, 1, 'completed', ?, ?, ?)`,
    ).run(id, name, size, size, 'a'.repeat(64), now, now);
  } finally {
    close();
  }
}

function seedShare(dbPath: string, id: string, state: string): void {
  const { db, close } = openDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO share_links (id, token_hash, state, download_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(id, crypto.randomBytes(32).toString('hex'), state, now, now);
  } finally {
    close();
  }
}

test('an empty install reports Unknown storage, not zero, and no invented links', async () => {
  const { app, client } = await authed();
  try {
    const s = await summary(client);
    assert.equal(s.storage.totalBytes, null, 'no quota data means Unknown, never 0');
    assert.equal(s.storage.usableBytes, null);
    assert.equal(s.storage.knownAccounts, 0);
    assert.equal(s.storage.unknownAccounts, 0);
    assert.equal(s.activeShareLinks, 0);
    assert.deepEqual(s.recentFileList, []);
    assert.equal(s.totalFiles, 0);
  } finally {
    await app.close();
  }
});

test('a connected account with current quota contributes real bytes and a usable figure', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, {
      id: 'a1', provider: 'google_drive', total: 100 * MIB, used: 10 * MIB,
      quotaStatus: 'current', checkedAt: '2026-10-14T04:00:00.000Z',
    });
    const s = await summary(client);
    assert.equal(s.storage.knownAccounts, 1);
    assert.equal(s.storage.unknownAccounts, 0);
    assert.equal(s.storage.totalBytes, 100 * MIB);
    assert.equal(s.storage.usedBytes, 10 * MIB);
    assert.ok(s.storage.usableBytes !== null && s.storage.usableBytes > 0, 'usable is computed from the same preflight the uploader uses');
    assert.ok(s.storage.usableBytes! <= 90 * MIB);
    assert.equal(s.storage.lastCheckedAt, '2026-10-14T04:00:00.000Z', 'the newest real quota check is reported');
    const account = s.accountsDetailed.find((a) => a.id === 'a1')!;
    assert.equal(account.usableBytes, s.storage.usableBytes);
  } finally {
    await app.close();
  }
});

test('stale or unknown quota is excluded from totals and reported as unusable', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, { id: 'fresh', provider: 'dropbox', total: 50 * MIB, used: 5 * MIB, quotaStatus: 'current', checkedAt: '2026-10-14T05:00:00.000Z' });
    seedAccount(app.dbPath, { id: 'stale', provider: 'pcloud', total: 50 * MIB, used: 5 * MIB, quotaStatus: 'stale' });
    seedAccount(app.dbPath, { id: 'unknown', provider: 'onedrive', quotaStatus: 'unknown' });

    const s = await summary(client);
    assert.equal(s.storage.knownAccounts, 1, 'only the fresh account may be counted');
    assert.equal(s.storage.unknownAccounts, 2);
    assert.equal(s.storage.totalBytes, 50 * MIB, 'the stale/unknown accounts contribute nothing');
    assert.equal(s.accountsDetailed.find((a) => a.id === 'stale')!.usableBytes, null);
    assert.equal(s.accountsDetailed.find((a) => a.id === 'unknown')!.usableBytes, null);
    assert.equal(s.accountsDetailed.find((a) => a.id === 'unknown')!.quotaTotalBytes, null);
  } finally {
    await app.close();
  }
});

test('an experimental provider never counts as usable space even with a current quota', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, { id: 'mega1', provider: 'mega', total: 100 * MIB, used: 0, quotaStatus: 'current', checkedAt: '2026-10-14T05:00:00.000Z' });
    const s = await summary(client);
    assert.equal(s.storage.knownAccounts, 0, 'MEGA is not upload-ready, so it is not usable capacity');
    assert.equal(s.storage.usableBytes, null);
    const mega = s.accountsDetailed.find((a) => a.id === 'mega1')!;
    assert.equal(mega.usableBytes, null);
    assert.equal(mega.quotaTotalBytes, 100 * MIB, 'its real quota is still reported for display');
  } finally {
    await app.close();
  }
});

test('active share links are counted exactly, and revoked ones are not', async () => {
  const { app, client } = await authed();
  try {
    seedShare(app.dbPath, 's1', 'active');
    seedShare(app.dbPath, 's2', 'active');
    seedShare(app.dbPath, 's3', 'revoked');
    seedShare(app.dbPath, 's4', 'expired');
    const s = await summary(client);
    assert.equal(s.activeShareLinks, 2);
  } finally {
    await app.close();
  }
});

test('recent files come from real rows, newest first, with no provider internals', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f-old', 'old.txt');
    await new Promise((r) => setTimeout(r, 5));
    seedFile(app.dbPath, 'f-new', 'new.txt', 2048);
    const s = await summary(client);
    assert.equal(s.totalFiles, 2);
    // listFiles orders by created_at DESC, so the newest row leads
    assert.equal(s.recentFileList.length, 2);
    assert.equal(s.recentFileList[0]!.originalName, 'new.txt', 'newest first');
    assert.equal(s.recentFileList[0]!.sizeBytes, 2048);
    const text = JSON.stringify(s.recentFileList);
    for (const forbidden of ['remote_object', 'access_token', 'refresh_token', 'password']) {
      assert.ok(!text.includes(forbidden), `the file view must not leak ${forbidden}`);
    }
  } finally {
    await app.close();
  }
});

test('a reserved amount is surfaced so the UI can distinguish it from usable space', async () => {
  const { app, client } = await authed();
  try {
    seedAccount(app.dbPath, { id: 'r1', provider: 'dropbox', total: 100 * MIB, used: 0, reserve: 30 * MIB, quotaStatus: 'current' });
    const s = await summary(client);
    assert.equal(s.storage.reservedBytes, 30 * MIB);
    assert.ok(s.storage.usableBytes !== null && s.storage.usableBytes <= 70 * MIB, 'reserve is not offered as usable');
  } finally {
    await app.close();
  }
});
