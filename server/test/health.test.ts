import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { healthRouter } from '../src/routes/health.js';
import { startTestApp } from './helpers.js';


async function listen(app: express.Express): Promise<{ server: import('node:http').Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

test('GET /api/health returns 200 ok JSON', async () => {
  const app = express();
  app.use(healthRouter('0.1.0'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const { server, url } = await listen(app);
  try {
    const res = await fetch(`${url}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; version: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '0.1.0');
  } finally {
    server.close();
  }
});

test('unknown /api/* path returns JSON 404, not HTML', async () => {
  const app = express();
  app.use(healthRouter('0.1.0'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const { server, url } = await listen(app);
  try {
    const res = await fetch(`${url}/api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Not found');
  } finally {
    server.close();
  }
});

test('the REAL app mounts /api/health as a public route', async () => {
  // Regression: the router existed but was never mounted in createApp(), so the
  // sidebar's local-server status always showed "not connected" while this test
  // file still passed. The route must answer on the actual assembled app.
  const app = await startTestApp();
  try {
    const res = await fetch(`${app.url}/api/health`);
    assert.equal(res.status, 200, 'health must be reachable on the assembled app');
    const body = (await res.json()) as { status: string; version: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.version, 'test', 'the app version is served, not a hardcoded one');

    // public means no session and no CSRF token are required
    const withBadHost = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(new URL(app.url).port), path: '/api/health', method: 'GET', headers: { host: 'unknown.example' } },
        (response) => { response.resume(); resolve(response.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(withBadHost, 421, 'health is public, but the Host guard still applies');
  } finally {
    await app.close();
  }
});
