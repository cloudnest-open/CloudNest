import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { openDatabase } from '../src/db/index.js';

/** M11.c/f — route-level share + deletion behaviour over real HTTP. */

const GOOD = 'correct horse battery staple';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function seedFile(dbPath: string, id: string, name: string, size = 100, state = 'completed'): void {
  const { db, close } = openDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, manifest_hash, created_at, completed_at)
       VALUES (?, 'usr_admin', ?, ?, 'text/plain', 100, 1, ?, ?, ?, ?)`,
    ).run(id, name, size, state, 'a'.repeat(64), now, now);
  } finally {
    close();
  }
}

test('share routes require an authenticated admin', async () => {
  const { app } = await authed();
  try {
    const anon = new Client(app.url);
    assert.equal((await anon.get('/api/share-links')).status, 401);
    const created = await fetch(`${app.url}/api/share-links`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileIds: ['x'] }),
    });
    assert.equal(created.status, 401);
  } finally {
    await app.close();
  }
});

test('creating a link requires CSRF and returns the raw URL exactly once', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f1', 'report.txt');
    const noCsrf = await fetch(`${app.url}/api/share-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: client.jar.header() },
      body: JSON.stringify({ fileIds: ['f1'] }),
    });
    assert.equal(noCsrf.status, 403);

    const created = await client.post('/api/share-links', { fileIds: ['f1'] });
    assert.equal(created.status, 201);
    const url = (created.body as { url: string }).url;
    assert.ok(url.includes('/s/'));

    // the listing must never repeat the raw token
    const list = await client.get('/api/share-links');
    const raw = url.split('/s/')[1]!;
    assert.ok(!JSON.stringify(list.body).includes(raw), 'the raw token is never listed');
    const link = (list.body as { links: Array<{ id: string; state: string; fileCount: number }> }).links[0]!;
    assert.equal(link.state, 'active');
    assert.equal(link.fileCount, 1);
  } finally {
    await app.close();
  }
});

test('the public landing view discloses nothing for a password-protected link', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f2', 'private.txt');
    const created = await client.post('/api/share-links', { fileIds: ['f2'], password: 'a-strong-passphrase-1' });
    assert.equal(created.status, 201);
    const token = (created.body as { url: string }).url.split('/s/')[1]!;

    // the landing view is public but discloses no file names
    const landing = await fetch(`${app.url}/api/public/shares/${token}`);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('cache-control'), 'no-store');
    const body = (await landing.json()) as { requiresPassword: boolean; files: unknown[] };
    assert.equal(body.requiresPassword, true);
    assert.deepEqual(body.files, [], 'no names before unlock');

    // a wrong password is refused
    const badToken = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
    const wrong = await fetch(`${app.url}/api/public/shares/${token}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': badToken.csrfToken, cookie: client.jar.header() },
      body: JSON.stringify({ password: 'wrong-passphrase-here' }),
    });
    assert.equal(wrong.status, 401);

    // the correct password reveals the listing
    const right = await fetch(`${app.url}/api/public/shares/${token}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': badToken.csrfToken, cookie: client.jar.header() },
      body: JSON.stringify({ password: 'a-strong-passphrase-1' }),
    });
    assert.equal(right.status, 200);
    const unlocked = (await right.json()) as { files: Array<{ name: string }> };
    assert.equal(unlocked.files[0]!.name, 'private.txt');
  } finally {
    await app.close();
  }
});

test('an unknown or revoked public token is refused generically', async () => {
  const { app, client } = await authed();
  try {
    const unknown = await fetch(`${app.url}/api/public/shares/not-a-token`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code?: string }).code, 'share_not_found');

    seedFile(app.dbPath, 'f3', 'a.txt');
    const created = await client.post('/api/share-links', { fileIds: ['f3'] });
    const token = (created.body as { url: string }).url.split('/s/')[1]!;
    const id = (created.body as { id: string }).id;
    assert.equal((await client.post(`/api/share-links/${id}/revoke`)).status, 200);
    const revoked = await fetch(`${app.url}/api/public/shares/${token}`);
    assert.equal(revoked.status, 410);
  } finally {
    await app.close();
  }
});

test('a download session can only be issued for a file inside the link', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f4', 'a.txt');
    seedFile(app.dbPath, 'f5', 'b.txt');
    const created = await client.post('/api/share-links', { fileIds: ['f4'] });
    const token = (created.body as { url: string }).url.split('/s/')[1]!;
    const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };

    // a file not in the collection cannot be authorized
    const outside = await fetch(`${app.url}/api/public/shares/${token}/files/f5/download-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken, cookie: client.jar.header() },
    });
    assert.equal(outside.status, 404);

    // the member file yields a temporary path and consumes one start
    const inside = await fetch(`${app.url}/api/public/shares/${token}/files/f4/download-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken, cookie: client.jar.header() },
    });
    assert.equal(inside.status, 200);
    const issued = (await inside.json()) as { downloadPath: string };
    assert.ok(issued.downloadPath.startsWith('/s/d/'), 'a temporary path is issued, never a provider URL');

    // the listing now reports one consumed start
    const list = await client.get('/api/share-links');
    const link = (list.body as { links: Array<{ downloadCount: number }> }).links[0]!;
    assert.equal(link.downloadCount, 1);
  } finally {
    await app.close();
  }
});

test('a revoked link invalidates an outstanding download session immediately', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f6', 'a.txt');
    const created = await client.post('/api/share-links', { fileIds: ['f6'] });
    const token = (created.body as { url: string }).url.split('/s/')[1]!;
    const id = (created.body as { id: string }).id;
    const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
    const session = await fetch(`${app.url}/api/public/shares/${token}/files/f6/download-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken, cookie: client.jar.header() },
    });
    const path = ((await session.json()) as { downloadPath: string }).downloadPath;

    // the session is usable before revocation
    const before = await fetch(`${app.url}${path}`, { method: 'HEAD' });
    assert.equal(before.status, 200);

    await client.post(`/api/share-links/${id}/revoke`);
    const after = await fetch(`${app.url}${path}`, { method: 'HEAD' });
    assert.equal(after.status, 410, 'revocation must reach outstanding sessions');
  } finally {
    await app.close();
  }
});

test('an expired link cannot issue a download session', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f7', 'a.txt');
    const created = await client.post('/api/share-links', {
      fileIds: ['f7'],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const token = (created.body as { url: string }).url.split('/s/')[1]!;
    const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
    const res = await fetch(`${app.url}/api/public/shares/${token}/files/f7/download-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken, cookie: client.jar.header() },
    });
    assert.equal(res.status, 410);
  } finally {
    await app.close();
  }
});

test('deletion is admin+CSRF protected, trashes first, purges through the durable engine', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f8', 'a.txt');
    const noCsrf = await fetch(`${app.url}/api/files/f8`, { method: 'DELETE', headers: { cookie: client.jar.header() } });
    assert.equal(noCsrf.status, 403);

    // Phase 4: DELETE moves to trash — 200, not 202; nothing is queued yet.
    const trashed = await client.send('DELETE', '/api/files/f8');
    assert.equal(trashed.status, 200);
    const trashedBody = trashed.body as { trashedAt: string; purgeAfter: string };
    assert.ok(trashedBody.trashedAt);
    assert.ok(trashedBody.purgeAfter);

    // the file leaves the normal listing but is recoverable in the trash
    const list = await client.get('/api/files');
    assert.equal((list.body as { files: Array<{ id: string }> }).files.some((f) => f.id === 'f8'), false);
    const trash = await client.get('/api/trash');
    assert.equal((trash.body as { files: Array<{ id: string }> }).files.some((f) => f.id === 'f8'), true);

    // purge hands the file to the durable deletion engine
    const queued = await client.post('/api/files/f8/purge');
    assert.equal(queued.status, 202);
    const jobId = (queued.body as { jobId: string }).jobId;
    assert.ok(jobId);

    const retry = await client.post(`/api/deletions/${jobId}/retry`);
    assert.equal(retry.status, 200);
    const result = (retry.body as { result: { state: string } }).result;
    assert.equal(result.state, 'completed', 'a file with no remote objects deletes cleanly');

    const status = await client.get(`/api/deletions/${jobId}`);
    assert.equal((status.body as { deletion: { state: string } }).deletion.state, 'completed');
  } finally {
    await app.close();
  }
});

test('deleting a file revokes its links over HTTP', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f9', 'a.txt');
    const created = await client.post('/api/share-links', { fileIds: ['f9'] });
    const token = (created.body as { url: string }).url.split('/s/')[1]!;
    // Phase 4: the trash is where links die — a trashed file must not stay
    // reachable through its share link while it waits in the restore window.
    const trashed = await client.send('DELETE', '/api/files/f9');
    assert.equal(trashed.status, 200);
    const landing = await fetch(`${app.url}/api/public/shares/${token}`);
    assert.equal(landing.status, 410, 'the link dies with the file');
  } finally {
    await app.close();
  }
});

test('share listings never expose tokens, hashes or provider internals', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f10', 'a.txt');
    await client.post('/api/share-links', { fileIds: ['f10'] });
    const list = await client.get('/api/share-links');
    const serialized = JSON.stringify(list.body);
    for (const forbidden of ['token_hash', 'password_hash', 'credential', 'accessToken', 'remote_object']) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must never appear`);
    }
    assert.equal(list.headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
  }
});

test('the public landing read is rate-limited', async () => {
  const { app } = await authed();
  try {
    // hammer the landing route past its per-key limit: the first requests
    // answer the honest 404, then the limiter takes over
    let last = 0;
    for (let i = 0; i < 121; i++) {
      last = (await fetch(`${app.url}/api/public/shares/not-a-token`)).status;
    }
    assert.equal(last, 429);
    const after = await fetch(`${app.url}/api/public/shares/not-a-token`);
    assert.equal(((await after.json()) as { error?: string }).error, 'share_rate_limited');
  } finally {
    await app.close();
  }
});
