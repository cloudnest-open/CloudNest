# CloudNest

A self-hosted personal cloud-storage aggregator.

CloudNest stores file **metadata** in a local SQLite database and file **content**
as chunk objects inside the cloud accounts you connect (Google Drive, Dropbox,
OneDrive, pCloud; MEGA experimentally). Large files are split into app-managed
logical chunks, placed across eligible accounts, and reconstructed byte-for-byte
on download — the full original file is never stored on, or staged on, this host.

**Status:** Implemented: first-run admin + sessions/CSRF, provider account
lifecycle with encrypted credentials and a built-in connect wizard, chunked
upload engine with capacity-aware routing, download/reconstruction with
per-chunk verification, CloudNest share links with expiry/password/limits, safe
deletion with a 7-day trash window, multi-user (admin/member with one-time
invite/reset links and per-user allowances), folders, Personal/Business mode
context, notifications, S3-compatible business tier with browser-direct
pre-signed transfers, chunk-level mirroring with download fallback, a
background scheduler (quota refresh, cleanup retries), provider health
metrics, Settings/Diagnostics/Backup, a renameable admin login name, and an
optional Cloudflare Tunnel with browser-based authorization. Provider evidence
status: see [PROVIDER_STATUS.md](PROVIDER_STATUS.md) — Google Drive has been
connected live with two real accounts (OAuth and real quota reads verified;
transfer paths remain mock-tested); every other connector is mock-tested, and
MEGA is experimental.

## Features

- **Your accounts, one pool** — connect several cloud accounts (including
  several from the same provider) and CloudNest places chunks across them by
  real capacity; org-level shared budgets can be grouped into one quota pool.
- **Chunked, resumable uploads** — multi-file/folder queue with per-item
  planning, pause/resume/retry, and recovery across restarts; business-tier
  (S3) chunks transfer browser-direct over short-lived pre-signed URLs.
- **Verified downloads** — files are reconstructed chunk by chunk with
  per-chunk verification; if a mirrored copy's account is down, download
  falls back to a healthy copy.
- **Chunk mirroring** — copy a completed file's chunks to a second account in
  the same tier for redundancy, with honest job state and retry.
- **Folders and trash** — folder tree with breadcrumbs, and a 7-day trash
  window before deletion really purges objects from your providers.
- **Share links** — expiry, download limits, and passwords; tokens are
  256-bit random values stored as hashes; rotation and revocation.
- **Multi-user** — invite members with one-time links, roles, per-user
  storage allowances, and strict ownership isolation.
- **Notifications** — a real bell feed: upload completions, share downloads,
  stale quota warnings.
- **Provider health** — per-provider Healthy/Degraded/Down verdicts on the
  dashboard, derived from the server's own metrics.
- **Private by construction** — metadata-only SQLite on your machine, bytes
  only in your own accounts, no telemetry, encrypted credentials, loopback
  bind (see [PRIVACY.md](PRIVACY.md)).
- **In 8 languages** — English, 简体中文, Español, Deutsch, Русский,
  Français, 日本語, Português (Brasil), with light/dark themes.

The application binds to `127.0.0.1` only. Public access exists solely through
the optional, explicitly enabled Cloudflare Tunnel.

## Prerequisites

- Node.js **24 LTS** (`.nvmrc` contains `24`; installing on any other Node
  fails — `engines.node` + `engine-strict` for dependencies, a `preinstall`
  guard for the project itself, because npm never enforces root `engines`).
  New to Node? Install it from [nodejs.org](https://nodejs.org) (the LTS
  download bundles `npm`), or with [nvm](https://github.com/nvm-sh/nvm):
  `nvm install 24`. Check with `node --version` — it should print `v24.x`.
- npm (bundled with Node)
- Optional: a `cloudflared` binary you installed yourself, only if you want
  remote access

## Install and run

```bash
npm ci            # or `npm install` on a first-time checkout
npm run build
npm start         # serves the UI + API on http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787` and create your admin password on the first-run
screen. There is no default password.

Development:

```bash
npm run dev       # Vite dev server on 5173 with /api proxied to 8787
npm run typecheck
npm test          # live provider tests are opt-in and skipped by default
```

Documentation:

- **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** — how CloudNest works,
  explained with simple diagrams: install → accounts → uploads → downloads →
  shares → remote access
- **[docs/connect-your-cloud.md](docs/connect-your-cloud.md)** — the
  beginner guide to connecting cloud accounts (Personal tier), with a short
  S3 section for business users
- **[docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)** — the user guide:
  getting started, files/folders/trash, uploads, shares, multi-user, backups
- **[docs/provider-setup.md](docs/provider-setup.md)** — per-provider OAuth
  app registration, exact scopes/redirect URIs, and provider usage limits
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — error codes and
  recovery steps for startup, login, uploads, downloads, accounts, backups
- **[SUPPORT.md](SUPPORT.md)** — where to ask for help and how to report
  problems
- **[PRIVACY.md](PRIVACY.md)** — what CloudNest stores, and where
- **[RELEASE.md](RELEASE.md)** — full install guide, backup/restore notes,
  known limitations, upgrade behaviour, release checklist
- **[docs/architecture.md](docs/architecture.md)** — architecture notes
- **[SECURITY.md](SECURITY.md)** — reporting vulnerabilities, threat model
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute

## Security notes

- The server binds to `127.0.0.1` only; remote access is the optional,
  explicitly enabled Cloudflare Tunnel.
- Secrets are encrypted at rest; tokens never reach the browser or logs.
- Share links use 256-bit random tokens stored as hashes; password-protected
  links require a server-side unlock before any download can start.
- Read [SECURITY.md](SECURITY.md) before exposing the app beyond loopback.

## Configuration (`.env`, all optional and non-secret)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Loopback port |
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `DATA_DIR` | OS per-user data dir (`~/.local/share/CloudNest` on Linux) | Where the SQLite database and the credential key live |
| `APP_BASE_URL` | `http://127.0.0.1:8787` | Canonical origin for OAuth callbacks and share URLs |

## Data and durability

- SQLite in **WAL mode** with `foreign_keys=ON`, `synchronous=FULL`,
  `busy_timeout=5000`; verified at startup and in tests.
- Migrations are transactional, versioned and recorded in `schema_migrations`;
  an applied migration is never edited, only superseded.
- Metadata only: file bytes are never stored in SQLite and never staged as a
  whole file on this host.
- `<DATA_DIR>/credential-master.key` encrypts provider credentials. **Back it up
  separately** — a database backup does not include it, and provider accounts
  cannot be decrypted without it.

## Supported platform

Developed and verified on Linux x86_64 with Node.js 24. macOS and Windows are
expected to work but are untested here; `better-sqlite3` ships prebuilt binaries
for common platforms.

## License

Licensed under the [Apache License 2.0](LICENSE). Third-party dependencies are
permissively licensed (MIT/ISC/BSD/Apache-2.0); see `RELEASE.md` for the note
on the unofficial `megajs` library used for the experimental MEGA connector.
