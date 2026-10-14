# CloudNest Architecture

One Node.js process, one local SQLite database, one browser UI. The origin binds
to `127.0.0.1` only; public access exists solely through the optional Cloudflare
Tunnel, which never changes the bind.

```text
web/ (React + Vite + TypeScript, plain CSS, no state-management library)
  dev:  Vite dev server on 127.0.0.1:5173, /api proxied to Express
  prod: built into web/dist and served by Express
  src/App.tsx          sidebar shell (Dashboard, Files, Uploads, Downloads,
                       Shared Links, Cloud Accounts, Settings) + Light/Dark toggle
  src/api.ts           typed fetch client (CSRF-aware, raw Blob uploads)
  src/theme.ts         data-theme light|dark, persisted client-side, no flash
  src/confirm.tsx      destructive-action gate honouring the saved preference
                       (ConfirmHost is mounted in App; preference-driven)
  src/components/ui.tsx        shared UI kit (toasts, badges, formatters)
  src/components/FileActionsProvider.tsx   cross-page share/rename/delete actions
  src/pages/DashboardPage.tsx  real dashboard (accounts, storage, recent files)

server/ (Express 5 + TypeScript)
  src/index.ts         entry: config, DB open + migrate, listen, graceful shutdown
  src/app.ts           app factory; middleware order is load-bearing:
                       helmet -> Host/Origin guard -> sessions -> CSRF ->
                       raw chunk router (before any body parser) -> JSON parser ->
                       JSON upload router -> auth/setup -> downloads -> shares ->
                       settings/maintenance/tunnel -> /api/admin (requireAdmin) ->
                       static UI + SPA fallback -> central error handler
  src/config/env.ts    validated config (PORT, NODE_ENV, DATA_DIR, APP_BASE_URL)
  src/db/              better-sqlite3 (WAL, foreign_keys=ON, synchronous=FULL),
                       transactional versioned migrations, query bundles
  src/providers/       adapter contract + registry, AES-256-GCM credential store,
                       google-drive / dropbox / onedrive / pcloud / mega adapters
  src/uploads/         exact integer chunk math, capacity preflight + allocation,
                       streaming upload engine (bounded workers, idempotency)
  src/downloads/       range->chunk mapping, bounded prefetch pipeline, per-chunk
                       SHA-256 verification, shared 128 MiB memory budget
  src/shares/          share tokens (hash-only storage), password/expiry/limits
  src/deletions/       durable delete jobs with per-object outcomes
  src/settings/        allowlisted, non-secret settings (validated, all-or-nothing)
  src/maintenance/     SQLite online backup/restore, redacted diagnostics
  src/tunnel/          optional Cloudflare Tunnel: scoped-token wizard, DNS
                       pre-check, spawn without a shell, token kept encrypted
  src/middleware/      requireAdmin, rate limits, error handling
```

- **Database:** SQLite in WAL mode via `better-sqlite3`; metadata only. File bytes
  are never stored in SQLite and never staged as a whole file on this host.
  Stored in the per-user OS data directory (override with `DATA_DIR`), never in
  the repository.
- **Secrets:** provider credentials and the tunnel runtime token are encrypted
  with a key at `<DATA_DIR>/credential-master.key` (0600, never in a backup).
  Secrets never reach the browser, logs or diagnostics.
- **Honesty rules:** unknown/stale quota is never counted as free space; a
  provider checksum of a different algorithm is never compared to SHA-256; a
  connector is never called live-tested without a real live test.
- **Node.js 24 LTS baseline** (`engines.node = 24.x`, `.nvmrc` = 24).
