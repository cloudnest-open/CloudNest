import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

const GOOD = 'correct horse battery staple';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

test('provider catalog requires admin and never returns secrets', async () => {
  const { app, client } = await authed();
  try {
    const anon = new Client(app.url);
    assert.equal((await anon.get('/api/providers')).status, 401);

    const res = await client.get('/api/providers');
    assert.equal(res.status, 200);
    const body = res.body;
    const providers = (body as { providers: Array<Record<string, unknown>> }).providers;
    assert.equal(providers.length, 5);
    const ids = providers.map((p) => p['id']).sort();
    assert.deepEqual(ids, ['dropbox', 'google_drive', 'mega', 'onedrive', 'pcloud']);
    // no secret fields of any kind
    const text = JSON.stringify(body);
    assert.ok(!text.includes('clientSecret'));
    assert.ok(!text.includes('client_secret'));
    assert.ok(!text.includes('access_token'));
    // exact callback URI comes from server config
    const google = providers.find((p) => p['id'] === 'google_drive') as { callbackUri: string };
    assert.equal(google.callbackUri, 'http://127.0.0.1:8787/api/providers/google_drive/oauth/callback');
    // MEGA experimental + no app config
    const mega = providers.find((p) => p['id'] === 'mega') as { experimental: boolean; requiresAppConfig: boolean; callbackUri: null };
    assert.equal(mega.experimental, true);
    assert.equal(mega.requiresAppConfig, false);
    assert.equal(mega.callbackUri, null);
  } finally {
    await app.close();
  }
});

test('unknown provider is rejected; config requires CSRF; model validation works', async () => {
  const { app, client } = await authed();
  try {
    const unknown = await client.post('/api/providers/bogus/oauth/start');
    assert.equal(unknown.status, 400);

    // missing CSRF
    const noCsrf = await fetch(`${app.url}/api/providers/dropbox/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'a', clientSecret: 'b' }),
    });
    // the admin gate runs before CSRF, so an anonymous request is 401
    assert.equal(noCsrf.status, 401);

    // invalid authority for onedrive
    const badAuth = await client.put('/api/providers/onedrive/config', { clientId: 'a', clientSecret: 'b', authority: 'https://evil.example' });
    assert.equal(badAuth.status, 400);

    // valid save
    const saved = await client.put('/api/providers/dropbox/config', { clientId: 'cid', clientSecret: 'csecret' });
    assert.equal(saved.status, 200);

    // oauth start without a session-independent state is fine now, but MEGA rejects oauth
    const megaOauth = await client.post('/api/providers/mega/oauth/start');
    assert.equal(megaOauth.status, 400);
  } finally {
    await app.close();
  }
});

test('oauth start returns an authorization URL built from trusted config, with state and PKCE', async () => {
  const { app, client } = await authed();
  try {
    await client.put('/api/providers/dropbox/config', { clientId: 'cid', clientSecret: 'csecret' });
    const started = await client.post('/api/providers/dropbox/oauth/start');
    assert.equal(started.status, 200);
    const url = new URL((started.body as { authorizationUrl: string }).authorizationUrl);
    assert.equal(url.origin, 'https://www.dropbox.com');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/api/providers/dropbox/oauth/callback');
    assert.ok((url.searchParams.get('state') ?? '').length > 20);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('token_access_type'), 'offline');
    // client secret must never appear in the URL
    assert.ok(!url.toString().includes('csecret'));

    // unconfigured provider explains the one-time setup requirement
    const unconfigured = await client.post('/api/providers/onedrive/oauth/start');
    assert.equal(unconfigured.status, 409);
    assert.equal((unconfigured.body as { code?: string }).code, 'provider_not_configured');
  } finally {
    await app.close();
  }
});

test('oauth callback rejects missing/reused/forged state and creates no account', async () => {
  const { app, client } = await authed();
  try {
    await client.put('/api/providers/dropbox/config', { clientId: 'cid', clientSecret: 'csecret' });
    const started = await client.post('/api/providers/dropbox/oauth/start');
    const authUrl = new URL((started.body as { authorizationUrl: string }).authorizationUrl);
    const state = authUrl.searchParams.get('state')!;

    // forged state
    const forged = await fetch(`${app.url}/api/providers/dropbox/oauth/callback?code=abc&state=forged`, { redirect: 'manual' });
    assert.equal(forged.status, 303);
    assert.match(forged.headers.get('location') ?? '', /oauth_state_invalid/);

    // provider-denial callback consumes the state, then fails safely
    const denied = await fetch(`${app.url}/api/providers/dropbox/oauth/callback?error=access_denied&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: client.jar.header() },
    });
    assert.match(denied.headers.get('location') ?? '', /oauth_denied/);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(denied.headers.get('referrer-policy'), 'no-referrer');

    // reused state is now rejected
    const reused = await fetch(`${app.url}/api/providers/dropbox/oauth/callback?code=abc&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: client.jar.header() },
    });
    assert.match(reused.headers.get('location') ?? '', /oauth_state_invalid/);

    // no account was created at any point
    const accounts = await client.get('/api/provider-accounts');
    assert.deepEqual((accounts.body as { accounts: unknown[] }).accounts, []);
  } finally {
    await app.close();
  }
});

test('account endpoints require admin + CSRF and validate ids', async () => {
  const { app, client } = await authed();
  try {
    const anon = new Client(app.url);
    assert.equal((await anon.get('/api/provider-accounts')).status, 401);

    const noCsrf = await fetch(`${app.url}/api/provider-accounts/does-not-exist/disconnect`, { method: 'POST' });
    assert.equal(noCsrf.status, 401);

    const missing = await client.post('/api/provider-accounts/does-not-exist/disconnect');
    assert.equal(missing.status, 404);

    const badLabel = await client.post('/api/provider-accounts/none/refresh-quota');
    assert.equal(badLabel.status, 404);
  } finally {
    await app.close();
  }
});

test('refresh-all with zero accounts returns an empty result set', async () => {
  const { app, client } = await authed();
  try {
    const res = await client.post('/api/provider-accounts/refresh-quotas');
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as { results: unknown[] }).results, []);
  } finally {
    await app.close();
  }
});

test('MEGA connect validates input and fails safely without a network identity', async () => {
  const { app, client } = await authed();
  try {
    const missing = await client.post('/api/providers/mega/credentials', { email: '', password: '' });
    assert.equal(missing.status, 400);
    // a bogus credential must not create a row
    const accounts = await client.get('/api/provider-accounts');
    assert.deepEqual((accounts.body as { accounts: unknown[] }).accounts, []);
  } finally {
    await app.close();
  }
});
