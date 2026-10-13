import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { megaAdapter } from '../src/providers/mega.js';
import type { ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * OPT-IN live smoke test for the MEGA connector (EXPERIMENTAL).
 * Runs ONLY when CLOUDNEST_LIVE_MEGA=1 plus credentials are set, so an ordinary
 * `npm test` never touches a real MEGA account:
 *   CLOUDNEST_LIVE_MEGA=1
 *   CLOUDNEST_LIVE_MEGA_EMAIL
 *   CLOUDNEST_LIVE_MEGA_PASSWORD   (a dedicated TEST account, never a real one)
 *
 * Two-factor codes are not accepted here: a 2FA-protected account must be
 * tested interactively, not in automation.
 *
 * This test PASSING is the documented precondition for raising MEGA's
 * advertised capabilities; per M8's acceptance criteria the connector stays
 * `experimental` until upload, download, quota, delete, retry and recovery are
 * all proven.
 */
const enabled = process.env['CLOUDNEST_LIVE_MEGA'] === '1';
const email = process.env['CLOUDNEST_LIVE_MEGA_EMAIL'] ?? '';
const password = process.env['CLOUDNEST_LIVE_MEGA_PASSWORD'] ?? '';
const hasCreds = enabled && email !== '' && password !== '';

test('live MEGA smoke test (opt-in, experimental)', { skip: !hasCreds ? 'set CLOUDNEST_LIVE_MEGA=1 plus CLOUDNEST_LIVE_MEGA_EMAIL and CLOUDNEST_LIVE_MEGA_PASSWORD to run' : false }, async () => {
  const bundle: ProviderCredentialBundle = { schemaVersion: 1, provider: 'mega', email, password };

  const account = await megaAdapter.connectAndReadAccount(bundle);
  assert.ok(account.providerAccountId.length > 0, 'stable account identity returned');

  const root = await megaAdapter.ensureAppRoot!(bundle);
  const again = await megaAdapter.ensureAppRoot!(bundle);
  assert.equal(again.remoteRootId, root.remoteRootId, 'the CloudNest root is idempotent');

  const objectKey = `smoke-${Date.now()}.bin`;
  const payload = Buffer.from('CloudNest MEGA live smoke payload');
  let remoteId: string | null = null;
  try {
    const ref = await megaAdapter.uploadObjectStream!(
      bundle,
      { rootId: root.remoteRootId, objectKey, name: objectKey, readable: Readable.from(payload), sizeBytes: payload.length },
    );
    remoteId = ref.remoteObjectId;
    assert.equal(ref.sizeBytes, payload.length, 'remote size matches the sent bytes');

    const found = await megaAdapter.findAppObjectByKey!(bundle, root.remoteRootId, objectKey);
    assert.equal(found?.remoteObjectId, remoteId, 'object is recoverable by its app key');

    const listed = await megaAdapter.listAppObjects!(bundle, root.remoteRootId);
    assert.ok(listed.some((o) => o.remoteObjectId === remoteId), 'the smoke object is inside the CloudNest folder');

    const downloaded = await megaAdapter.downloadObjectStream!(bundle, remoteId);
    let roundTrip = Buffer.alloc(0);
    for await (const chunk of downloaded.stream) roundTrip = Buffer.concat([roundTrip, Buffer.from(chunk as Buffer)]);
    assert.deepEqual(roundTrip, payload, 'downloaded bytes match the uploaded bytes');
  } finally {
    if (remoteId) {
      const cleanup = await megaAdapter.deleteAppObject!(bundle, root.remoteRootId, remoteId);
      assert.equal(cleanup.deleted, true, 'the smoke-test object was cleaned up');
    }
  }

  // A successful run is the evidence needed before capabilities may be raised.
  console.log('MEGA live smoke test passed: upload, find, list, download and delete all verified.');
});
