# CloudNest Architecture (Step 1)

One Node.js process. Loopback only in this step.

```text
web/ (React + Vite + TypeScript, plain CSS)
  dev:  Vite dev server on 127.0.0.1:5173, /api proxied to Express
  prod: built into web/dist, served by Express
server/ (Express 5 + TypeScript)
  src/index.ts        entry: load config, open DB, migrate, listen (loopback only)
  src/app.ts          Express app factory (routes, API 404, static UI, error handler)
  src/config/env.ts   validated config (PORT, NODE_ENV, DATA_DIR)
  src/routes/health.ts  GET /api/health
  src/db/index.ts     better-sqlite3, WAL + durability pragmas, transactional migrations
```

- Database: SQLite in WAL mode via `better-sqlite3`; metadata only; stored in the
  per-user OS data directory (override with `DATA_DIR`), never in the repository.
- No cloud providers, auth, uploads, or public binding in this step.
- Node.js 24 LTS baseline (`engines.node = 24.x`, `.nvmrc` = 24).
