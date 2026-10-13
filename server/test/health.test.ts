import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { healthRouter } from '../src/routes/health.js';


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
