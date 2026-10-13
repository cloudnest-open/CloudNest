import express from 'express';
import type { Express } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { healthRouter } from './routes/health.js';

/**
 * Express app factory (Step 1).
 * - API routes and the JSON API 404 handler run BEFORE the frontend fallback.
 * - The frontend fallback only answers eligible browser GET requests and only
 *   when a production build exists (web/dist).
 * - The central error handler never exposes stack traces, paths or env values.
 */
export function createApp(options: {
  appVersion: string;
  webDistDir?: string;
}): Express {
  const app = express();
  app.disable('x-powered-by');

  // 1. API routes
  app.use(healthRouter(options.appVersion));

  // 2. JSON 404 for unknown /api/* paths (must not return UI HTML)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // 3. Production static UI + eligible frontend fallback
  const webDistDir = options.webDistDir ?? path.resolve('web/dist');
  const hasBuild = existsSync(path.join(webDistDir, 'index.html'));
  if (hasBuild) {
    app.use(express.static(webDistDir, { index: false }));
    app.use((req, res, next) => {
      // Only browser navigation requests get the SPA fallback.
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  // 4. Central error handler — never leak internals.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      // Log a concise message server-side; details stay in the server log only.
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[cloudnest] request error: ${message}`);
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
