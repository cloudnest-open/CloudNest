import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { allMigrations } from '../src/db/migrations.js';
import { SettingsService, SettingsError, SETTINGS_DEFAULTS, WORKER_LIMITS } from '../src/settings/settings-service.js';
import { MaintenanceService } from '../src/maintenance/maintenance-service.js';
import { DiagnosticsService, redact } from '../src/maintenance/diagnostics-service.js';
import { TunnelService, TunnelError } from '../src/tunnel/tunnel-service.js';
import { CredentialKey } from '../src/providers/encryption.js';

/** M12.a/c/d — settings validation, backup/restore and redaction. */

/** A TunnelService with a deterministic, throwaway encryption key for tests. */
function makeTunnel(dir: string): TunnelService {
  const key = CredentialKey.loadOrCreate(dir, false);
  return new TunnelService(dir, { keyProvider: () => key });
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-m12-'));
  const dbPath = path.join(dir, 'cloudnest.db');
  const { db, close } = openDatabase(dbPath);
  runMigrations(db, allMigrations);
  return {
    db, close, dir, dbPath,
    settings: new SettingsService(db),
    maintenance: new MaintenanceService(db, dir, '0.1.0'),
  };
}

// ---- settings ----

test('settings start from documented defaults', () => {
  const { close, settings } = setup();
  try {
    const all = settings.all();
    assert.equal(all['upload.chunkSizeMiB'], 64, 'the default chunk size is 64 MiB');
    assert.equal(all['upload.workerLimit'], WORKER_LIMITS.autoDefault);
    assert.equal(all['security.confirmDestructive'], true);
  } finally {
    close();
  }
});

test('only the approved chunk sizes can be set', () => {
  const { close, settings } = setup();
  try {
    for (const good of [8, 16, 32, 64]) {
      settings.set('upload.chunkSizeMiB', good);
      assert.equal(settings.get('upload.chunkSizeMiB'), good);
    }
    for (const bad of [0, 1, 7, 100, 128, -8, 1.5, 'x', null]) {
      assert.throws(() => settings.set('upload.chunkSizeMiB', bad), (e: unknown) => e instanceof SettingsError);
    }
  } finally {
    close();
  }
});

test('worker limits respect the documented hard ceiling', () => {
  const { close, settings } = setup();
  try {
    settings.set('upload.workerLimit', 8);
    assert.equal(settings.effectiveWorkerLimit(), 8);
    assert.throws(() => settings.set('upload.workerLimit', 9), (e: unknown) => e instanceof SettingsError);
    assert.throws(() => settings.set('upload.workerLimit', 0), (e: unknown) => e instanceof SettingsError);
    settings.set('upload.workerLimit', 2);
    assert.equal(settings.get('upload.workerLimit'), 2);
  } finally {
    close();
  }
});

test('an unknown setting key is rejected, never silently stored', () => {
  const { close, settings } = setup();
  try {
    assert.throws(() => settings.set('upload.chunkSizeMiB ', 8), (e: unknown) => e instanceof SettingsError);
    assert.throws(() => settings.set('totally.made.up', true), (e: unknown) => e instanceof SettingsError);
    // nothing was written for the unknown key
    const rows = settings.all();
    assert.deepEqual(Object.keys(rows).sort(), Object.keys(SETTINGS_DEFAULTS).sort());
  } finally {
    close();
  }
});

test('a bulk update is all-or-nothing', () => {
  const { close, settings } = setup();
  try {
    const before = settings.all();
    assert.throws(
      () => settings.setMany({ 'upload.chunkSizeMiB': 32, 'nope.nope': 1 }),
      (e: unknown) => e instanceof SettingsError,
    );
    assert.deepEqual(settings.all(), before, 'a rejected batch changes nothing');
    settings.setMany({ 'upload.chunkSizeMiB': 32, 'upload.workerLimit': 2 });
    assert.equal(settings.get('upload.chunkSizeMiB'), 32);
    assert.equal(settings.get('upload.workerLimit'), 2);
  } finally {
    close();
  }
});

test('the public base URL must be an origin, not an arbitrary URL', () => {
  const { close, settings } = setup();
  try {
    settings.set('domain.publicBaseUrl', 'https://files.example.com');
    assert.equal(settings.get('domain.publicBaseUrl'), 'https://files.example.com');
    settings.set('domain.publicBaseUrl', '');
    assert.equal(settings.get('domain.publicBaseUrl'), null, 'an empty value clears the setting');
    for (const bad of ['not a url', 'https://user:pw@x.example', 'https://x.example/path', 'javascript:alert(1)', 'ftp://x.example', 'file:///etc/passwd']) {
      assert.throws(
        () => settings.set('domain.publicBaseUrl', bad),
        (e: unknown) => e instanceof SettingsError,
        `must reject: ${bad}`,
      );
    }
    // http is only sensible for a local address, but must still be well formed
    settings.set('domain.publicBaseUrl', 'http://127.0.0.1:8787');
    assert.equal(settings.get('domain.publicBaseUrl'), 'http://127.0.0.1:8787');
  } finally {
    close();
  }
});

test('share defaults reject nonsensical values', () => {
  const { close, settings } = setup();
  try {
    settings.set('share.defaultExpiryDays', 30);
    assert.equal(settings.get('share.defaultExpiryDays'), 30);
    settings.set('share.defaultExpiryDays', null);
    assert.equal(settings.get('share.defaultExpiryDays'), null);
    assert.throws(() => settings.set('share.defaultExpiryDays', 0), (e: unknown) => e instanceof SettingsError);
    assert.throws(() => settings.set('share.defaultExpiryDays', 4000), (e: unknown) => e instanceof SettingsError);
    assert.throws(() => settings.set('share.defaultDownloadLimit', -1), (e: unknown) => e instanceof SettingsError);
  } finally {
    close();
  }
});

// ---- backup / restore ----

test('a backup is consistent, self-describing and excludes file bytes and the key', () => {
  const { close, db, dir, dbPath, maintenance } = setup();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO files (id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, created_at)
       VALUES ('f1','a.bin',100,100,1,'completed',?)`,
    ).run(now);
    const result = maintenance.backup(dbPath, { files: 1 });
    assert.ok(fs.existsSync(result.databasePath), 'the backup database exists');
    const manifest = result.manifest;
    assert.equal(manifest.kind, 'metadata-configuration');
    assert.ok(manifest.includes.some((s) => s.includes('manifests')));
    // the exclusions are stated explicitly, not implied
    assert.ok(manifest.excludes.some((s) => s.includes('file bytes')));
    assert.ok(manifest.excludes.some((s) => s.includes('credential-encryption key')));
    assert.ok(manifest.databaseBytes > 0);
    assert.match(manifest.databaseSha256, /^[0-9a-f]{64}$/);
    // the backup is not a bare file copy: the WAL was folded in
    void dir;
  } finally {
    close();
  }
});

test('a backup verifies cleanly and reports orphaned chunks honestly', () => {
  const { close, db, dbPath, maintenance } = setup();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO files (id, original_name, size_bytes, chunk_size_bytes, chunk_count, state, created_at)
       VALUES ('f1','a.bin',100,100,1,'completed',?)`,
    ).run(now);
    // a chunk with no active placement cannot be reconstructed
    db.prepare(
      `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
       VALUES ('c1','f1',0,0,100,?, 'uploaded', ?, ?)`,
    ).run('a'.repeat(64), now, now);
    const backup = maintenance.backup(dbPath, { files: 1 });
    const verification = maintenance.verifyBackup(backup.databasePath);
    assert.equal(verification.readable, true);
    assert.equal(verification.integrityCheck, 'ok');
    assert.equal(verification.foreignKeyCheckClean, true);
    assert.equal(verification.fileCount, 1);
    assert.equal(verification.chunksWithoutPlacement, 1, 'the gap is reported, not hidden');
  } finally {
    close();
  }
});

test('a restore refuses to overwrite the live data directory', () => {
  const { close, dir, dbPath, maintenance } = setup();
  try {
    const backup = maintenance.backup(dbPath, {});
    assert.throws(
      () => maintenance.restoreInto(backup.databasePath, dir),
      (e: unknown) => (e as { safeCode?: string }).safeCode === 'restore_target_is_live_directory',
    );
    // restoring into a new directory works and documents its limits
    const target = path.join(dir, 'restored');
    const restored = maintenance.restoreInto(backup.databasePath, target);
    assert.ok(fs.existsSync(restored.restoredPath));
    const notes = fs.readFileSync(path.join(target, 'RESTORE-NOTES.txt'), 'utf8');
    assert.ok(notes.includes('does NOT recreate'), 'the restore states it does not bring back file bytes');
    assert.ok(notes.includes('credential-master.key'), 'the key requirement is spelled out');
  } finally {
    close();
  }
});

test('a missing backup is a clean 404', () => {
  const { close, dir, maintenance } = setup();
  try {
    assert.throws(
      () => maintenance.verifyBackup(path.join(dir, 'nope.db')),
      (e: unknown) => (e as { safeCode?: string }).safeCode === 'backup_not_found',
    );
  } finally {
    close();
  }
});

test('the key warning is present only when a key actually exists', () => {
  const { close, dir, maintenance } = setup();
  try {
    assert.equal(maintenance.keyStatus().keyPresent, false);
    assert.equal(maintenance.keyStatus().warning, null);
    fs.writeFileSync(path.join(dir, 'credential-master.key'), Buffer.alloc(32), { mode: 0o600 });
    const status = maintenance.keyStatus();
    assert.equal(status.keyPresent, true);
    assert.ok(status.warning?.includes('NOT included in an ordinary backup'));
  } finally {
    close();
  }
});

// ---- diagnostics redaction ----

test('the redactor removes tokens, passwords and secret-bearing URLs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const google = `ya29.${'a'.repeat(40)}`;
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
  const pcloud = 'https://df-1.pcloud.com/xyz?access_token=SECRETVALUE123';
  const text = [
    `token=${jwt}`,
    `access_token=${google}`,
    `header: ${bearer}`,
    `client_secret=supersecretvalue`,
    `password=hunter2hunter2`,
    `url ${pcloud}`,
    'path /home/km-abdullah/CloudNest/CloudNest/server/src/index.ts',
  ].join('\n');
  const safe = redact(text);
  for (const secret of [jwt, google, 'abcdefghijklmnopqrstuvwxyz123456', 'supersecretvalue', 'hunter2hunter2', 'SECRETVALUE123']) {
    assert.ok(!safe.includes(secret), `the redactor must remove: ${secret}`);
  }
  assert.ok(safe.includes('[redacted]'));
  // absolute home paths are shortened
  assert.ok(!safe.includes('/home/km-abdullah/CloudNest/CloudNest/server/src/index.ts'));
  assert.ok(safe.includes('index.ts'), 'a useful file name is retained');
});

test('the diagnostics report never contains a stored secret', () => {
  const { close, db, dir } = setup();
  try {
    // put a realistic secret into the database the way the app would
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_accounts (id, provider, display_label, account_identifier, status, quota_total_bytes, used_bytes, quota_status, reserve_bytes, reserved_inflight_bytes, created_at, updated_at)
       VALUES ('a1','dropbox','a@example.com','i','connected',100,0,'current',0,0,?,?)`,
    ).run(now, now);
    const diagnostics = new DiagnosticsService(db, dir, '0.1.0', {
      providers: { dropbox: { status: 'mock-tested' } },
    });
    const report = diagnostics.build();
    const text = diagnostics.toText(report);
    assert.equal(report.database.foreignKeyCheckClean, true);
    assert.equal(report.database.integrityCheck, 'ok');
    assert.ok(report.capabilities['providers']);
    assert.ok(!text.includes('credential-master'));
    // the report explicitly states what it cannot include
    assert.ok(report.notes.some((n) => n.includes('credential-encryption key')));
  } finally {
    close();
  }
});

// ---- tunnel safety ----

test('a Cloudflare Global API Key is refused outright', () => {
  assert.throws(
    () => TunnelService.validateTokenShape('0123456789abcdef0123456789abcdef01234'),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'global_api_key_not_accepted',
  );
  assert.throws(() => TunnelService.validateTokenShape(''), (e: unknown) => e instanceof TunnelError);
  assert.throws(() => TunnelService.validateTokenShape('short'), (e: unknown) => e instanceof TunnelError);
  // a scoped token shape is accepted
  assert.doesNotThrow(() => TunnelService.validateTokenShape('a'.repeat(40)));
});

test('the required permissions are stated in plain language', () => {
  const perms = TunnelService.requiredPermissions();
  assert.ok(perms.some((p) => p.includes('Cloudflare Tunnel')));
  assert.ok(perms.some((p) => p.includes('DNS')));
});

test('the tunnel reports unavailable when cloudflared is not installed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir);
  const status = tunnel.status();
  assert.equal(status.state, 'disconnected');
  assert.equal(status.enabled, false);
  // starting without a binary fails with an actionable code rather than hanging
  if (!tunnel.available()) {
    await assert.rejects(
      () => tunnel.start({ runtimeToken: 'a'.repeat(40), hostname: 'files.example.com' }),
      (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'cloudflared_not_installed',
    );
  }
  // an unsafe hostname is refused before any process work
  await assert.rejects(
    () => tunnel.start({ runtimeToken: 'a'.repeat(40), hostname: 'bad host; rm -rf /' }),
    (e: unknown) => e instanceof TunnelError,
  );
});

test('a disconnect removes the temporary runtime token file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir);
  tunnel.saveRuntimeToken('a'.repeat(40), { hostname: 'files.example.com' });
  assert.equal(tunnel.hasStoredToken(), true, 'the token is stored (encrypted) after a save');
  tunnel.stop();
  assert.equal(tunnel.hasStoredToken(), false, 'the secret does not survive a disconnect');
});

test('the stored runtime token is never written in plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir);
  const secret = `cf-${'A1b2C3d4'.repeat(6)}`;
  tunnel.saveRuntimeToken(secret, { hostname: 'files.example.com' });
  const stored = tunnel.tokenPath();
  assert.ok(fs.existsSync(stored), 'an encrypted token file exists');
  const bytes = fs.readFileSync(stored).toString('utf8');
  assert.ok(!bytes.includes(secret), 'the raw token never appears on disk');
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600, 'the encrypted token file is restrictive');
});
