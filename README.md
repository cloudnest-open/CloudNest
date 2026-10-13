# CloudNest

A self-hosted personal cloud-storage aggregator (working name, subject to owner approval).

**Status: Step 1 foundation** — app shell, health API, SQLite foundation. No cloud
providers, no uploads, no authentication yet.

## Prerequisites

- Node.js **24 LTS** (`.nvmrc` contains `24`; `engines.node` enforces `24.x`)
- npm (bundled with Node)

## Install

```bash
npm install        # first time (or npm ci for a clean, lockfile-exact install)
```

## Run (development)

```bash
npm run dev
# UI:    http://127.0.0.1:5173   (Vite dev server, /api proxied)
# API:   http://127.0.0.1:8787
```

## Run (production-like, local)

```bash
npm run build
npm start
# App:  http://127.0.0.1:8787   (Express serves the built UI + API)
```

## Test & typecheck

```bash
npm test
npm run typecheck
```

## Configuration

Copy `.env.example` to `.env` if you want to change anything. Supported options in
this step (all safe, non-secret):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Local server port (loopback only) |
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `DATA_DIR` | OS per-user data dir | Where the SQLite database lives |

- The server binds to **127.0.0.1 only** in this step; there is intentionally no
  public bind option yet because authentication is not implemented.
- If `PORT` is already in use, CloudNest prints an actionable error and exits.
- The SQLite database is created in the per-user OS data directory (on Linux:
  `~/.local/share/CloudNest/`), never inside the repository. Override with
  `DATA_DIR=/some/path` in `.env`.

## Data & durability

- SQLite runs in **WAL mode** with `foreign_keys=ON`, `synchronous=FULL`,
  `busy_timeout=5000`; verified at startup and in tests.
- Migrations are transactional and recorded in `schema_migrations`.
- Metadata only: uploaded file bytes are never stored in SQLite.

## Current limitations (Step 1)

- No login/admin setup, no cloud provider connections, no uploads/downloads,
  no share links, no public/remote access. These arrive in later steps
  (see the approved roadmap).
- Sidebar sections other than Dashboard show honest "Not implemented yet" states.

## Supported platform

Developed and tested on Linux x86_64, Node.js 24. `better-sqlite3` ships prebuilt
binaries for common platforms; uncommon platforms may need C/C++ build tools.
