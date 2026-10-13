import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { dropboxAdapter } from '../src/providers/dropbox.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * OPT-IN live smoke test for the Dropbox connector.
 * Runs ONLY when CLOUDNEST_LIVE_DROPBOX=1 and the credential variables exist,
 * so an ordinary `npm test` never touches a real Dropbox account:
 *   CLOUDNEST_LIVE_DROPBOX=1
 *   CLOUDNEST_LIVE_DROPBOX_CLIENT_ID / _CLIENT_SECRET
 *   CLOUDNEST_LIVE_DROPBOX_REFRESH_TOKEN   (a dedicated TEST account)
 *
 * Objects are created inside the CloudNest-managed root and deleted in cleanup;
 * unrelated user files are never listed, written, or removed.
 */
const enabled = process.env['CLOUDNEST_LIVE_DROPBOX'] === '1';
const clientId = process.env['CLOUDNEST_LIVE_DROPBOX_CLIENT_ID'] ?? '';
const clientSecret = process.env['CLOUDNEST_LIVE_DROPBOX_CLIENT_SECRET'] ?? '';
const refreshToken = process.env['CLOUDNEST_LIVE_DROPBOX_REFRESH_TOKEN'] ?? '';
const hasCreds = enabled && clientId !== '' && clientSecret !== '' && refreshToken !== '';

test('live Dropbox smoke test (opt-in)', { skip: !hasCreds ? 'set CLOUDNEST_LIVE_DROPBOX=1 plus the three credential variables to run' : false }, async () => {
  const bundle: ProviderCredentialBundle = {
    schemaVersion: 1,
    provider: 'dropbox',
    accessToken: '',
    refreshToken,
    accessTokenExpiresAtMs: 0, // forces a refresh, proving the refresh path works
    grantedScopes: [],
  };
  const appConfig = { provider: 'dropbox' as const, clientId, clientSecret };

  const fresh = await dropboxAdapter.ensureValidCredentials(bundle, appConfig);
  assert.ok('accessToken' in fresh && fresh.accessToken.length > 0, 'token refresh produced an access token');

  const account = await dropboxAdapter.connectAndReadAccount(fresh, appConfig);
  assert.ok(account.providerAccountId.length > 0, 'stable Dropbox account id returned');

  const root = await dropboxAdapter.ensureAppRoot!(fresh, appConfig);
  assert.ok(root.remoteRootId.length > 0);
  const again = await dropboxAdapter.ensureAppRoot!(fresh, appConfig);
  assert.equal(again.remoteRootId, root.remoteRootId, 'root creation is idempotent');

  const objectKey = `smoke-${Date.now()}.bin`;
  const payload = Buffer.from('CloudNest Dropbox live smoke payload');
  let remoteId: string | null = null;
  try {
    const ref = await dropboxAdapter.uploadObjectStream!(
      fresh,
      { rootId: root.remoteRootId, objectKey, name: objectKey, readable: Readable.from(payload), sizeBytes: payload.length },
      appConfig,
    );
    remoteId = ref.remoteObjectId;
    assert.equal(ref.sizeBytes, payload.length, 'remote size matches the sent bytes');

    const found = await dropboxAdapter.findAppObjectByKey!(fresh, root.remoteRootId, objectKey, appConfig);
    assert.equal(found?.remoteObjectId, remoteId, 'object is recoverable by its app key');

    const listed = await dropboxAdapter.listAppObjects!(fresh, root.remoteRootId, appConfig);
    assert.ok(listed.some((o) => o.remoteObjectId === remoteId), 'the smoke object is inside the CloudNest root');

    const downloaded = await dropboxAdapter.downloadObjectStream!(fresh, remoteId, appConfig);
    let roundTrip = Buffer.alloc(0);
    for await (const chunk of downloaded.stream) roundTrip = Buffer.concat([roundTrip, Buffer.from(chunk as Buffer)]);
    assert.deepEqual(roundTrip, payload, 'downloaded bytes match the uploaded bytes');
  } finally {
    if (remoteId) {
      const cleanup = await dropboxAdapter.deleteAppObject!(fresh, root.remoteRootId, remoteId, appConfig);
      assert.equal(cleanup.deleted, true, 'the smoke-test object was cleaned up');
    }
  }
});
