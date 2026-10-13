import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

const GOOD = 'correct horse battery staple';

async function ready() {
  const app = await startTestApp();
  const client = new Client(app.url);
  await client.setup(GOOD);
  return { app, client };
}

test('missing CSRF token on unsafe request -> 403', async () => {
  const { app, client } = await ready();
  try {
    const res = await client.postWithToken('/api/auth/login', { username: 'admin', password: GOOD }, '');
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('invalid CSRF token on unsafe request -> 403 (generic, no internals)', async () => {
  const { app, client } = await ready();
  try {
    const res = await client.postWithToken('/api/auth/login', { username: 'admin', password: GOOD }, 'forged-token-value');
    assert.equal(res.status, 403);
    assert.ok(!JSON.stringify(res.body).includes('stack'));
  } finally {
    await app.close();
  }
});

test('token from another session is rejected (synchronizer binding)', async () => {
  const { app, client } = await ready();
  try {
    const stranger = new Client(app.url);
    const strangerToken = await stranger.get('/api/auth/csrf-token');
    const token = (strangerToken.body as { csrfToken: string }).csrfToken;
    const res = await client.postWithToken('/api/auth/login', { username: 'admin', password: GOOD }, token);
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('malformed JSON -> 400; oversized body -> 413', async () => {
  const { app } = await ready();
  try {
    const bad = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    const big = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(20_000) }),
    });
    assert.ok([413, 403].includes(big.status)); // 413 from parser, or 403 if CSRF gate first
  } finally {
    await app.close();
  }
});

test('csrf-token endpoint is public and safe (GET)', async () => {
  const { app } = await ready();
  try {
    const res = await fetch(`${app.url}/api/auth/csrf-token`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { csrfToken?: string };
    assert.ok(typeof body.csrfToken === 'string' && body.csrfToken.length > 10);
  } finally {
    await app.close();
  }
});
