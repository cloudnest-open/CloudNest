import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/env.js';

test('defaults: port 8787, development, per-user data dir', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8787);
  assert.equal(config.nodeEnv, 'development');
  // data dir must be outside the repository (per-user OS directory)
  assert.ok(!config.dataDir.startsWith(process.cwd()));
  assert.ok(path.isAbsolute(config.dataDir));
});

test('PORT override is honored', () => {
  const config = loadConfig({ PORT: '9001' });
  assert.equal(config.port, 9001);
});

test('invalid PORT is rejected with a clear error', () => {
  assert.throws(() => loadConfig({ PORT: 'not-a-port' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '99999' }), /Invalid PORT/);
});

test('invalid NODE_ENV is rejected', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'staging' }), /Invalid NODE_ENV/);
});

test('DATA_DIR override resolves to an absolute path', () => {
  const tmp = path.join(os.tmpdir(), `cloudnest-test-${Date.now()}`);
  const config = loadConfig({ DATA_DIR: tmp });
  assert.equal(config.dataDir, path.resolve(tmp));
  assert.equal(config.dbPath, path.join(path.resolve(tmp), 'cloudnest.db'));
});
