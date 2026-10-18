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
    assert.deepEqual(me.body, { authenticated: true, kind: 'admin', role: 'admin', username: 'admin', displayName: 'admin', userId: 'usr_admin' });
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
    assert.deepEqual(okMe.body, { authenticated: true, kind: 'admin', role: 'admin', username: 'admin', displayName: 'admin', userId: 'usr_admin' });
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

/** Invite a member, let them set a password, and return their logged-in client. */
async function invitedMember(app: { url: string }, admin: Client, email: string, password: string) {
  const invited = await admin.post('/api/users', {
    email,
    displayName: email.split('@')[0] ?? email,
    role: 'member',
    allowanceBytes: null,
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const { acceptUrl } = invited.body as { acceptUrl: string };
  const token = new URL(acceptUrl).searchParams.get('token') ?? '';
  const claimer = new Client(app.url);
  const claimed = await claimer.post('/api/auth/accept-invite', { token, password, confirm: password });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const client = new Client(app.url);
  const login = await client.send('POST', '/api/auth/login', { username: email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return client;
}

test('admin renames the login name: new name signs in, old name retires, session survives', async () => {
  const { app, client } = await loggedIn();
  try {
    // a second pre-existing session must survive the rename (no forced logout)
    const bystander = new Client(app.url);
    await bystander.login(GOOD);

    const renamed = await client.post('/api/auth/change-username', {
      currentPassword: GOOD,
      newUsername: 'nest-keeper',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual(renamed.body, { ok: true, username: 'nest-keeper' });

    // the renaming session itself is untouched and shows the new name
    const me = await client.get('/api/auth/me');
    assert.equal((me.body as { authenticated: boolean; username?: string }).authenticated, true);
    assert.equal((me.body as { username?: string }).username, 'nest-keeper');
    // the bystander session survives too
    const bystanderMe = await bystander.get('/api/auth/me');
    assert.equal((bystanderMe.body as { authenticated: boolean }).authenticated, true);
    assert.equal((bystanderMe.body as { username?: string }).username, 'nest-keeper');

    // the users attribution row carries the same name
    const users = await client.get('/api/users');
    const adminRow = ((users.body as { users: Array<{ email: string }> }).users ?? []).find((u) => u.email === 'nest-keeper');
    assert.ok(adminRow, 'the admin attribution row follows the rename');

    // the new name signs in (case-insensitively, like member emails)
    const fresh = new Client(app.url);
    assert.equal((await fresh.send('POST', '/api/auth/login', { username: 'nest-keeper', password: GOOD })).status, 200);
    assert.equal((await fresh.send('POST', '/api/auth/login', { username: 'Nest-Keeper', password: GOOD })).status, 200);
    // the old name retires
    assert.equal((await fresh.send('POST', '/api/auth/login', { username: 'admin', password: GOOD })).status, 401);
  } finally {
    await app.close();
  }
});

test('rename re-proofs the current password and validates the name', async () => {
  const { app, client } = await loggedIn();
  try {
    const wrong = await client.post('/api/auth/change-username', {
      currentPassword: 'not the password',
      newUsername: 'nest-keeper',
    });
    assert.equal(wrong.status, 401);
    assert.equal((wrong.body as { error?: string }).error, 'Current password is incorrect.');

    const unchanged = await client.post('/api/auth/change-username', {
      currentPassword: GOOD,
      newUsername: 'admin',
    });
    assert.equal(unchanged.status, 400);
    assert.equal((unchanged.body as { code?: string }).code, 'username_unchanged');

    for (const bad of ['with space', '', '   ']) {
      const invalid = await client.post('/api/auth/change-username', {
        currentPassword: GOOD,
        newUsername: bad,
      });
      assert.equal(invalid.status, 400, JSON.stringify(bad));
      assert.equal((invalid.body as { code?: string }).code, 'invalid_username');
    }
  } finally {
    await app.close();
  }
});

test('rename refuses a name a member already holds, and members cannot rename', async () => {
  const { app, client } = await loggedIn();
  try {
    const member = await invitedMember(app, client, 'casey@example.com', 'member passphrase here');

    const taken = await client.post('/api/auth/change-username', {
      currentPassword: GOOD,
      newUsername: 'casey@example.com',
    });
    assert.equal(taken.status, 409);
    assert.equal((taken.body as { code?: string }).code, 'username_taken');

    const forbidden = await member.post('/api/auth/change-username', {
      currentPassword: 'member passphrase here',
      newUsername: 'casey',
    });
    assert.equal(forbidden.status, 403);

    // the member keeps working after the admin's (refused) attempts
    assert.equal((await member.get('/api/files')).status, 200);
  } finally {
    await app.close();
  }
});

test('the retired name is free again: renaming back restores the old login', async () => {
  const { app, client } = await loggedIn();
  try {
    assert.equal((await client.post('/api/auth/change-username', { currentPassword: GOOD, newUsername: 'nest-keeper' })).status, 200);
    assert.equal((await client.post('/api/auth/change-username', { currentPassword: GOOD, newUsername: 'admin' })).status, 200);
    const fresh = new Client(app.url);
    assert.equal((await fresh.send('POST', '/api/auth/login', { username: 'admin', password: GOOD })).status, 200);
    assert.equal((await fresh.send('POST', '/api/auth/login', { username: 'nest-keeper', password: GOOD })).status, 401);
  } finally {
    await app.close();
  }
});
