import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { googleDriveAdapter } from '../src/providers/google-drive.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * OPT-IN live smoke test for the Google Drive connector.
 *
 * It runs ONLY when CLOUDNEST_LIVE_GOOGLE=1 and all of the required variables
 * are present, so an ordinary `npm test` never touches a real cloud account:
 *   CLOUDNEST_LIVE_GOOGLE=1
 *   CLOUDNEST_LIVE_GOOGLE_CLIENT_ID / _CLIENT_SECRET  (provider app credentials)
 *   CLOUDNEST_LIVE_GOOGLE_REFRESH_TOKEN               (a dedicated TEST account)
 *
 * Every object it creates lives inside the CloudNest-managed root and is
 * deleted again in cleanup. It never lists or deletes unrelated user files.
 */
const enabled = process.env['CLOUDNEST_LIVE_GOOGLE'] === '1';
const clientId = process.env['CLOUDNEST_LIVE_GOOGLE_CLIENT_ID'] ?? '';
const clientSecret = process.env['CLOUDNEST_LIVE_GOOGLE_CLIENT_SECRET'] ?? '';
const refreshToken = process.env['CLOUDNEST_LIVE_GOOGLE_REFRESH_TOKEN'] ?? '';

const hasCreds = enabled && clientId !== '' && clientSecret !== '' && refreshToken !== '';

test('live Google Drive smoke test (opt-in)', { skip: !hasCreds ? 'set CLOUDNEST_LIVE_GOOGLE=1 plus the three credential variables to run' : false }, async () => {
  const bundle: ProviderCredentialBundle = {
    schemaVersion: 1,
    provider: 'google_drive',
    accessToken: '',
    refreshToken,
    accessTokenExpiresAtMs: 0, // forces a refresh, proving the refresh path works
    grantedScopes: [],
  };
  const appConfig = { provider: 'google_drive' as const, clientId, clientSecret };

  const fresh = await googleDriveAdapter.ensureValidCredentials(bundle, appConfig);
  assert.ok('accessToken' in fresh && fresh.accessToken.length > 0, 'token refresh produced an access token');

  const account = await googleDriveAdapter.connectAndReadAccount(fresh, appConfig);
  assert.ok(account.providerAccountId.length > 0, 'stable identity returned');

  const root = await googleDriveAdapter.ensureAppRoot!(fresh, appConfig);
  assert.ok(root.remoteRootId.length > 0);
  const rootAgain = await googleDriveAdapter.ensureAppRoot!(fresh, appConfig);
  assert.equal(rootAgain.remoteRootId, root.remoteRootId, 'root creation is idempotent');

  const objectKey = `smoke-${Date.now()}`;
  const payload = Buffer.from('CloudNest live smoke test payload');
  let remoteId: string | null = null;
  try {
    const ref = await googleDriveAdapter.uploadObjectStream!(
      fresh,
      { rootId: root.remoteRootId, objectKey, name: objectKey, readable: Readable.from(payload), sizeBytes: payload.length },
      appConfig,
    );
    remoteId = ref.remoteObjectId;
    assert.equal(ref.sizeBytes, payload.length, 'remote size matches the sent bytes');

    const found = await googleDriveAdapter.findAppObjectByKey!(fresh, root.remoteRootId, objectKey, appConfig);
    assert.equal(found?.remoteObjectId, remoteId, 'object is recoverable by its app key');

    const listed = await googleDriveAdapter.listAppObjects!(fresh, root.remoteRootId, appConfig);
    assert.ok(listed.every((o) => o.objectKey.length > 0), 'only app-managed objects are listed');
    assert.ok(listed.some((o) => o.objectKey === objectKey), 'the smoke object is inside the CloudNest root');

    const downloaded = await googleDriveAdapter.downloadObjectStream!(fresh, remoteId, appConfig);
    let roundTrip = Buffer.alloc(0);
    for await (const chunk of downloaded.stream) roundTrip = Buffer.concat([roundTrip, Buffer.from(chunk as Buffer)]);
    assert.deepEqual(roundTrip, payload, 'downloaded bytes match the uploaded bytes');
  } finally {
    if (remoteId) {
      const cleanup = await googleDriveAdapter.deleteAppObject!(fresh, root.remoteRootId, remoteId, appConfig);
      assert.equal(cleanup.deleted, true, 'the smoke-test object was cleaned up');
    }
  }
});
