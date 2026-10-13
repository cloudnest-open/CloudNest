import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pcloudAdapter } from '../src/providers/pcloud.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * OPT-IN live smoke test for the pCloud connector.
 * Runs ONLY when CLOUDNEST_LIVE_PCLOUD=1 and the credential variables exist,
 * so an ordinary `npm test` never touches a real pCloud account:
 *   CLOUDNEST_LIVE_PCLOUD=1
 *   CLOUDNEST_LIVE_PCLOUD_ACCESS_TOKEN
 *   CLOUDNEST_LIVE_PCLOUD_HOST   (optional; must be api.pcloud.com or eapi.pcloud.com)
 *
 * Objects are created inside the CloudNest-owned folder and deleted in cleanup.
 */
const enabled = process.env['CLOUDNEST_LIVE_PCLOUD'] === '1';
const accessToken = process.env['CLOUDNEST_LIVE_PCLOUD_ACCESS_TOKEN'] ?? '';
const host = process.env['CLOUDNEST_LIVE_PCLOUD_HOST'] ?? 'api.pcloud.com';
const hasCreds = enabled && accessToken !== '';

test('live pCloud smoke test (opt-in)', { skip: !hasCreds ? 'set CLOUDNEST_LIVE_PCLOUD=1 and CLOUDNEST_LIVE_PCLOUD_ACCESS_TOKEN to run' : false }, async () => {
  const bundle: ProviderCredentialBundle = {
    schemaVersion: 1,
    provider: 'pcloud',
    accessToken,
    apiHost: host === 'eapi.pcloud.com' ? 'eapi.pcloud.com' : 'api.pcloud.com',
    userId: '',
  };

  const account = await pcloudAdapter.connectAndReadAccount(bundle);
  assert.ok(account.providerAccountId.length > 0, 'pCloud user id returned');

  const root = await pcloudAdapter.ensureAppRoot!(bundle);
  const again = await pcloudAdapter.ensureAppRoot!(bundle);
  assert.equal(again.remoteRootId, root.remoteRootId, 'root creation is idempotent');

  const objectKey = `smoke-${Date.now()}.bin`;
  const payload = Buffer.from('CloudNest pCloud live smoke payload');
  let remoteId: string | null = null;
  try {
    const ref = await pcloudAdapter.uploadObjectStream!(
      bundle,
      { rootId: root.remoteRootId, objectKey, name: objectKey, readable: Readable.from(payload), sizeBytes: payload.length },
    );
    remoteId = ref.remoteObjectId;
    assert.equal(ref.sizeBytes, payload.length, 'remote size matches the sent bytes');

    const found = await pcloudAdapter.findAppObjectByKey!(bundle, root.remoteRootId, objectKey);
    assert.equal(found?.remoteObjectId, remoteId, 'object is recoverable by its app key');

    const listed = await pcloudAdapter.listAppObjects!(bundle, root.remoteRootId);
    assert.ok(listed.some((o) => o.remoteObjectId === remoteId), 'the smoke object is inside the CloudNest folder');

    const downloaded = await pcloudAdapter.downloadObjectStream!(bundle, remoteId);
    let roundTrip = Buffer.alloc(0);
    for await (const chunk of downloaded.stream) roundTrip = Buffer.concat([roundTrip, Buffer.from(chunk as Buffer)]);
    assert.deepEqual(roundTrip, payload, 'downloaded bytes match the uploaded bytes');
  } finally {
    if (remoteId) {
      const cleanup = await pcloudAdapter.deleteAppObject!(bundle, root.remoteRootId, remoteId);
      assert.equal(cleanup.deleted, true, 'the smoke-test object was cleaned up');
    }
  }
});
