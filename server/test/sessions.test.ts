import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

const GOOD = 'correct horse battery staple';

test('session cookie flags: name, HttpOnly, SameSite, Path, 12h max-age', async () => {
  const app = await startTestApp();
  try {
    const res = await fetch(`${app.url}/api/auth/csrf-token`);
    const all = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
    const sidCookie = all.find((c) => c.startsWith('cloudnest.sid='));
    assert.ok(sidCookie, 'session cookie present');
    assert.ok(/HttpOnly/i.test(sidCookie), 'HttpOnly');
    assert.ok(/SameSite=Lax/i.test(sidCookie), 'SameSite=Lax');
    assert.ok(/Path=\//.test(sidCookie), 'Path=/');
    assert.ok(!/Secure/i.test(sidCookie), 'no Secure in local mode');
    // express-session expresses the 12h lifetime as an Expires timestamp (rolling)
    const expires = /Expires=([^;]+)/.exec(sidCookie ?? '')?.[1];
    assert.ok(expires, 'Expires present');
    const ttlMs = new Date(expires).getTime() - Date.now();
    const twelveHours = 12 * 60 * 60 * 1000;
    assert.ok(ttlMs > twelveHours - 60_000 && ttlMs <= twelveHours, '12h idle expiry');
  } finally {
    await app.close();
  }
});

test('expired sessions are treated as absent', async () => {
  const app = await startTestApp();
  try {
    const client = new Client(app.url);
    await client.setup(GOOD);
    // force-expire every stored session
    const { openDatabase } = await import('../src/db/index.js');
    const { db, close } = openDatabase(app.dbPath);
    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
    close();
    const me = await client.get('/api/auth/me');
    assert.deepEqual(me.body, { authenticated: false });
  } finally {
    await app.close();
  }
});

test('deleted session (server-side) is rejected immediately', async () => {
  const app = await startTestApp();
  try {
    const client = new Client(app.url);
    await client.setup(GOOD);
    const { openDatabase } = await import('../src/db/index.js');
    const { db, close } = openDatabase(app.dbPath);
    db.prepare('DELETE FROM sessions').run();
    close();
    const me = await client.get('/api/auth/me');
    assert.deepEqual(me.body, { authenticated: false });
  } finally {
    await app.close();
  }
});

test('sid stored hashed: raw session id never in the database', async () => {
  const app = await startTestApp();
  try {
    const client = new Client(app.url);
    await client.setup(GOOD);
    const sid = client.jar.header().match(/cloudnest\.sid=([^;]+)/)?.[1] ?? '';
    const { openDatabase } = await import('../src/db/index.js');
    const { db, close } = openDatabase(app.dbPath);
    const rows = db.prepare('SELECT sid_hash FROM sessions').all() as Array<{ sid_hash: string }>;
    close();
    assert.ok(rows.length >= 1);
    for (const row of rows) assert.ok(!row.sid_hash.includes(sid));
  } finally {
    await app.close();
  }
});
