import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { installTestAdapter, clearTestAdapters } from '../src/providers/registry.js';
import { ProviderError, type ProviderAdapter, type ProviderCredentialBundle } from '../src/providers/types.js';

/**
 * Batch-2 connect wizard (approved design 2026-10-18 §1–§4): one honest
 * already_connected refusal per provider identity, a silent token-refresh
 * Reconnect, Test/Verify, Edit-Replace credentials for S3/MEGA, MEGA 2FA
 * forwarding, and the S3 provider display name. All on fake adapters — no
 * live provider is touched.
 */

const GOOD = 'correct horse battery staple';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function googleLikeFake(): ProviderAdapter {
  return makeFakeReturning({ providerAccountId: 'ident-google-a', displayLabel: 'a@fake.example' });
}

function makeFakeReturning(identity: { providerAccountId: string; displayLabel: string }): ProviderAdapter {
  return {
    id: 'google_drive',
    experimental: false,
    displayName: 'Fake Google',
    requiresAppConfig: true,
    capabilities: { upload: true, download: true, list: true },
    async connectAndReadAccount() { return { ...identity, quota: { totalBytes: 10 * 1024 ** 3, usedBytes: 0, status: 'current' as const } }; },
    async getQuota() { return { totalBytes: 10 * 1024 ** 3, usedBytes: 0, status: 'current' as const }; },
    async ensureValidCredentials(bundle) { return bundle; },
  };
}

/** The callback runs the REAL token exchange; stub ONLY the provider token
 * endpoint (same-provider-e2e pattern) so the fake adapter answers identity
 * while the app's own HTTP calls pass through untouched. */
function withStubbedTokenExchange(run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (u.startsWith('https://oauth2.googleapis.com/')) {
      return new Response(JSON.stringify({ access_token: 'at-example', refresh_token: 'rt-example', expires_in: 3600, scope: 'fake' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = realFetch;
  });
}

/** Drive the OAuth round-trip against the real HTTP surface. */
async function oauthRoundTrip(client: Client, provider: string, code: string): Promise<{ status: number; location: string }> {
  const start = await client.post(`/api/providers/${provider}/oauth/start`, {});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const url = (start.body as { authorizationUrl: string }).authorizationUrl;
  const state = new URL(url).searchParams.get('state') ?? '';
  const res = await client.get(`/api/providers/${provider}/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`);
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

function s3Fake(identityLabel = 'bkt@fake'): ProviderAdapter {
  return {
    id: 's3',
    experimental: false,
    displayName: 'Fake S3',
    requiresAppConfig: false,
    capabilities: { upload: true, download: true, list: true },
    async connectAndReadAccount() { return { providerAccountId: 'ident-s3-fixed', displayLabel: identityLabel, quota: { totalBytes: 1000, usedBytes: 0, status: 'current' as const } }; },
    async getQuota() { return { totalBytes: 1000, usedBytes: 0, status: 'current' as const }; },
    async ensureValidCredentials(bundle) { return bundle; },
  };
}

test('same provider account twice answers already_connected; reconnect still upserts its own row', async () => {
  const { app, client } = await authed();
  installTestAdapter('google_drive', googleLikeFake());
  await withStubbedTokenExchange(async () => {
    await runAlreadyConnectedFlow(app, client);
  });
});

async function runAlreadyConnectedFlow(app: Awaited<ReturnType<typeof startTestApp>>, client: Client): Promise<void> {
  try {
    const cfg = await client.put('/api/providers/google_drive/config', { clientId: 'cid', clientSecret: 'csecret' });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));

    const first = await oauthRoundTrip(client, 'google_drive', 'code-1');
    assert.match(first.location, /connect=connected/);
    let list = (await client.get('/api/provider-accounts')).body as { accounts: Array<{ id: string; provider: string }> };
    assert.equal(list.accounts.length, 1);
    const rowId = list.accounts[0]?.id;

    // the SAME identity again (fresh Connect, no reconnectOf): honest refusal
    const second = await oauthRoundTrip(client, 'google_drive', 'code-2');
    assert.match(second.location, /connect=already_connected/);
    list = (await client.get('/api/provider-accounts')).body as typeof list;
    assert.equal(list.accounts.length, 1, 'the duplicate must not create a second row');

    // the wizard's Reconnect (state carries reconnectOf) upserts its own row
    const rec = await client.post(`/api/provider-accounts/${rowId}/reconnect`, {});
    assert.equal(rec.status, 200);
    const url = (rec.body as { authorizationUrl: string }).authorizationUrl;
    const state = new URL(url).searchParams.get('state') ?? '';
    const back = await client.get(`/api/providers/google_drive/oauth/callback?code=code-3&state=${encodeURIComponent(state)}`);
    assert.match(back.headers.get('location') ?? '', /connect=connected/);
    list = (await client.get('/api/provider-accounts')).body as typeof list;
    assert.equal(list.accounts.length, 1);
    assert.equal(list.accounts[0]?.id, rowId);

    // silent token-refresh Reconnect (the scheduler's own path)
    const refresh = await client.post(`/api/provider-accounts/${rowId}/reconnect`, { mode: 'refresh' });
    assert.equal(refresh.status, 200);
    assert.equal((refresh.body as { mode?: string }).mode, 'refreshed');
    assert.equal((refresh.body as { result?: { ok?: boolean } }).result?.ok, true);

    // Test/Verify proves the stored credential works right now
    const verify = await client.post(`/api/provider-accounts/${rowId}/verify`, {});
    assert.equal(verify.status, 200);
    assert.equal((verify.body as { ok?: boolean }).ok, true);

    // OAuth rows refuse hand-typed credential replacement — honest pointer
    const edit = await client.post(`/api/provider-accounts/${rowId}/credentials`, { email: 'x', password: 'y' });
    assert.equal(edit.status, 409);
    assert.equal((edit.body as { code?: string }).code, 'oauth_account');
  } finally {
    clearTestAdapters();
    await app.close();
  }
}

test('two different OAuth accounts still create two rows (multi-account guarantee)', async () => {
  const { app, client } = await authed();
  let flip = false;
  const adapter: ProviderAdapter = {
    ...googleLikeFake(),
    async connectAndReadAccount() {
      flip = !flip;
      return flip
        ? { providerAccountId: 'ident-one', displayLabel: 'one@fake.example', quota: { totalBytes: 1, usedBytes: 0, status: 'current' as const } }
        : { providerAccountId: 'ident-two', displayLabel: 'two@fake.example', quota: { totalBytes: 1, usedBytes: 0, status: 'current' as const } };
    },
  };
  installTestAdapter('google_drive', adapter);
  await withStubbedTokenExchange(async () => {
    try {
      await client.put('/api/providers/google_drive/config', { clientId: 'cid', clientSecret: 'csecret' });
      const a = await oauthRoundTrip(client, 'google_drive', 'code-a');
      assert.match(a.location, /connect=connected/);
      const b = await oauthRoundTrip(client, 'google_drive', 'code-b');
      assert.match(b.location, /connect=connected/);
      const list = (await client.get('/api/provider-accounts')).body as { accounts: unknown[] };
      assert.equal(list.accounts.length, 2);
    } finally {
      clearTestAdapters();
      await app.close();
    }
  });
});

test('S3 connect carries the provider display name; PATCH keeps cap and name; verify works', async () => {
  const { app, client } = await authed();
  installTestAdapter('s3', s3Fake());
  try {
    const connect = await client.post('/api/providers/s3/credentials', {
      endpoint: 'https://s3.example.com', region: 'auto', accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example', bucket: 'proof-bucket', capacityCapBytes: 1000,
      providerName: 'Wasabi Pro',
    });
    assert.equal(connect.status, 201, JSON.stringify(connect.body));

    let list = (await client.get('/api/provider-accounts')).body as {
      accounts: Array<{ id: string; providerDisplayName: string | null; capacityCapBytes: number | null }>;
    };
    assert.equal(list.accounts.length, 1);
    assert.equal(list.accounts[0]?.providerDisplayName, 'Wasabi Pro');
    assert.equal(list.accounts[0]?.capacityCapBytes, 1000);
    const rowId = list.accounts[0]?.id as string;

    const patched = await client.patch(`/api/provider-accounts/${rowId}`, { capacityCapBytes: 2000, providerDisplayName: 'Wasabi Ultra' });
    assert.equal(patched.status, 200);
    list = (await client.get('/api/provider-accounts')).body as typeof list;
    assert.equal(list.accounts[0]?.capacityCapBytes, 2000);
    assert.equal(list.accounts[0]?.providerDisplayName, 'Wasabi Ultra');

    const verify = await client.post(`/api/provider-accounts/${rowId}/verify`, {});
    assert.equal(verify.status, 200);
    assert.equal((verify.body as { ok?: boolean }).ok, true);

    // Edit/Replace credentials on the same row (identity upsert, no new row)
    const edit = await client.post(`/api/provider-accounts/${rowId}/credentials`, {
      endpoint: 'https://s3.example.com', region: 'auto', accessKeyId: 'AKIAEXAMPLE2',
      secretAccessKey: 'secret-example-2', bucket: 'proof-bucket',
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    list = (await client.get('/api/provider-accounts')).body as typeof list;
    assert.equal(list.accounts.length, 1);
  } finally {
    clearTestAdapters();
    await app.close();
  }
});

test('MEGA forwards the 2FA code to the adapter and reports two_factor_required honestly', async () => {
  const { app, client } = await authed();
  const seen: ProviderCredentialBundle[] = [];
  const ok: ProviderAdapter = {
    id: 'mega',
    experimental: true,
    displayName: 'Fake MEGA',
    requiresAppConfig: false,
    capabilities: { upload: false, download: true, list: true },
    async connectAndReadAccount(bundle) {
      seen.push(bundle);
      return { providerAccountId: 'ident-mega-1', displayLabel: 'mega@fake.example', quota: { totalBytes: 1, usedBytes: 0, status: 'current' as const } };
    },
    async getQuota() { return { totalBytes: 1, usedBytes: 0, status: 'current' as const }; },
    async ensureValidCredentials(bundle) { return bundle; },
  };
  installTestAdapter('mega', ok);
  try {
    const connect = await client.post('/api/providers/mega/credentials', {
      email: 'mega@example.com', password: 'pw-example', secondFactorCode: '123456',
    });
    assert.equal(connect.status, 201, JSON.stringify(connect.body));
    const megaBundle = seen[0] as { secondFactorCode?: string } | undefined;
    assert.equal(megaBundle?.secondFactorCode, '123456', 'the TOTP code must reach the adapter');
  } finally {
    clearTestAdapters();
    await app.close();
  }

  // an account protected by 2FA without a code answers the distinct honest code
  const { app: app2, client: client2 } = await authed();
  const guarded: ProviderAdapter = {
    ...ok,
    async connectAndReadAccount() { throw new ProviderError('two_factor_required', 401); },
  };
  installTestAdapter('mega', guarded);
  try {
    const res = await client2.post('/api/providers/mega/credentials', {
      email: 'mega2@example.com', password: 'pw-example',
    });
    assert.equal(res.status, 401);
    assert.equal((res.body as { code?: string }).code, 'two_factor_required');
  } finally {
    clearTestAdapters();
    await app2.close();
  }
});
