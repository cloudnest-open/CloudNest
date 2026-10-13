import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

const GOOD = 'correct horse battery staple';

async function loggedIn() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

test('correct password logs in; wrong password gives generic 401', async () => {
  const { app, client } = await loggedIn();
  try {
    const bad = await client.login('wrong password entirely');
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.body, { error: 'Invalid username or password.' });
    const ok = await client.login(GOOD);
    assert.equal(ok.status, 200);
    const me = await client.get('/api/auth/me');
    assert.deepEqual(me.body, { authenticated: true, username: 'admin' });
  } finally {
    await app.close();
  }
});

test('wrong username gives the same generic error (no user enumeration)', async () => {
  const { app, client } = await loggedIn();
  try {
    const tokenRes = await client.get('/api/auth/csrf-token');
    const token = (tokenRes.body as { csrfToken: string }).csrfToken;
    const res = await client.postWithToken('/api/auth/login', { username: 'root', password: GOOD }, token);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Invalid username or password.' });
  } finally {
    await app.close();
  }
});

test('admin API rejects anonymous requests and accepts valid sessions', async () => {
  const { app, client } = await loggedIn();
  try {
    const anonClient = new Client(app.url); // fresh client, no session
    const anon = await anonClient.get('/api/admin/ping');
    assert.equal(anon.status, 401);
    await client.login(GOOD);
    const ok = await client.get('/api/admin/ping');
    assert.equal(ok.status, 200);
  } finally {
    await app.close();
  }
});

test('authVersion check: stale session is rejected after password change', async () => {
  const { app } = await loggedIn(); // admin exists now
  try {
    // client A logs in and holds a valid session
    const clientA = new Client(app.url);
    await clientA.login(GOOD);

    // client B (fresh session) changes the password -> auth_version bumps,
    // all old sessions are deleted server-side
    const clientB = new Client(app.url);
    await clientB.login(GOOD);
    const changed = await clientB.post('/api/auth/change-password', {
      currentPassword: GOOD,
      newPassword: 'a much newer passphrase 42',
      confirmNew: 'a much newer passphrase 42',
    });
    assert.equal(changed.status, 200);

    // client A's session is now stale/expired
    const staleMe = await clientA.get('/api/auth/me');
    assert.deepEqual(staleMe.body, { authenticated: false });
    const stalePing = await clientA.get('/api/admin/ping');
    assert.equal(stalePing.status, 401);

    // client B (regenerated session with the new authVersion) still works
    const okMe = await clientB.get('/api/auth/me');
    assert.deepEqual(okMe.body, { authenticated: true, username: 'admin' });
  } finally {
    await app.close();
  }
});

test('logout destroys the server-side session', async () => {
  const { app, client } = await loggedIn();
  try {
    await client.login(GOOD);
    const out = await client.post('/api/auth/logout');
    assert.equal(out.status, 200);
    const me = await client.get('/api/auth/me');
    assert.deepEqual(me.body, { authenticated: false });
  } finally {
    await app.close();
  }
});

test('rate limiting blocks excessive login attempts', async () => {
  const { app, client } = await loggedIn();
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await client.login('wrong password again ' + i);
      last = res.status;
    }
    assert.equal(last, 429);
  } finally {
    await app.close();
  }
});

test('raw password never appears in the database', async () => {
  const { app, client } = await loggedIn();
  try {
    await client.setup(GOOD);
  } catch { /* already set up in loggedIn */ }
  try {
    const { openDatabase } = await import('../src/db/index.js');
    const { db, close } = openDatabase(app.dbPath);
    try {
      const row = db.prepare('SELECT password_hash FROM admin_users WHERE id = 1').get() as { password_hash: string };
      assert.ok(!row.password_hash.includes(GOOD));
      assert.ok(row.password_hash.startsWith('scrypt$131072$8$1$'));
      const sessions = db.prepare('SELECT session_json FROM sessions').all() as Array<{ session_json: string }>;
      for (const s of sessions) assert.ok(!s.session_json.includes(GOOD));
    } finally {
      close();
    }
  } finally {
    await app.close();
  }
});
