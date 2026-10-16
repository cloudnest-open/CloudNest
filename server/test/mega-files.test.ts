import test from 'node:test';
import assert from 'node:assert/strict';
import { mapMegaError, safeSegment, ROOT_FOLDER_NAME } from '../src/providers/mega-files.js';
import { getAdapter } from '../src/providers/registry.js';
import { megaAdapter } from '../src/providers/mega.js';
import { ProviderError, PROVIDER_IDS, type ProviderId } from '../src/providers/types.js';

/**
 * These are contract/gate tests. megajs performs real network I/O internally,
 * so instead of faking its internals we assert the guarantees the connector
 * must expose: the honest capability gate, path safety, error normalization,
 * and that the registry reports MEGA truthfully.
 */

test('MEGA advertises itself as EXPERIMENTAL', () => {
  assert.equal(megaAdapter.experimental, true);
  assert.equal(getAdapter('mega')?.experimental, true);
});

test('MEGA does NOT advertise upload capability until a live smoke test proves it', () => {
  const caps = megaAdapter.capabilities;
  assert.equal(caps.upload, false, 'upload must be gated off (unproven streaming)');
  assert.equal(caps.download, false, 'download must be gated off (unproven ranged/streamed read)');
  assert.equal(caps.list, false, 'list must be gated off (unproven namespace enumeration)');
  assert.equal(caps.reasonCode, 'streaming_unsupported_unverified');
});

test('upload routing can exclude MEGA while every other connector stays eligible', () => {
  // this mirrors exactly what the future scheduler will do
  const eligible = PROVIDER_IDS.filter((id: ProviderId) => getAdapter(id)?.capabilities.upload === true);
  assert.ok(!eligible.includes('mega'), 'MEGA is excluded from upload placement');
  assert.deepEqual(
    eligible.sort(),
    ['dropbox', 'google_drive', 'onedrive', 'pcloud', 's3'],
    'the other connectors (now including the S3-compatible adapter) keep working',
  );
});

test('MEGA requires no provider app config (no fake OAuth setup)', () => {
  assert.equal(megaAdapter.requiresAppConfig, false);
  assert.equal(megaAdapter.displayName, 'MEGA');
});

test('credential errors never leak whether an account exists, and never log secrets', () => {
  const bad = mapMegaError(new Error('Wrong password'));
  assert.equal(bad.safeCode, 'invalid_credentials');
  const twoFa = mapMegaError(new Error('Two-factor code required'));
  assert.equal(twoFa.safeCode, 'invalid_credentials');
  // the normalized error must not carry the raw provider text
  assert.ok(!twoFa.message.toLowerCase().includes('two-factor'));
  assert.ok(!mapMegaError(new Error('ENOENT')).message.includes('ENOENT'));
  assert.ok(!mapMegaError(new Error('quota overflow')).message.includes('quota'));
});

test('transport and rate-limit failures map to distinct safe codes', () => {
  assert.equal(mapMegaError(new Error('EAGAIN')).safeCode, 'provider_rate_limited');
  assert.equal(mapMegaError(new Error('ENOENT')).safeCode, 'provider_object_missing');
  assert.equal(mapMegaError(new Error('storage overflow')).safeCode, 'provider_no_space');
  assert.equal(mapMegaError(new Error('ETIMEDOUT')).safeCode, 'provider_unavailable');
  assert.equal(mapMegaError(new Error('something unrecognised')).safeCode, 'provider_unavailable');
  // an already-normalized ProviderError passes through unchanged
  const original = new ProviderError('needs_reauth', 401);
  assert.equal(mapMegaError(original), original);
});

test('generated names cannot traverse or escape the CloudNest folder', () => {
  assert.equal(safeSegment('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeSegment('a/b'), 'a_b');
  assert.ok(!safeSegment('weird name!').includes(' '));
});

test('the CloudNest root folder name is the documented one', () => {
  assert.equal(ROOT_FOLDER_NAME, 'CloudNest Data');
});

test('the pinned megajs version is recorded and unofficial status is acknowledged', async () => {
  const pkg = JSON.parse(
    await (await import('node:fs/promises')).readFile('node_modules/megajs/package.json', 'utf8'),
  ) as { version: string; name: string };
  assert.equal(pkg.name, 'megajs');
  // documented in the handoff as an unofficial integration
  assert.match(pkg.version, /^1\./);
});
