/* Multi-account performance benchmark (task §6).
 * Run: npx tsx server/test/perf-benchmark.ts
 * Deterministic synthetic accounts; no network, no real credentials.
 * Writes JSON results to CloudNest-Memory/multiaccount-perf-results.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { makeProviderQueries } from '../src/db/provider-queries.js';
import { CredentialsStore } from '../src/providers/credentials-store.js';
import { ProviderAccountService } from '../src/services/provider-account-service.js';
import { UploadService } from '../src/uploads/upload-service.js';
import { SettingsService } from '../src/settings/settings-service.js';
import { DownloadService } from '../src/downloads/download-service.js';
import { DeletionService } from '../src/deletions/deletion-service.js';
import { ShareService } from '../src/shares/share-service.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const PROVIDERS = ['google_drive', 'dropbox', 'onedrive', 'pcloud'] as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] as number;
}

function stats(samples: number[]): { median: number; p95: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1),
  };
}

interface BenchResult {
  accounts: number;
  filesPerAccount: number;
  files: number;
  ops: Record<string, { median: number; p95: number; mean: number }>;
}

function seedWorld(db: import('better-sqlite3').Database, dataDir: string, accountCount: number, filesPerAccount: number) {
  const now = new Date().toISOString();
  const store = new CredentialsStore(db, dataDir);
  const accounts: Array<{ id: string; provider: string }> = [];
  for (let i = 0; i < accountCount; i++) {
    const provider = PROVIDERS[i % PROVIDERS.length]!;
    const id = `bench-acc-${i}`;
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status,
        quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'connected', ?, ?, 'current', 0, 0, ?, ?)`,
    ).run(id, provider, `bench-${i}@example.com`, `bench-ident-${i}`, 100 * GIB, Math.floor(GIB / 2), now, now);
    let bundle: import('../src/providers/types.js').ProviderCredentialBundle;
    if (provider === 'pcloud') {
      bundle = { schemaVersion: 1, provider: 'pcloud', accessToken: `tok-${i}`, apiHost: 'api.pcloud.com', userId: `u${i}` };
    } else if (provider === 'google_drive') {
      bundle = { schemaVersion: 1, provider: 'google_drive', accessToken: `tok-${i}`, refreshToken: `r-${i}`, grantedScopes: [] };
    } else if (provider === 'dropbox') {
      bundle = { schemaVersion: 1, provider: 'dropbox', accessToken: `tok-${i}`, refreshToken: `r-${i}`, grantedScopes: [] };
    } else {
      bundle = { schemaVersion: 1, provider: 'onedrive', accessToken: `tok-${i}`, refreshToken: `r-${i}`, authority: 'common', grantedScopes: [] };
    }
    store.saveAccountBundle(id, provider, bundle);
    accounts.push({ id, provider });
  }
  // files: chunks are spread round-robin across ALL accounts so storedAcross
  // and health derivation touch many accounts per file
  const files = Math.max(1, accountCount * filesPerAccount);
  let chunkSeq = 0;
  for (let f = 0; f < files; f++) {
    const fileId = `bench-file-${f}`;
    const chunkCount = Math.min(4, Math.max(1, accountCount));
    const fileChunks: string[] = [];
    // files row first — file_chunks.chunk_id FK-references it
    const manifestPlaceholder = crypto.randomBytes(32).toString('hex');
    db.prepare(
      `INSERT INTO files (id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, manifest_hash, created_at, completed_at)
       VALUES (?, ?, ?, 'application/octet-stream', ?, ?, 'completed', ?, ?, ?)`,
    ).run(fileId, `bench-file-${f}.bin`, chunkCount * 8 * MIB, 8 * MIB, chunkCount, manifestPlaceholder, now, now);
    for (let c = 0; c < chunkCount; c++) {
      const chunkId = `bench-chunk-${chunkSeq++}`;
      db.prepare(
        `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
      ).run(chunkId, fileId, c, c * 8 * MIB, 8 * MIB, crypto.randomBytes(32).toString('hex'), now, now);
      fileChunks.push(chunkId);
    }
    const manifest = crypto.createHash('sha256').update(fileChunks.join('|')).digest('hex');
    db.prepare('UPDATE files SET manifest_hash = ? WHERE id = ?').run(manifest, fileId);
    for (let c = 0; c < chunkCount; c++) {
      const account = accounts[(f + c) % accountCount]!;
      db.prepare(
        `INSERT INTO chunk_placements (id, chunk_id, provider_account_id, remote_object_id, remote_object_key, state, is_active, confirmed_size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'verified', 1, ?, ?, ?)`,
      ).run(`bench-place-${fileId}-${c}`, fileChunks[c], account.id, `obj-${fileId}-${c}`, `key-${fileId}-${c}`, 8 * MIB, now, now);
    }
  }
  return { accounts, files };
}

async function runBench(): Promise<void> {
  const scale = [1, 2, 5, 10, 25, 100];
  const results: BenchResult[] = [];
  for (const accountCount of scale) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-perf-'));
    const { db, close } = openDatabase(path.join(dir, 't.db'));
    try {
      runMigrations(db, allMigrations);
      const filesPerAccount = 5;
      const { files } = seedWorld(db, dir, accountCount, filesPerAccount);
      const store = new CredentialsStore(db, dir);
      const providerQ = makeProviderQueries(db);
      const accounts = new ProviderAccountService(db, providerQ, store);
      const uploads = new UploadService(db, store);
      const downloads = new DownloadService(db, store, new SettingsService(db));
      const deletions = new DeletionService(db, store, new ShareService(db));
      void deletions;

      const ops: BenchResult['ops'] = {};
      const time = (name: string, iterations: number, fn: () => unknown) => {
        fn(); // warm-up
        const samples: number[] = [];
        for (let i = 0; i < iterations; i++) {
          const t0 = process.hrtime.bigint();
          fn();
          const t1 = process.hrtime.bigint();
          samples.push(Number(t1 - t0) / 1e6);
        }
        ops[name] = stats(samples);
      };

      // §6: account-list and status queries
      time('accounts.list', 50, () => accounts.list());
      // §6: disconnect impact query (grouped placements)
      time('accounts.trackedUsage', 20, () => accounts.trackedUsage());
      // §6: quota-summary read shape (fields toPublic exposes)
      time('toPublic.all-accounts', 20, () => accounts.list().map((r) => ({ id: r.id, status: r.status, quota: { t: r.quota_total_bytes, u: r.used_bytes } })));
      // §6: upload preflight + capacity planning
      let planSeq = 0;
      time('upload.plan (24MiB/3 chunks)', 10, () => {
        planSeq++;
        try {
          uploads.plan({ originalName: `perf-${planSeq}.bin`, sizeBytes: 24 * MIB, chunkSizeMiB: 8, mimeType: null, idempotencyKey: `perf-key-${accountCount}-${planSeq}` });
        } catch {
          /* capacity-bounded; timing still measured */
        }
      });
      // §6: dashboard aggregation (includes publicFile per recent file)
      time('dashboardSummary', 3, () => uploads.dashboardSummary());
      // §6: files list page — the publicFile-per-file path
      time('files list (publicFile × files)', 3, () => {
        for (let f = 0; f < files; f++) uploads.publicFile(`bench-file-${f}`);
      });
      // §6: download placement lookup for one file
      time('download.prepare (first file)', 10, () => downloads.prepare('bench-file-0', null, false));

      results.push({ accounts: accountCount, filesPerAccount, files, ops });
      console.log(`\n=== ${accountCount} accounts × ${files} files (${filesPerAccount}/account) ===`);
      for (const [name, s] of Object.entries(ops)) {
        console.log(`  ${name.padEnd(36)} median ${s.median.toFixed(2)}ms  p95 ${s.p95.toFixed(2)}ms  mean ${s.mean.toFixed(2)}ms`);
      }
      const mem = process.memoryUsage();
      console.log(`  rss ${(mem.rss / MIB).toFixed(0)}MiB heapUsed ${(mem.heapUsed / MIB).toFixed(0)}MiB`);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const out = {
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      note: 'Local SQLite (better-sqlite3, synchronous), no network, synthetic data only.',
      date: new Date().toISOString(),
    },
    results,
  };
  const dest = '/home/km-abdullah/CloudNest/CloudNest-Memory/multiaccount-perf-results.json';
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${dest}`);
}

runBench().catch((err) => {
  console.error(err);
  process.exit(1);
});
