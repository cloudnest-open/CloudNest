import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, Client } from './helpers.js';
import { openDatabase } from '../src/db/index.js';

/**
 * Route-level tests for the download API (M10.c/d).
 * These assert the real HTTP contract: headers, status codes, Range handling
 * and the safety rules around filenames and caching.
 */

const GOOD = 'correct horse battery staple';

async function authed() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

function seedFile(dbPath: string, opts: {
  fileId: string; name: string; size: number; chunkSize: number; state?: string;
  chunks: Array<{ index: number; offset: number; size: number; sha256: string }>;
}): void {
  const { db, close } = openDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    // the canonical, versioned manifest hash: ordered by chunk index
    const ordered = [...opts.chunks].sort((a, b) => a.index - b.index);
    const manifest = crypto.createHash('sha256')
      .update(`v1|${ordered.map((c) => `${c.index}:${c.size}:${c.sha256}`).join('|')}`)
      .digest('hex');
    // column order and parameter order must match exactly
    db.prepare(
      `INSERT INTO files (id, user_id, original_name, size_bytes, mime_type, chunk_size_bytes, chunk_count, state, manifest_hash, created_at, completed_at)
       VALUES (?, 'usr_admin', ?, ?, 'text/plain', ?, ?, ?, ?, ?, ?)`,
    ).run(opts.fileId, opts.name, opts.size, opts.chunkSize, opts.chunks.length, opts.state ?? 'completed', manifest, now, now);
    for (const chunk of opts.chunks) {
      db.prepare(
        `INSERT INTO file_chunks (id, file_id, chunk_index, offset_bytes, size_bytes, sha256, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
      ).run(crypto.randomUUID(), opts.fileId, chunk.index, chunk.offset, chunk.size, chunk.sha256, now, now);
    }
  } finally {
    close();
  }
}

test('download routes require admin authentication', async () => {
  const { app } = await authed();
  try {
    const anon = new Client(app.url);
    assert.equal((await anon.get('/api/downloads')).status, 401);
    assert.equal((await anon.get('/api/files/any')).status, 401);
    const dl = await fetch(`${app.url}/api/files/any/download`);
    assert.equal(dl.status, 401, 'the file stream itself is admin-only');
  } finally {
    await app.close();
  }
});

test('an unknown file is a safe 404 without internals', async () => {
  const { app, client } = await authed();
  try {
    const res = await client.get('/api/files/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal((res.body as { code?: string }).code, 'file_not_found');
    const dl = await fetch(`${app.url}/api/files/does-not-exist/download`, { headers: { cookie: client.jar.header() } });
    assert.equal(dl.status, 404);
    const text = await dl.text();
    assert.ok(!text.includes('at '), 'no stack trace is exposed');
  } finally {
    await app.close();
  }
});

test('a file marked for deletion refuses download with a stable code', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, {
      fileId: 'del-1', name: 'gone.bin', size: 10, chunkSize: 10, state: 'deletion_pending',
      chunks: [{ index: 0, offset: 0, size: 10, sha256: 'a'.repeat(64) }],
    });
    const res = await fetch(`${app.url}/api/files/del-1/download`, { headers: { cookie: client.jar.header() } });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, 'deletion_pending');
  } finally {
    await app.close();
  }
});

test('HEAD returns representation metadata, no body, and creates no job', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, {
      fileId: 'head-1', name: 'report.txt', size: 20, chunkSize: 20,
      chunks: [{ index: 0, offset: 0, size: 20, sha256: 'b'.repeat(64) }],
    });
    const before = await client.get('/api/downloads');
    const head = await fetch(`${app.url}/api/files/head-1/download`, {
      method: 'HEAD',
      headers: { cookie: client.jar.header() },
    });
    assert.equal(head.status, 200, `HEAD must not require stored chunks; got ${head.status}`);
    assert.equal(head.headers.get('content-length'), '20');
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(head.headers.get('cache-control'), 'private, no-store');
    assert.ok(head.headers.get('etag')?.startsWith('"cn-'));
    const after = await client.get('/api/downloads');
    assert.equal((after.body as { total: number }).total, (before.body as { total: number }).total,
      'HEAD never records a download');
  } finally {
    await app.close();
  }
});

test('an empty file downloads as an empty 200 with Content-Length 0', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, { fileId: 'empty-1', name: 'empty.txt', size: 0, chunkSize: 10, chunks: [] });
    const res = await fetch(`${app.url}/api/files/empty-1/download`, { headers: { cookie: client.jar.header() } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), '0');
    assert.equal((await res.text()).length, 0);
    // any byte range on an empty file is unsatisfiable
    const ranged = await fetch(`${app.url}/api/files/empty-1/download`, {
      headers: { cookie: client.jar.header(), range: 'bytes=0-0' },
    });
    assert.equal(ranged.status, 416);
    assert.equal(ranged.headers.get('content-range'), 'bytes */0');
  } finally {
    await app.close();
  }
});

test('malformed ranges are 400 and unsatisfiable ranges are 416 with Content-Range', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, {
      fileId: 'rng-1', name: 'a.bin', size: 100, chunkSize: 100,
      chunks: [{ index: 0, offset: 0, size: 100, sha256: 'c'.repeat(64) }],
    });
    const malformed = await fetch(`${app.url}/api/files/rng-1/download`, {
      headers: { cookie: client.jar.header(), range: 'bytes=abc' },
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { code?: string }).code, 'invalid_range');

    const multi = await fetch(`${app.url}/api/files/rng-1/download`, {
      headers: { cookie: client.jar.header(), range: 'bytes=0-9,20-29' },
    });
    assert.equal(multi.status, 400, 'multi-range is unsupported in V1');

    const unsatisfiable = await fetch(`${app.url}/api/files/rng-1/download`, {
      headers: { cookie: client.jar.header(), range: 'bytes=500-' },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */100');
  } finally {
    await app.close();
  }
});

test('a missing chunk fails the transfer instead of delivering corrupt bytes', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, {
      fileId: 'miss-1', name: 'a.bin', size: 100, chunkSize: 100,
      chunks: [{ index: 0, offset: 0, size: 100, sha256: 'd'.repeat(64) }],
    });
    // no placement exists for the chunk, so the bytes cannot be produced
    const res = await fetch(`${app.url}/api/files/miss-1/download`, { headers: { cookie: client.jar.header() } });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, 'chunk_missing');
  } finally {
    await app.close();
  }
});

test('rename is admin+CSRF protected, strips control characters and validates the name', async () => {
  const { app, client } = await authed();
  try {
    seedFile(app.dbPath, { fileId: 'ren-1', name: 'old.txt', size: 0, chunkSize: 10, chunks: [] });
    const noCsrf = await fetch(`${app.url}/api/files/ren-1/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: client.jar.header() },
      body: JSON.stringify({ name: 'x.txt' }),
    });
    assert.equal(noCsrf.status, 403);

    const ok = await client.post('/api/files/ren-1/rename', { name: 'fresh\r\nname.txt' });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as { file: { originalName: string } }).file.originalName, 'freshname.txt');

    const empty = await client.post('/api/files/ren-1/rename', { name: '   ' });
    assert.equal(empty.status, 400);
  } finally {
    await app.close();
  }
});

test('download listings are no-store and expose no provider internals', async () => {
  const { app, client } = await authed();
  try {
    const res = await client.get('/api/downloads');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['credential', 'accessToken', 'remote_object', 'provider_account']) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must never appear`);
    }
  } finally {
    await app.close();
  }
});

test('a download can be cancelled only while it is running', async () => {
  const { app, client } = await authed();
  try {
    const missing = await client.post('/api/downloads/nope/cancel');
    assert.equal(missing.status, 404);
    seedFile(app.dbPath, { fileId: 'canc-1', name: 'a.bin', size: 0, chunkSize: 10, chunks: [] });
    // complete the job by proving the empty file downloads
    const dl = await fetch(`${app.url}/api/files/canc-1/download`, { headers: { cookie: client.jar.header() } });
    await dl.text();
    const list = await client.get('/api/downloads');
    const jobId = (list.body as { downloads: Array<{ jobId: string; state: string }> }).downloads[0]!.jobId;
    const cancel = await client.post(`/api/downloads/${jobId}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal((cancel.body as { cancelled: boolean }).cancelled, false, 'a finished job is not cancellable');
  } finally {
    await app.close();
  }
});
