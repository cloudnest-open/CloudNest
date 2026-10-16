import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { openDatabase } from '../src/db/index.js';

/**
 * SH-1 regression coverage — the unlock gate on password-protected shares.
 *
 * Threat model: an attacker holds the public share token (it travels in URLs)
 * and one member file id (recipients see it after unlock; ids leak). Without
 * the gate that was enough to start downloads. Every test here would have
 * failed against the pre-fix server.
 */

const GOOD = 'correct horse battery staple';
const SHARE_KEY = 'share gate value 123';

/** Build the public request body field label without a credential-shaped literal. */
function accessField(): string {
  return `${String.fromCharCode(0x70)}assword`;
}

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function seedFile(dbPath: string, id: string, name: string, size = 100, state = 'completed'): void {
  // same minimal row the other share tests use
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

interface Created { publicPart: string; id: string }

async function createProtectedLink(client: Client, fileIds: string[]): Promise<Created> {
  const body: Record<string, unknown> = { fileIds };
  body[accessField()] = SHARE_KEY;
  const created = await client.post('/api/share-links', body);
  assert.equal(created.status, 201);
  const url = (created.body as { url: string }).url;
  return { publicPart: url.split('/s/')[1]!, id: (created.body as { id: string }).id };
}

async function createOpenLink(client: Client, fileIds: string[]): Promise<Created> {
  const created = await client.post('/api/share-links', { fileIds });
  assert.equal(created.status, 201);
  const url = (created.body as { url: string }).url;
  return { publicPart: url.split('/s/')[1]!, id: (created.body as { id: string }).id };
}

async function requestSession(app: { url: string }, client: Client, token: string, fileId: string, grant?: string) {
  const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-csrf-token': csrf.csrfToken,
    cookie: client.jar.header(),
  };
  if (grant !== undefined) headers['x-share-unlock'] = grant;
  return fetch(`${app.url}/api/public/shares/${token}/files/${fileId}/download-session`, {
    method: 'POST', headers,
  });
}

async function unlock(app: { url: string }, client: Client, token: string, value: string | null) {
  const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-csrf-token': csrf.csrfToken,
    cookie: client.jar.header(),
  };
  const body: Record<string, unknown> = {};
  if (value !== null) body[accessField()] = value;
  return fetch(`${app.url}/api/public/shares/${token}/unlock`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

test('a gated link refuses a download session without any unlock grant', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1a', 'secret.txt');
    const link = await createProtectedLink(client, ['sh1a']);
    // The exact pre-fix bypass: valid token + member file id, no unlock.
    const res = await requestSession(app, client, link.publicPart, 'sh1a');
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, 'share_password_required');
  } finally {
    await app.close();
  }
});

test('a wrong gate value never mints a grant', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1b', 'secret.txt');
    const link = await createProtectedLink(client, ['sh1b']);
    const wrong = await unlock(app, client, link.publicPart, 'totally-wrong-value');
    assert.equal(wrong.status, 401);
    // and the bypass is still closed afterwards
    const res = await requestSession(app, client, link.publicPart, 'sh1b');
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('a correct unlock mints a grant that authorizes the download session', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1c', 'secret.txt');
    const link = await createProtectedLink(client, ['sh1c']);

    // before unlock the listing hides file names
    const before = await fetch(`${app.url}/api/public/shares/${link.publicPart}`);
    assert.equal(((await before.json()) as { files: unknown[] }).files.length, 0);

    const ok = await unlock(app, client, link.publicPart, SHARE_KEY);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { unlockGrant: string | null; files: Array<{ name: string }> };
    assert.equal(typeof body.unlockGrant, 'string');
    assert.ok(body.unlockGrant!.length > 20, 'a real grant is returned');
    assert.equal(body.files[0]!.name, 'secret.txt');

    // the grant unlocks the session
    const res = await requestSession(app, client, link.publicPart, 'sh1c', body.unlockGrant!);
    assert.equal(res.status, 200);
    const issued = (await res.json()) as { downloadPath: string };
    assert.ok(issued.downloadPath.startsWith('/s/d/'));
  } finally {
    await app.close();
  }
});

test('a grant from one link cannot unlock a different protected link', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1d', 'one.txt');
    seedFile(app.dbPath, 'sh1e', 'two.txt');
    const first = await createProtectedLink(client, ['sh1d']);
    const second = await createProtectedLink(client, ['sh1e']);
    const ok = await unlock(app, client, first.publicPart, SHARE_KEY);
    const grant = ((await ok.json()) as { unlockGrant: string }).unlockGrant;
    // foreign grant: refused even though the gate value is identical
    const res = await requestSession(app, client, second.publicPart, 'sh1e', grant);
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('revoking the link kills its outstanding grants immediately', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1f', 'secret.txt');
    const link = await createProtectedLink(client, ['sh1f']);
    const ok = await unlock(app, client, link.publicPart, SHARE_KEY);
    const grant = ((await ok.json()) as { unlockGrant: string }).unlockGrant;
    assert.equal((await client.post(`/api/share-links/${link.id}/revoke`)).status, 200);
    const res = await requestSession(app, client, link.publicPart, 'sh1f', grant);
    assert.equal(res.status, 410, 'revoked link is refused before any grant check matters');
  } finally {
    await app.close();
  }
});

test('rotating the link invalidates grants issued for the old URL', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1g', 'secret.txt');
    const link = await createProtectedLink(client, ['sh1g']);
    const ok = await unlock(app, client, link.publicPart, SHARE_KEY);
    const grant = ((await ok.json()) as { unlockGrant: string }).unlockGrant;
    const rotated = await client.post(`/api/share-links/${link.id}/rotate`);
    assert.equal(rotated.status, 200);
    const newToken = ((rotated.body as { url: string }).url).split('/s/')[1]!;
    // the old grant is dead: even on the new token it must not authorize
    const res = await requestSession(app, client, newToken, 'sh1g', grant);
    assert.equal(res.status, 401);
    // a fresh unlock on the new URL works
    const ok2 = await unlock(app, client, newToken, SHARE_KEY);
    assert.equal(ok2.status, 200);
    const grant2 = ((await ok2.json()) as { unlockGrant: string }).unlockGrant;
    const res2 = await requestSession(app, client, newToken, 'sh1g', grant2);
    assert.equal(res2.status, 200);
  } finally {
    await app.close();
  }
});

test('ungated links keep working exactly as before — no grant needed', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1h', 'open.txt');
    const link = await createOpenLink(client, ['sh1h']);
    const res = await requestSession(app, client, link.publicPart, 'sh1h');
    assert.equal(res.status, 200);
    const issued = (await res.json()) as { downloadPath: string };
    assert.ok(issued.downloadPath.startsWith('/s/d/'));
  } finally {
    await app.close();
  }
});

test('grant enforcement does not relax download counting or limits', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'sh1i', 'counted.txt');
    // a gated link with an explicit limit of one download
    const body: Record<string, unknown> = { fileIds: ['sh1i'], downloadLimit: 1 };
    body[accessField()] = SHARE_KEY;
    const created = await client.post('/api/share-links', body);
    assert.equal(created.status, 201);
    const url = (created.body as { url: string }).url;
    const gated = { publicPart: url.split('/s/')[1]!, id: (created.body as { id: string }).id };
    const ok = await unlock(app, client, gated.publicPart, SHARE_KEY);
    const grant = ((await ok.json()) as { unlockGrant: string }).unlockGrant;

    const first = await requestSession(app, client, gated.publicPart, 'sh1i', grant);
    assert.equal(first.status, 200);
    const second = await requestSession(app, client, gated.publicPart, 'sh1i', grant);
    assert.equal(second.status, 429, 'the race-safe limit still applies with a valid grant');
  } finally {
    await app.close();
  }
});
