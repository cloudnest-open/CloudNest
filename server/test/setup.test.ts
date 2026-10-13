import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

const GOOD = 'correct horse battery staple';

test('fresh app reports setupRequired=true and creates the admin once', async () => {
  const app = await startTestApp();
  try {
    const client = new Client(app.url);
    const status = await client.get('/api/setup/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { setupRequired: true });
    assert.equal(status.headers.get('cache-control'), 'no-store');

    const created = await client.setup(GOOD);
    assert.equal(created.status, 201);

    // second setup attempt -> 409
    const second = new Client(app.url);
    const conflict = await second.setup('another password x');
    assert.equal(conflict.status, 409);

    // status now false
    const after = await client.get('/api/setup/status');
    assert.deepEqual(after.body, { setupRequired: false });
  } finally {
    await app.close();
  }
});

test('setup validates password policy and confirmation', async () => {
  const app = await startTestApp();
  try {
    const client = new Client(app.url);
    const mismatch = await client.post('/api/setup', { password: GOOD, confirm: 'different password here' });
    assert.equal(mismatch.status, 400);
    const short = await client.post('/api/setup', { password: 'short', confirm: 'short' });
    assert.equal(short.status, 400);
    // still no admin
    const status = await client.get('/api/setup/status');
    assert.deepEqual(status.body, { setupRequired: true });
  } finally {
    await app.close();
  }
});

test('setup without CSRF token is rejected', async () => {
  const app = await startTestApp();
  try {
    const res = await fetch(`${app.url}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: GOOD, confirm: GOOD }),
    });
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});
