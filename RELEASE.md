# CloudNest — release notes and install guide

## What this is

CloudNest is a self-hosted personal cloud-storage aggregator. One Node.js
process serves a web UI and an API on your own machine, stores file **metadata**
in SQLite, and stores file **content** as chunk objects inside your connected
cloud accounts (Google Drive, Dropbox, OneDrive, pCloud, and experimentally MEGA).

CloudNest keeps the application bound to `127.0.0.1`. Nothing is exposed to the
network unless you deliberately enable the optional Cloudflare Tunnel.

## Requirements

- **Node.js 24 LTS** (`.nvmrc` contains `24`; `engines.node` enforces `24.x`).
  New to Node? Install the LTS from [nodejs.org](https://nodejs.org) — it
  bundles `npm` — or with [nvm](https://github.com/nvm-sh/nvm): `nvm install
  24`. Verify with `node --version` (expect `v24.x`).
- npm (bundled with Node)
- A modern browser (Chrome, Firefox or Edge)
- Optional, only for remote access: a `cloudflared` binary installed by you

Native builds (`better-sqlite3`) need a C/C++ toolchain on uncommon platforms;
prebuilt binaries cover common ones.

## Install and run

```bash
npm ci            # or `npm install` for a first-time checkout
npm run build
npm start         # serves the UI and API on http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787` and create your admin password on the first-run
screen. There is no default password.

### Development

```bash
npm run dev       # Vite dev server (5173) + API (8787) with /api proxied
npm run typecheck
npm test
```

### Configuration (`.env`, all optional and non-secret)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Loopback port |
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `DATA_DIR` | OS per-user data directory | Where the SQLite database and key live |
| `APP_BASE_URL` | `http://127.0.0.1:8787` | Canonical origin used to build OAuth callback and share URLs |

## Where your data lives

- **Metadata**: `<DATA_DIR>/cloudnest.db` (SQLite, WAL mode)
- **Credential key**: `<DATA_DIR>/credential-master.key` — **back this up
  separately**. The database alone cannot decrypt provider tokens.
- **File content**: never on this host. Content lives only as chunk objects
  inside the CloudNest folder of each connected provider.

## Backup and restore

Settings → System creates a **metadata/configuration backup** using SQLite's own
online backup, so it is consistent while CloudNest runs. That backup contains
manifests, jobs, shares and account references — **not** your file bytes, and
**not** the credential key. A restore writes into a new directory and never
overwrites your live data directory.

## Recovery: forgotten admin password

```bash
npm run build            # required first
npm run admin:reset      # stop CloudNest before running this
```

This removes the admin account and all sessions, keeps every other record, and
makes the next start show the first-run setup screen again.

## Supported platforms for this release

- **Verified**: Linux x86_64, Node.js 24.18, tested by the automated suite.
- **Expected to work, untested here**: macOS and Windows with Node.js 24. The
  Windows permission model differs for the credential key file.
- **Not supported**: Node.js 26+ without re-verification of native modules.

## Known limitations (read this before trusting it with data)

1. **Live-provider evidence is still limited.** Google Drive has been
   connected live with two real accounts (real OAuth and real quota reads);
   no connector's upload/download path has been exercised against a real
   account here. See `PROVIDER_STATUS.md`. Treat transfer paths as
   `mock-tested` until you try them with your own accounts.
2. **MEGA is experimental** and is excluded from automatic upload placement
   until a live smoke test proves streaming upload and recovery.
3. **Browser-native downloads**: on browsers with the File System Access API
   (Chrome/Edge), downloads stream straight to the location you pick. On other
   browsers the native browser download is the fallback — pause/resume is then
   provided by your browser, not by CloudNest, and the Downloads page offers no
   in-app pause button.
4. **Resume after a browser restart** can verify only the chunks that were already
   uploaded. Bytes in chunks that were never sent have no earlier digest to
   compare against — this is stated in the UI and is a V1 design limit.
5. **ZIP bundles for collection links are not part of V1.** A collection link
   lists its files individually.
6. **A metadata backup is not a file backup.** Restoring never recreates remote
   objects, and provider accounts need the credential key.

## Upgrade behaviour

- Schema changes are versioned migrations; `schema_migrations` records the
  applied set and a repeat start re-applies nothing.
- **Take a backup before upgrading.** Some migrations rebuild tables; a rollback
  is not automatic.
- A migration failure aborts startup rather than running with a partial schema.

## Release checklist

- [x] `npm run typecheck` passes
- [x] `npm test` passes (0 failures; live provider tests are opt-in and skipped)
- [x] `npm run build` passes
- [x] Migrations applied transactionally, `PRAGMA foreign_key_check` clean
- [x] No secrets, databases, logs or build output in version control
- [x] Provider status documented truthfully in `PROVIDER_STATUS.md`
- [ ] Full live provider smoke tests (upload/download on real accounts) — not run in this environment; Google Drive OAuth + quota reads verified live
- [ ] Creating a GitHub Release, tag or production deployment — requires explicit owner authorization

## Licensing

Dependency licenses are plain permissive ones (MIT/ISC/BSD/Apache-2.0). MEGA
support relies on `megajs`, an **unofficial** community library; it is pinned and
labelled experimental for that reason.
