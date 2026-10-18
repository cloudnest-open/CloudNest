import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { CredentialKey } from '../src/providers/encryption.js';
import { TunnelService, TunnelError } from '../src/tunnel/tunnel-service.js';

/**
 * Browser-authorized tunnel (approved design §6): the cloudflared login flow,
 * cert/credentials encrypted at rest, the create → route dns → run spawn
 * sequence, the connector-log health signal, stop-keeps-authorization and the
 * explicit forget. All cloudflared processes are fakes; nothing live runs.
 */

interface SpawnCall { command: string; args: string[] }

class FakeChild extends EventEmitter {
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(private readonly onKill?: () => void) {
    super();
  }
  kill(): void {
    this.killed = true;
    this.onKill?.();
    this.emit('exit', 0);
  }
}

function makeFakeSpawn(script: (call: SpawnCall, child: FakeChild) => void) {
  const calls: SpawnCall[] = [];
  const spawnImpl = (command: string, args: readonly string[], _options: unknown): ChildProcess => {
    const call = { command, args: [...args] };
    calls.push(call);
    const child = new FakeChild();
    // let the caller's script act (write files, emit output, exit)
    setImmediate(() => script(call, child));
    return child as unknown as ChildProcess;
  };
  return { calls, spawnImpl };
}

function makeTunnel(dir: string, spawnImpl: (command: string, args: readonly string[], options: never) => ChildProcess): TunnelService {
  const key = CredentialKey.loadOrCreate(dir, false);
  return new TunnelService(dir, { keyProvider: () => key, spawnImpl: spawnImpl as never });
}

function seedAuthorization(tunnel: TunnelService, credJson: string): void {
  tunnel.browserAuth.storeCert('-----BEGIN PRIVATE KEY-----\nproof-body\n-----END PRIVATE KEY-----\n');
  tunnel.browserAuth.storeCredJson(credJson);
}

const CRED_JSON = JSON.stringify({ TunnelID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', AccountTag: 'acc', TunnelSecret: 'secret-body' });

test('login scrapes the authorize URL and stores the cert encrypted (plaintext removed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tlogin-'));
  let stdoutEmit: ((chunk: string) => void) | null = null;
  const { spawnImpl } = makeFakeSpawn((call, child) => {
    assert.deepEqual(call.args.slice(0, 2), ['tunnel', 'login']);
    assert.ok(call.args.includes('--origincert'));
    // the URL arrives FIRST (cloudflared prints it and waits); only after the
    // owner approves does the cert land and the process exit
    stdoutEmit = (chunk: string) => child.stdout.emit('data', chunk);
    setImmediate(() => {
      child.stdout.emit('data', 'Please open the following URL and log in:\n\nhttps://dash.cloudflare.com/argotunnel?aud=&ca=3\n');
    });
  });
  const tunnel = makeTunnel(dir, spawnImpl as never);
  const started = tunnel.browserAuth.startLogin();
  assert.equal(started.state, 'authorizing');
  // the URL arrives from cloudflared's own output
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tunnel.browserAuth.status().authUrl, 'https://dash.cloudflare.com/argotunnel?aud=&ca=3');
  // the owner approves in the browser: cloudflared writes the cert, exits 0
  const loginCall = { args: ['tunnel', 'login', '--origincert', tunnel.browserAuth.plaintextCertPath()] } as { args: string[] };
  void loginCall;
  const certPath = tunnel.browserAuth.plaintextCertPath();
  fs.writeFileSync(certPath, '-----BEGIN PRIVATE KEY-----\nreal-cert-body\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
  // simulate cloudflared's successful exit (kill() emits exit 0 on the fake)
  (tunnel.browserAuth as unknown as { loginChild: FakeChild | null }).loginChild?.kill();
  await new Promise((r) => setTimeout(r, 40));
  const status = tunnel.browserAuth.status();
  assert.equal(status.state, 'authorized', JSON.stringify(status));
  assert.equal(status.authUrl, null, 'the one-time URL is not retained after completion');
  assert.equal(status.certStored, true);
  // the plaintext cert never survives
  assert.equal(fs.existsSync(tunnel.browserAuth.plaintextCertPath()), false);
  // the stored blob is encrypted + 0600
  const blobPath = path.join(dir, 'tunnel', 'cert.pem.enc');
  const bytes = fs.readFileSync(blobPath).toString('utf8');
  assert.ok(!bytes.includes('real-cert-body'), 'the cert body never appears on disk');
  assert.equal(fs.statSync(blobPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed login lands in the honest failed state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tlogin2-'));
  const { spawnImpl } = makeFakeSpawn((_call, child) => {
    child.emit('exit', 1);
  });
  const tunnel = makeTunnel(dir, spawnImpl as never);
  tunnel.browserAuth.startLogin();
  await new Promise((r) => setTimeout(r, 40));
  const status = tunnel.browserAuth.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.safeErrorCode, 'tunnel_login_failed');
  assert.equal(status.certStored, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start reuses stored credentials and spawns route dns then run with fixed argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tstart-'));
  const { calls, spawnImpl } = makeFakeSpawn((call, child) => {
    if (call.args[0] === 'tunnel' && call.args[1] === 'route') {
      assert.deepEqual(call.args.slice(0, 3), ['tunnel', 'route', 'dns']);
      assert.ok(call.args.includes('--origincert'));
      // the temp cert helper file must exist while the step runs
      const certTmp = call.args[call.args.indexOf('--origincert') + 1] ?? '';
      assert.equal(fs.existsSync(certTmp), true, 'the cert helper file exists during route dns');
      child.emit('exit', 0);
      return;
    }
    if (call.args[0] === 'tunnel' && call.args[2] === 'run') {
      // the connector keeps running until stopped; its argv is asserted in the
      // test body (this script fires after start() has returned)
      return;
    }
    // no other cloudflared invocation is expected here
    assert.fail(`unexpected spawn: ${call.args.join(' ')}`);
  });
  const tunnel = makeTunnel(dir, spawnImpl as never);
  seedAuthorization(tunnel, CRED_JSON);
  const result = await tunnel.start({ hostname: 'files.example.com' });
  assert.ok(result.actions.some((a) => a.includes('reused')), JSON.stringify(result.actions));
  assert.equal(result.status.state, 'starting');
  assert.equal(result.status.hostname, 'files.example.com');
  assert.ok(calls.length >= 2, `expected route+run spawns, got ${calls.length}`);
  // run argv, asserted here while the temp file provably exists
  const runCall = calls.find((c) => c.args[2] === 'run');
  assert.ok(runCall, 'the connector was spawned');
  assert.equal(runCall?.args[1], '--no-autoupdate');
  assert.equal(runCall?.args[3], '--cred-file');
  const credTmp = runCall?.args[4] ?? '';
  assert.equal(fs.existsSync(credTmp), true);
  assert.equal(fs.statSync(credTmp).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(credTmp).toString('utf8').includes('TunnelID'), 'the decrypted credentials ride the temp file');
  // the temp cert helper never survives the start
  assert.equal(fs.existsSync(tunnel.browserAuth.plaintextCertPath()), false);

  // connector-log health: the connector's own success line
  const logPath = path.join(dir, 'tunnel', 'cloudflared.log');
  fs.writeFileSync(logPath, '[tunnel] starting cloudflared for files.example.com\nINF Registered tunnel connection\n', { mode: 0o600 });
  const check = tunnel.checkConnection();
  assert.equal(check.registered, true);

  // stop keeps the authorization (Reconnect never re-asks the browser)
  tunnel.stop();
  assert.equal(tunnel.browserAuth.certStored(), true);
  assert.equal(tunnel.browserAuth.credStored(), true);
  // forget is the explicit start-over
  tunnel.forgetAuthorization();
  assert.equal(tunnel.browserAuth.certStored(), false);
  assert.equal(tunnel.status().hostname, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start without stored credentials runs tunnel create once, then route+run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tcreate-'));
  const { calls, spawnImpl } = makeFakeSpawn((call, child) => {
    if (call.args[1] === 'create') {
      assert.deepEqual(call.args.slice(0, 2), ['tunnel', 'create']);
      assert.ok(call.args.includes('cloudnest'), 'the fixed tunnel name');
      const credPath = call.args[call.args.indexOf('--cred-file') + 1] ?? '';
      fs.writeFileSync(credPath, CRED_JSON, { mode: 0o600 });
      child.emit('exit', 0);
      return;
    }
    if (call.args[1] === 'route') {
      child.emit('exit', 0);
      return;
    }
    if (call.args[2] === 'run') {
      return; // the connector keeps running
    }
    assert.fail(`unexpected spawn: ${call.args.join(' ')}`);
  });
  const tunnel = makeTunnel(dir, spawnImpl as never);
  tunnel.browserAuth.storeCert('-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\n');
  const result = await tunnel.start({ hostname: 'nest.example.com' });
  assert.ok(result.actions.some((a) => a.includes('created')), JSON.stringify(result.actions));
  assert.equal(tunnel.browserAuth.credStored(), true, 'the created credentials are encrypted into place');
  const kinds = calls.map((c) => (c.args[2] === 'run' ? 'run' : c.args[1]));
  assert.deepEqual(kinds, ['create', 'route', 'run']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unsafe hostname or a missing authorization never spawns anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-tsafe-'));
  const { calls, spawnImpl } = makeFakeSpawn(() => {
    assert.fail('no cloudflared process may start');
  });
  const tunnel = makeTunnel(dir, spawnImpl as never);
  await assert.rejects(
    () => tunnel.start({ hostname: 'bad host; rm -rf /' }),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'invalid_tunnel_hostname',
  );
  await assert.rejects(
    () => tunnel.start({ hostname: 'files.example.com' }),
    (e: unknown) => e instanceof TunnelError && (e as TunnelError).safeCode === 'tunnel_not_authorized',
  );
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
