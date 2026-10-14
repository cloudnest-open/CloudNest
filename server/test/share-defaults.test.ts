import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, Client } from './helpers.js';
import { openDatabase } from '../src/db/index.js';
import { SettingsService } from '../src/settings/settings-service.js';

/**
 * M12.a — the share settings are real server-side defaults, not decoration.
 *
 * Every case goes through the shipped HTTP API: a preference is saved with
 * PATCH /api/settings and the resulting link is read back from the database, so
 * a control that only looks wired in the UI cannot pass these tests.
 */

const GOOD = 'correct horse battery staple';
const DAY_MS = 24 * 60 * 60 * 1000;
/** The fixed appBaseUrl startTestApp() passes into createApp(). */
const APP_BASE_URL = 'http://127.0.0.1:8787';

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
      `INSERT INTO files (id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, manifest_hash, created_at, completed_at)
       VALUES (?, ?, ?, 'text/plain', 100, 1, ?, ?, ?, ?)`,
    ).run(id, name, size, state, 'a'.repeat(64), now, now);
  } finally {
    close();
  }
}

interface StoredLink {
  expires_at: string | null;
  download_limit: number | null;
  password_hash: string | null;
  state: string;
}

/** The persisted policy of one link, read from the database the app itself uses. */
function linkRow(dbPath: string, id: string): StoredLink {
  const { db, close } = openDatabase(dbPath);
  try {
    const row = db.prepare(
      'SELECT expires_at, download_limit, password_hash, state FROM share_links WHERE id = ?',
    ).get(id) as StoredLink | undefined;
    assert.ok(row, `share row ${id} must exist`);
    return row;
  } finally {
    close();
  }
}

function countLinks(dbPath: string): number {
  const { db, close } = openDatabase(dbPath);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM share_links').get() as { n: number }).n;
  } finally {
    close();
  }
}

/** Save settings through the real settings API and fail loudly if refused. */
async function configure(client: Client, patch: Record<string, unknown>): Promise<void> {
  const res = await client.patch('/api/settings', patch);
  assert.equal(res.status, 200, `saving ${JSON.stringify(patch)} must be accepted: ${JSON.stringify(res.body)}`);
}

function tokenOf(url: string): string {
  const token = url.split('/s/')[1];
  assert.ok(token && token.length >= 32, 'a random raw token is issued');
  return token;
}

test('with no settings saved, creation keeps its pre-settings behaviour exactly', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f1', 'report.txt');

    // the fresh database really is at the documented defaults
    const raw = openDatabase(app.dbPath);
    const settings = new SettingsService(raw.db);
    try {
      assert.equal(settings.get('share.defaultExpiryDays'), null, 'no default expiry');
      assert.equal(settings.get('share.defaultDownloadLimit'), null, 'no default limit');
      assert.equal(settings.get('share.requirePassword'), false, 'passwords are optional');
      assert.equal(settings.get('domain.publicBaseUrl'), null, 'no public base URL');
    } finally {
      raw.close();
    }

    const created = await client.post('/api/share-links', { fileIds: ['f1'] });
    assert.equal(created.status, 201);
    const { id, url } = created.body as { id: string; url: string };
    tokenOf(url);
    assert.ok(url.startsWith(`${APP_BASE_URL}/s/`), `the app base URL is used: ${url}`);

    const row = linkRow(app.dbPath, id);
    assert.equal(row.expires_at, null, 'no expiry is invented');
    assert.equal(row.download_limit, null, 'no limit is invented');
    assert.equal(row.password_hash, null, 'the link stays open as before');
    assert.equal(row.state, 'active');
  } finally {
    await app.close();
  }
});

test('share.defaultExpiryDays bounds a new link, and an explicit expiry still wins', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f2', 'a.txt');
    await configure(client, { 'share.defaultExpiryDays': 7 });

    // omitted in the body: the configured default becomes a real timestamp
    const before = Date.now();
    const created = await client.post('/api/share-links', { fileIds: ['f2'] });
    const after = Date.now();
    assert.equal(created.status, 201);
    const { id, url } = created.body as { id: string; url: string };
    const stored = linkRow(app.dbPath, id).expires_at;
    assert.ok(stored, 'an omitted expiry must no longer mean "never"');
    const when = Date.parse(stored);
    assert.ok(when >= before + 7 * DAY_MS - 1000 && when <= after + 7 * DAY_MS + 1000,
      `expiry must be ~now + 7 days, got ${stored}`);

    // the configured expiry is genuinely enforced by the public route
    const landing = await fetch(`${app.url}/api/public/shares/${tokenOf(url)}`);
    assert.equal(landing.status, 200);
    assert.equal((await landing.json() as { expiresAt: string | null }).expiresAt, stored);

    // an explicit body expiry overrides the setting, verbatim
    const explicit = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const explicitRes = await client.post('/api/share-links', { fileIds: ['f2'], expiresAt: explicit });
    assert.equal(explicitRes.status, 201);
    assert.equal(linkRow(app.dbPath, (explicitRes.body as { id: string }).id).expires_at, explicit);

    // configured null restores "never expires"
    await configure(client, { 'share.defaultExpiryDays': null });
    const unlimited = await client.post('/api/share-links', { fileIds: ['f2'] });
    assert.equal(unlimited.status, 201);
    assert.equal(linkRow(app.dbPath, (unlimited.body as { id: string }).id).expires_at, null);
  } finally {
    await app.close();
  }
});

test('share.defaultDownloadLimit applies, yields to an explicit value, and never stores 0 or less', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f3', 'a.txt');
    await configure(client, { 'share.defaultDownloadLimit': 3 });

    // omitted: the configured default is stored
    const omitted = await client.post('/api/share-links', { fileIds: ['f3'] });
    assert.equal(omitted.status, 201);
    assert.equal(linkRow(app.dbPath, (omitted.body as { id: string }).id).download_limit, 3);

    // explicit positive value wins
    const explicit = await client.post('/api/share-links', { fileIds: ['f3'], downloadLimit: 5 });
    assert.equal(explicit.status, 201);
    assert.equal(linkRow(app.dbPath, (explicit.body as { id: string }).id).download_limit, 5);

    // an explicit 0 means "use the setting", so 0 is never persisted
    const zero = await client.post('/api/share-links', { fileIds: ['f3'], downloadLimit: 0 });
    assert.equal(zero.status, 201);
    assert.equal(linkRow(app.dbPath, (zero.body as { id: string }).id).download_limit, 3);

    // a negative value is refused in the safe error style, and stores nothing
    const before = countLinks(app.dbPath);
    const negative = await client.post('/api/share-links', { fileIds: ['f3'], downloadLimit: -1 });
    assert.equal(negative.status, 400);
    assert.equal((negative.body as { code?: string }).code, 'invalid_share_metadata');
    assert.equal(countLinks(app.dbPath), before, 'a refused request creates no link');

    // configured null keeps a link unlimited
    await configure(client, { 'share.defaultDownloadLimit': null });
    const unlimited = await client.post('/api/share-links', { fileIds: ['f3'] });
    assert.equal(unlimited.status, 201);
    assert.equal(linkRow(app.dbPath, (unlimited.body as { id: string }).id).download_limit, null);
  } finally {
    await app.close();
  }
});

test('share.requirePassword refuses an unprotected link instead of creating one', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f4', 'private.txt');
    await configure(client, { 'share.requirePassword': true });
    const before = countLinks(app.dbPath);

    const refused = await client.post('/api/share-links', { fileIds: ['f4'] });
    assert.equal(refused.status, 400);
    const body = refused.body as { error?: string; code?: string };
    assert.equal(body.code, 'share_password_required_by_policy');
    assert.equal(body.error, 'share_password_required_by_policy');
    assert.equal(countLinks(app.dbPath), before, 'the refusal must not create a share row');

    // supplying a password still creates a genuinely protected link
    const withPassword = await client.post('/api/share-links', { fileIds: ['f4'], password: 'a-strong-share-passphrase' });
    assert.equal(withPassword.status, 201);
    const { id, url } = withPassword.body as { id: string; url: string };
    assert.ok(linkRow(app.dbPath, id).password_hash, 'the link is really password protected');

    const landing = await fetch(`${app.url}/api/public/shares/${tokenOf(url)}`);
    assert.equal(landing.status, 200);
    const view = await landing.json() as { requiresPassword: boolean; files: unknown[] };
    assert.equal(view.requiresPassword, true);
    assert.deepEqual(view.files, [], 'nothing is disclosed before unlock');

    // an empty password counts as "no password" and is refused too
    const empty = await client.post('/api/share-links', { fileIds: ['f4'], password: '' });
    assert.equal(empty.status, 400);
    assert.equal((empty.body as { code?: string }).code, 'share_password_required_by_policy');
  } finally {
    await app.close();
  }
});

test('the configured public base URL is the origin of both new and rotated links', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f5', 'a.txt');
    await configure(client, { 'domain.publicBaseUrl': 'https://files.example.com' });

    const created = await client.post('/api/share-links', { fileIds: ['f5'] });
    assert.equal(created.status, 201);
    const { id, url } = created.body as { id: string; url: string };
    assert.ok(url.startsWith('https://files.example.com/s/'), `the configured origin is used: ${url}`);

    const rotated = await client.post(`/api/share-links/${id}/rotate`);
    assert.equal(rotated.status, 200);
    const rotatedUrl = (rotated.body as { url: string }).url;
    assert.ok(rotatedUrl.startsWith('https://files.example.com/s/'), `a rotated link keeps the origin: ${rotatedUrl}`);
    assert.notEqual(rotatedUrl, url, 'rotation issues a new token');

    // a spoofed forwarding chain must never reach the link
    const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
    const forbidden = await client.post('/api/share-links', { fileIds: ['f5'] }, {
      'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example',
    });
    assert.equal(forbidden.status, 201);
    assert.ok(!(forbidden.body as { url: string }).url.includes('evil.example'), 'forwarded headers cannot redirect a share link');
    assert.ok((forbidden.body as { url: string }).url.startsWith('https://files.example.com/s/'));
    assert.ok(csrf.csrfToken.length > 0);

    // clearing the setting returns to the app base URL
    await configure(client, { 'domain.publicBaseUrl': null });
    const fallback = await client.post('/api/share-links', { fileIds: ['f5'] });
    assert.equal(fallback.status, 201);
    assert.ok((fallback.body as { url: string }).url.startsWith(`${APP_BASE_URL}/s/`));
  } finally {
    await app.close();
  }
});

test('a spoofed Host header is refused outright and can never change a share link', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, 'f6', 'a.txt');
    await configure(client, { 'domain.publicBaseUrl': 'https://files.example.com' });
    const csrf = (await client.get('/api/auth/csrf-token')).body as { csrfToken: string };
    const payload = JSON.stringify({ fileIds: ['f6'] });
    const port = Number(new URL(app.url).port);

    const send = (host: string) => new Promise<{ status: number; body: { url?: string; code?: string } }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/share-links',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          cookie: client.jar.header(),
          'x-csrf-token': csrf.csrfToken,
          host,
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as { url?: string; code?: string } : {} }));
      });
      req.on('error', reject);
      req.end(payload);
    });

    // an unknown Host never reaches a route: the guard refuses it with 421, so
    // no link can be minted from a hostile name at all
    const before = countLinks(app.dbPath);
    const refused = await send('attacker.example');
    assert.equal(refused.status, 421, `an unknown Host must be refused, got ${refused.status}`);
    assert.equal(refused.body.code, 'host_not_allowed');
    assert.equal(countLinks(app.dbPath), before, 'a refused request creates no link');

    // the same request with the real local Host is handled, and the link is
    // still built from the configured public base URL, never from Host
    const allowed = await send(`127.0.0.1:${port}`);
    assert.equal(allowed.status, 201, `the real host is accepted, got ${allowed.status}`);
    assert.ok(allowed.body.url?.startsWith('https://files.example.com/s/'), `Host must be ignored for links: ${allowed.body.url ?? '(no url)'}`);
    assert.ok(!allowed.body.url?.includes('attacker.example'));
  } finally {
    await app.close();
  }
});
