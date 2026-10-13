import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { onedriveAdapter } from '../src/providers/onedrive.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * OPT-IN live smoke test for the OneDrive connector.
 * Runs ONLY when CLOUDNEST_LIVE_ONEDRIVE=1 and the credential variables exist,
 * so an ordinary `npm test` never touches a real Microsoft account:
 *   CLOUDNEST_LIVE_ONEDRIVE=1
 *   CLOUDNEST_LIVE_ONEDRIVE_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN
 *   CLOUDNEST_LIVE_ONEDRIVE_AUTHORITY   (optional; defaults to "common")
 *
 * Objects are created inside the CloudNest-owned folder and deleted in cleanup.
 */
const enabled = process.env['CLOUDNEST_LIVE_ONEDRIVE'] === '1';
const clientId = process.env['CLOUDNEST_LIVE_ONEDRIVE_CLIENT_ID'] ?? '';
const clientSecret = process.env['CLOUDNEST_LIVE_ONEDRIVE_CLIENT_SECRET'] ?? '';
const refreshToken = process.env['CLOUDNEST_LIVE_ONEDRIVE_REFRESH_TOKEN'] ?? '';
const authority = process.env['CLOUDNEST_LIVE_ONEDRIVE_AUTHORITY'] ?? 'common';
const hasCreds = enabled && clientId !== '' && clientSecret !== '' && refreshToken !== '';

test('live OneDrive smoke test (opt-in)', { skip: !hasCreds ? 'set CLOUDNEST_LIVE_ONEDRIVE=1 plus the three credential variables to run' : false }, async () => {
  const bundle: ProviderCredentialBundle = {
    schemaVersion: 1,
    provider: 'onedrive',
    accessToken: '',
    refreshToken,
    accessTokenExpiresAtMs: 0, // forces a refresh, proving the refresh path works
    authority,
    grantedScopes: [],
  };
  const appConfig = { provider: 'onedrive' as const, clientId, clientSecret };

  const fresh = await onedriveAdapter.ensureValidCredentials(bundle, appConfig);
  assert.ok('accessToken' in fresh && fresh.accessToken.length > 0, 'token refresh produced an access token');

  const account = await onedriveAdapter.connectAndReadAccount(fresh, appConfig);
  assert.ok(account.providerAccountId.length > 0, 'stable owner id returned');

  const root = await onedriveAdapter.ensureAppRoot!(fresh, appConfig);
  const again = await onedriveAdapter.ensureAppRoot!(fresh, appConfig);
  assert.equal(again.remoteRootId, root.remoteRootId, 'root creation is idempotent');

  const objectKey = `smoke-${Date.now()}.bin`;
  const payload = Buffer.from('CloudNest OneDrive live smoke payload');
  let remoteId: string | null = null;
  try {
    const ref = await onedriveAdapter.uploadObjectStream!(
      fresh,
      { rootId: root.remoteRootId, objectKey, name: objectKey, readable: Readable.from(payload), sizeBytes: payload.length },
      appConfig,
    );
    remoteId = ref.remoteObjectId;
    assert.equal(ref.sizeBytes, payload.length, 'remote size matches the sent bytes');

    const found = await onedriveAdapter.findAppObjectByKey!(fresh, root.remoteRootId, objectKey, appConfig);
    assert.equal(found?.remoteObjectId, remoteId, 'object is recoverable by its app key');

    const listed = await onedriveAdapter.listAppObjects!(fresh, root.remoteRootId, appConfig);
    assert.ok(listed.some((o) => o.remoteObjectId === remoteId), 'the smoke object is inside the CloudNest folder');

    const downloaded = await onedriveAdapter.downloadObjectStream!(fresh, remoteId, appConfig);
    let roundTrip = Buffer.alloc(0);
    for await (const chunk of downloaded.stream) roundTrip = Buffer.concat([roundTrip, Buffer.from(chunk as Buffer)]);
    assert.deepEqual(roundTrip, payload, 'downloaded bytes match the uploaded bytes');
  } finally {
    if (remoteId) {
      const cleanup = await onedriveAdapter.deleteAppObject!(fresh, root.remoteRootId, remoteId, appConfig);
      assert.equal(cleanup.deleted, true, 'the smoke-test object was cleaned up');
    }
  }
});
