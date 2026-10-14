import express from 'express';
import type { Express, RequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { healthRouter } from './routes/health.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { requireAdmin } from './middleware/require-admin.js';
import { SqliteSessionStore } from './db/session-store.js';
import { makeCsrf } from './auth/csrf.js';
import { makeQueries } from './db/queries.js';
import { providersRouter } from './routes/providers.js';
import { providerAccountsRouter } from './routes/provider-accounts.js';
import { CredentialsStore } from './providers/credentials-store.js';
import { ProviderAccountService } from './services/provider-account-service.js';
import { makeProviderQueries } from './db/provider-queries.js';
import { rawChunkRouter, uploadsRouter } from './routes/uploads.js';
import { UploadService } from './uploads/upload-service.js';
import { downloadsRouter } from './routes/downloads.js';
import { DownloadService } from './downloads/download-service.js';
import { sharesRouter, publicSharesRouter } from './routes/shares.js';
import { ShareService } from './shares/share-service.js';
import { DeletionService } from './deletions/deletion-service.js';
import { contentDisposition } from './downloads/range.js';

/**
 * Express app factory (Step 2).
 * Route order: security headers -> bounded JSON parser -> session middleware
 * -> CSRF middleware -> public setup/auth routes -> authenticated admin API
 * -> JSON /api/* 404 -> static UI fallback -> central error handler.
 */
export function createApp(options: {
  appVersion: string;
  db: Database.Database;
  sessionSecret: string;
  dataDir: string;
  appBaseUrl: string;
  webDistDir?: string;
}): Express {
  const app = express();
  app.disable('x-powered-by');

  // 1. security headers (same-origin app; CSP compatible with bundled React)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
    }),
  );


  const credentialsStore = new CredentialsStore(options.db, options.dataDir);
  const accountService = new ProviderAccountService(options.db, makeProviderQueries(options.db), credentialsStore);

  // 3. server-side sessions in the shared SQLite connection
  const sessionStore = new SqliteSessionStore(options.db);
  app.use(
    session({
      name: 'cloudnest.sid',
      secret: options.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false, // loopback-only local mode in Step 2; HTTPS/tunnel must enable Secure
        maxAge: 12 * 60 * 60 * 1000, // 12-hour idle timeout, rolling
      },
    }),
  );

  const csrf = makeCsrf();
  const queries = makeQueries(options.db);
  app.set('db', options.db);
  app.set('queries', queries);
  app.set('csrf', csrf);
  app.set('sessionStore', sessionStore);


  // 3b. RAW CHUNK UPLOAD — mounted here (after sessions/CSRF, before any body
  //     parser) so nothing buffers a chunk body. The plan forbids express.raw
  //     and multer memory storage for this route.
  const uploads = new UploadService(options.db, credentialsStore);
  app.use(rawChunkRouter({ queries, csrf, uploads, store: credentialsStore }));
  app.set('uploads', uploads);

  // 2. bounded JSON parser (8 KiB cap on auth/setup bodies; 400 on malformed)
  app.use(
    express.json({
      limit: '8kb',
      type: 'application/json',
    }),
  );

  // 2b. JSON upload routes (plan/status/control) — these need a parsed body, so
  //     they are mounted after the JSON parser and never see raw chunk bytes.
  app.use(uploadsRouter({ queries, csrf, uploads }));

  // 4. public setup/auth routes (unsafe methods are CSRF-protected inside)
  app.use(setupRouter(queries, csrf, () => options.db));
  app.use(authRouter(queries, csrf));

  // 4b. provider + account management (admin session + CSRF; OAuth callback
  //     is GET and is protected by one-time session-bound state instead)
  app.use(providersRouter({ db: options.db, queries, csrf, store: credentialsStore, accounts: accountService, appBaseUrl: options.appBaseUrl }));
  app.use(providerAccountsRouter({ queries, csrf, store: credentialsStore, accounts: accountService, appBaseUrl: options.appBaseUrl }));
  app.set('providerAccounts', accountService);
  app.set('credentialsStore', credentialsStore);

  // 4c. download routes. They stream file bytes, so nothing in front of them
  //     may compress or transform the response: Content-Length, Range and ETag
  //     must describe the exact reconstructed file bytes.
  const downloads = new DownloadService(options.db, credentialsStore);
  app.use(downloadsRouter({ queries, csrf, downloads }));
  app.set('downloads', downloads);

  // 4d. share links and deletion. Public share routes are mounted separately and
  //     never inherit the admin gate; they authorize by token + one-time session.
  const shares = new ShareService(options.db);
  const deletions = new DeletionService(options.db, credentialsStore, shares);
  app.use(sharesRouter({ queries, csrf, shares, deletions, appBaseUrl: options.appBaseUrl }));
  app.use(
    publicSharesRouter({
      shares,
      csrf,
      downloadFileInfo: (fileId: string) => {
        const file = downloads.getFile(fileId);
        if (!file) return null;
        return {
          sizeBytes: file.size_bytes,
          mimeType: file.mime_type,
          disposition: contentDisposition(file.original_name),
        };
      },
      streamSharedFile: (fileId: string, signal: AbortSignal) => {
        // one prepared download per request; the shared path reuses the same
        // verified-chunk streaming code as an admin download
        const prepared = downloads.prepare(fileId, null, true);
        return downloads.stream(prepared, signal);
      },
    }),
  );
  app.set('shares', shares);
  app.set('deletions', deletions);

  // 5. authenticated admin API.
  //    The router is mounted under the /api/admin prefix ONLY. Mounting it at
  //    the root would run requireAdmin on every request, including the UI
  //    itself, and would break the sign-in page.
  const admin = express.Router();
  admin.use(requireAdmin(queries));
  admin.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/admin', admin);

  // 6. JSON 404 for unknown /api/* paths (never the UI HTML)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // 7. production static UI + eligible frontend fallback
  const webDistDir = options.webDistDir ?? path.resolve('web/dist');
  const hasBuild = existsSync(path.join(webDistDir, 'index.html'));
  if (hasBuild) {
    app.use(express.static(webDistDir, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  // 8. central error handler — CSRF failures return 403, malformed JSON 400;
  //    never leak stack traces, paths or env values.
  const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message === 'invalid csrf token' || message.includes('csrf')) {
      res.status(403).json({ error: 'Invalid or missing CSRF token.' });
      return;
    }
    if (err instanceof SyntaxError && 'body' in (err as object)) {
      res.status(400).json({ error: 'Malformed JSON body.' });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large.' });
      return;
    }
    console.error(`[cloudnest] request error: ${message}`);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
