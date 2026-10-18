import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { TunnelService, TunnelError, hostOriginGuard, isStateChangingMethod, tunnelIdFromToken } from '../src/tunnel/tunnel-service.js';
import { CredentialKey } from '../src/providers/encryption.js';
import type { CloudflareDnsRecord, CloudflareTunnelApi } from '../src/tunnel/cloudflare-api.js';

/**
 * M12.b tunnel hardening.
 *
 * Each test below fails if the corresponding fix is reverted:
 * - the Global-API-Key refusal must be reached by the START path, not just by
 *   the static helper (it was dead code before);
 * - the runtime token must never be written in plaintext (it used to be);
 * - the DNS pre-check must refuse a record CloudNest does not own instead of
 *   overwriting it;
 * - the CNAME must point at the tunnel id inside the runtime token, never at a
 *   guessed value (an unreadable token means no DNS is touched at all);
 * - the Host/Origin guard must reject an unknown host.
 */

const FAKE_BINARY = '/usr/local/bin/cloudflared';
/** A real remotely-managed token carries the tunnel id in its `t` field. */
const FAKE_TUNNEL_ID = '0123456789abcdef0123456789abcdef';

function fakeRuntimeToken(tunnelId = FAKE_TUNNEL_ID): string {
  return Buffer.from(JSON.stringify({ a: 'account-id', t: tunnelId, s: 'secret-material' })).toString('base64');
}

function makeTunnel(dir: string, over: {
  api?: CloudflareTunnelApi;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  binary?: string | null;
} = {}): TunnelService {
  const key = CredentialKey.loadOrCreate(dir, false);
  const tunnel = new TunnelService(dir, {
    keyProvider: () => key,
    apiFactory: over.api ?? (() => { throw new Error('no API expected in this test'); }),
    spawnImpl: over.spawnImpl ?? (() => { throw new Error('no spawn expected in this test'); }),
  });
  // Pin the binary discovery so the test does not depend on the host having
  // cloudflared installed; `null` simulates a machine without it.
  const binary = over.binary === undefined ? FAKE_BINARY : over.binary;
  Object.defineProperty(tunnel, 'cloudflaredPath', { value: () => binary, configurable: true });
  return tunnel;
}

/** A fake cloudflared child that never exits on its own. */
function fakeChild(): ChildProcess {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child = {
    killed: false,
    kill() { this.killed = true; return true; },
    once(event: string, handler: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return child;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return child;
    },
  };
  return child as unknown as ChildProcess;
}

function fakeApi(over: Partial<CloudflareTunnelApi> = {}): CloudflareTunnelApi {
  return {
    verifyToken: async () => ({ ok: true, safeErrorCode: null }),
    listZones: async () => [{ id: 'zone-1', name: 'example.com' }],
    findDnsRecord: async () => null,
    createCname: async (zoneId, hostname, target) => ({
      id: 'rec-1', zoneId, name: hostname, type: 'CNAME', content: target,
    } as unknown) as CloudflareDnsRecord,
    ...over,
  };
}

test('the START path itself refuses a Cloudflare Global API Key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir);
  // 37 hex characters: the shape of a Global API Key, which must never be used
  const globalKey = '0123456789abcdef0123456789abcdef01234';
  await assert.rejects(
    () => tunnel.start({ runtimeToken: globalKey, hostname: 'files.example.com' }),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'global_api_key_not_accepted',
  );
  assert.equal(tunnel.hasStoredToken(), false, 'a refused token is never stored');
});

test('a stored runtime token is encrypted at rest and never leaves plaintext', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir);
  const secret = `cf-${'Zq7Wm2Kp9R'.repeat(3)}`;
  tunnel.saveRuntimeToken(secret, { hostname: 'files.example.com' });
  const stored = tunnel.tokenPath();
  const onDisk = fs.readFileSync(stored, 'utf8');
  assert.ok(!onDisk.includes(secret), 'the plaintext token must not appear on disk');
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600, 'the ciphertext file is restrictive');
});

test('a start with no scoped Cloudflare token makes no DNS change (local-only path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  let apiTouched = false;
  const tunnel = makeTunnel(dir, {
    api: fakeApi({ verifyToken: async () => { apiTouched = true; return { ok: true, safeErrorCode: null }; } }),
    spawnImpl: () => fakeChild(),
  });
  const result = await tunnel.start({ runtimeToken: 'a'.repeat(40), hostname: 'files.example.com' });
  assert.equal(apiTouched, false, 'no Cloudflare call happens without a scoped token');
  assert.equal(result.dnsRecord, null);
  assert.ok(result.dnsActions.some((action) => action.includes('skipped')), 'the skip is reported honestly');
  tunnel.stop();
});

test('a DNS record CloudNest does not own is refused instead of overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir, {
    api: fakeApi({
      findDnsRecord: async (zoneId, hostname) => ({
        id: 'foreign-1', zoneId, name: hostname, type: 'A', content: '203.0.113.10',
      } as unknown) as CloudflareDnsRecord,
    }),
    spawnImpl: () => fakeChild(),
  });
  await assert.rejects(
    () => tunnel.start({
      runtimeToken: fakeRuntimeToken(),
      hostname: 'files.example.com',
      cloudflareToken: 'b'.repeat(40),
    }),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'dns_record_conflict',
  );
  assert.equal(tunnel.hasStoredToken(), false, 'nothing is stored when the pre-check refuses');
});

test('an existing CloudNest-owned CNAME is reused and a missing one is created', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-reuse-'));
  let created = 0;
  // the CNAME target must be the REAL tunnel id carried inside the runtime token
  const target = `${FAKE_TUNNEL_ID}.cfargotunnel.com`;
  const tunnel = makeTunnel(dir, {
    api: fakeApi({
      findDnsRecord: async (zoneId, hostname) => ({
        id: 'owned-1', zoneId, name: hostname, type: 'CNAME', content: target,
      } as unknown) as CloudflareDnsRecord,
      createCname: async (zoneId, hostname, content) => {
        created += 1;
        return { id: 'new', zoneId, name: hostname, type: 'CNAME', content } as unknown as CloudflareDnsRecord;
      },
    }),
    spawnImpl: () => fakeChild(),
  });
  const result = await tunnel.start({
    runtimeToken: fakeRuntimeToken(),
    hostname: 'files.example.com',
    cloudflareToken: 'b'.repeat(40),
  });
  assert.equal(created, 0, 'an owned record is reused, never recreated');
  assert.equal(result.dnsRecord?.id, 'owned-1');
  tunnel.stop();
});

test('a newly created CNAME points at the real tunnel id from the token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-create-'));
  let createdWith: string | null = null;
  const tunnel = makeTunnel(dir, {
    api: fakeApi({
      createCname: async (zoneId, hostname, content) => {
        createdWith = content;
        return { id: 'new', zoneId, name: hostname, type: 'CNAME', content } as unknown as CloudflareDnsRecord;
      },
    }),
    spawnImpl: () => fakeChild(),
  });
  await tunnel.start({
    runtimeToken: fakeRuntimeToken(),
    hostname: 'files.example.com',
    cloudflareToken: 'b'.repeat(40),
  });
  assert.equal(createdWith, `${FAKE_TUNNEL_ID}.cfargotunnel.com`, 'the route targets the token’s own tunnel');
  tunnel.stop();
});

test('a runtime token whose tunnel id cannot be read never touches DNS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-unreadable-'));
  let apiTouched = false;
  const tunnel = makeTunnel(dir, {
    api: fakeApi({ verifyToken: async () => { apiTouched = true; return { ok: true, safeErrorCode: null }; } }),
    spawnImpl: () => fakeChild(),
  });
  await assert.rejects(
    () => tunnel.start({
      // passes the shape guard but is not a decodable remotely-managed token
      runtimeToken: 'definitely-not-a-real-tunnel-token-value',
      hostname: 'files.example.com',
      cloudflareToken: 'b'.repeat(40),
    }),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'tunnel_token_unreadable',
  );
  assert.equal(apiTouched, false, 'no Cloudflare call is made when the tunnel id is unknown');
  assert.equal(tunnel.hasStoredToken(), false, 'nothing is stored');
});

test('tunnelIdFromToken extracts only a valid tunnel id', () => {
  assert.equal(tunnelIdFromToken(fakeRuntimeToken(FAKE_TUNNEL_ID)), FAKE_TUNNEL_ID);
  assert.equal(tunnelIdFromToken(fakeRuntimeToken('A'.repeat(32))), 'a'.repeat(32), 'case is normalised');
  assert.equal(tunnelIdFromToken('not-base64-json'), null);
  assert.equal(tunnelIdFromToken(Buffer.from('{"a":"x"}').toString('base64')), null, 'a missing t field is null');
  assert.equal(
    tunnelIdFromToken(Buffer.from(JSON.stringify({ t: '../../etc/passwd' })).toString('base64')),
    null,
    'an id that is not a tunnel id shape is rejected',
  );
});

test('an unusable Cloudflare token fails with its own safe code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const tunnel = makeTunnel(dir, {
    api: fakeApi({ verifyToken: async () => ({ ok: false, safeErrorCode: 'cloudflare_token_verify_failed' }) }),
    spawnImpl: () => fakeChild(),
  });
  await assert.rejects(
    () => tunnel.start({
      runtimeToken: fakeRuntimeToken(),
      hostname: 'files.example.com',
      cloudflareToken: 'b'.repeat(40),
    }),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'cloudflare_token_verify_failed',
  );
});

test('the spawn call never interpolates user data and uses a fixed argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-'));
  const seen: { command: string; args: readonly string[] }[] = [];
  const tunnel = makeTunnel(dir, {
    spawnImpl: (command, args) => {
      seen.push({ command, args });
      return fakeChild();
    },
  });
  await tunnel.start({ runtimeToken: 'a'.repeat(40), hostname: 'files.example.com' });
  assert.equal(seen.length, 1, 'exactly one spawn');
  assert.equal(seen[0]!.command, FAKE_BINARY, 'a fixed absolute binary is executed');
  assert.deepEqual(
    [...seen[0]!.args],
    ['tunnel', '--no-autoupdate', 'run', '--token-file', path.join(dir, 'tunnel', 'runtime-token.tmp')],
    'the argv array is fixed and the token travels by file, never as an argument',
  );
  tunnel.stop();
});

test('the host/Origin guard rejects an unknown Host and a bad Origin', () => {
  const guard = hostOriginGuard({ allowedHosts: ['127.0.0.1:8787', 'files.example.com'] });
  const run = (headers: Record<string, string>, method = 'POST') => {
    let status = 200;
    let body: unknown = null;
    let nextCalled = false;
    const req = { headers, method } as unknown as Parameters<typeof guard>[0];
    const res = {
      status(code: number) { status = code; return res; },
      json(payload: unknown) { body = payload; return res; },
    } as unknown as Parameters<typeof guard>[1];
    guard(req, res, () => { nextCalled = true; });
    return { status, body, nextCalled };
  };

  const spoofed = run({ host: 'evil.example.net', origin: 'https://evil.example.net' });
  assert.equal(spoofed.status, 421, 'an unknown Host is rejected');
  assert.equal(spoofed.nextCalled, false);

  const badOrigin = run({ host: 'files.example.com', origin: 'https://evil.example.net' });
  assert.equal(badOrigin.status, 403, 'a foreign Origin on a state-changing request is rejected');

  const allowed = run({ host: 'files.example.com', origin: 'https://files.example.com' });
  assert.equal(allowed.nextCalled, true, 'the configured public hostname passes');

  const local = run({ host: '127.0.0.1:8787' });
  assert.equal(local.nextCalled, true, 'the local hostname passes');

  // a read-only request is not Origin-gated, but Host is still enforced
  const getBadHost = run({ host: 'evil.example.net' }, 'GET');
  assert.equal(getBadHost.status, 421, 'Host is enforced for reads too');
});

test('only state-changing methods are treated as such', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(isStateChangingMethod(method), true);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(isStateChangingMethod(method), false);
});

test('the temp token file is created exclusively and a stale file is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tunnel-tok-'));
  try {
    const tunnel = makeTunnel(dir);
    const access = tunnel as unknown as { materializeTempTokenFile: (token: string) => string };
    const first = access.materializeTempTokenFile(fakeRuntimeToken());
    assert.equal(fs.statSync(first).mode & 0o777, 0o600, 'the file is 0600 at creation');

    // a leftover file from a previous run must be replaced, never reused
    fs.writeFileSync(first, 'stale-material-from-a-previous-run');
    const second = access.materializeTempTokenFile(fakeRuntimeToken());
    assert.equal(second, first, 'the same runtime path is used');
    assert.equal(fs.readFileSync(second, 'utf8'), fakeRuntimeToken(), 'the stale content is gone');
    assert.equal(fs.statSync(second).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
