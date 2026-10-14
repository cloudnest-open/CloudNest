# CloudNest

A self-hosted personal cloud-storage aggregator (working name, subject to owner approval).

CloudNest stores file **metadata** in a local SQLite database and file **content**
as chunk objects inside the cloud accounts you connect (Google Drive, Dropbox,
OneDrive, pCloud; MEGA experimentally). Large files are split into app-managed
logical chunks, placed across eligible accounts, and reconstructed byte-for-byte
on download — the full original file is never stored on, or staged on, this host.

**Status:** Steps 1–6 implemented: first-run admin + sessions/CSRF, provider
account lifecycle with encrypted credentials, chunked upload engine with
capacity-aware routing, download/reconstruction with per-chunk verification,
CloudNest share links with expiry/password/limits, safe deletion of
CloudNest-owned objects, Settings/Diagnostics/Backup, and an optional Cloudflare
Tunnel. Provider evidence status: see [PROVIDER_STATUS.md](PROVIDER_STATUS.md) —
**no provider has been live-tested in this environment**; every connector is
mock-tested, and MEGA is experimental.

The application binds to `127.0.0.1` only. Public access exists solely through
the optional, explicitly enabled Cloudflare Tunnel.

## Prerequisites

- Node.js **24 LTS** (`.nvmrc` contains `24`; `engines.node` enforces `24.x`)
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

- **[docs/provider-setup.md](docs/provider-setup.md)** — per-provider OAuth
  app registration, exact scopes/redirect URIs, and provider usage limits
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — error codes and
  recovery steps for startup, login, uploads, downloads, accounts, backups
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
