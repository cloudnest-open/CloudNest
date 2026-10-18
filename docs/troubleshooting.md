# Troubleshooting

## The app will not start

- **`Node.js 24.x is required`** — check `node --version`. `.nvmrc` pins `24`.
- **A migration failed** — startup aborts rather than running a partial schema.
  Read the error, restore your most recent metadata backup into a new directory,
  and re-run. Some migrations rebuild tables, so a rollback is not automatic.
- **Port already in use** — CloudNest binds `127.0.0.1:8787`. Set `PORT` to a
  free port; do not kill unrelated processes just to free 8787.
- **`better-sqlite3` fails to load** — native module mismatch. Delete
  `node_modules` and re-run `npm ci` with the Node 24 toolchain.

## First-run or login problems

- **No default password exists.** On a fresh database the app shows first-run
  setup; create the admin password there.
- **Forgot the admin password:** stop CloudNest, then
  ```bash
  npm run build
  npm run admin:reset
  ```
  This removes the admin account and all sessions, keeps every other record,
  and re-shows first-run setup on the next start.
- **Login form rejects a correct password after a public-host change** — when
  the tunnel is active the session cookie is marked `Secure`; make sure you are
  reaching the app over HTTPS (through the tunnel) rather than a plain-http
  public address.
- **Signed in before with a different name?** The administrator can rename the
  login name (Profile → Change login name). Login matches the current name
  case-insensitively; the old name stops working the moment it is changed.

## Downloads

- **`chunk_missing`** — a chunk object is no longer present on its provider
  (deleted outside CloudNest, or an account was disconnected). The file is
  marked as needing repair; reconnect the account or re-upload the file.
- **`chunk_hash_mismatch`** — the stored chunk did not match its checksum. The
  download is aborted instead of delivering corrupt bytes, and the file is
  flagged as needing repair.
- **`provider_needs_reauth`** — a connected account's authorization expired.
  Reconnect it in Cloud Accounts.
- **`provider_rate_limited`** — the provider is throttling. Wait and retry.
- **Download cancelled but the row later shows completed** — with the File
  System Access path (Chrome/Edge) cancelling stops the stream. In the native
  browser fallback, the browser owns the transfer and CloudNest's cancel only
  stops its own bookkeeping.

## Uploads

- **`capacity_insufficient`** — not enough usable space after per-account
  reservations. Add an account, free space, or refresh quotas.
- **An account with Unknown quota is never auto-selected** — refresh its quota
  in Cloud Accounts to make it eligible again.
- **Resume after a browser restart asks for the original file** — V1 can only
  verify chunks that were already uploaded; pick the same file so the source
  bytes can be hashed and compared.
- **`source_changed`** — the file you picked does not match the bytes already
  uploaded for this job. Pick the correct original file.

## Cloud accounts

- **Connect fails immediately** — provider app credentials are wrong or the
  redirect URI differs from the one registered. Re-check the wizard's shown
  callback URL and the steps in `docs/provider-setup.md`.
- **`already_connected`** — that exact provider identity is already connected
  (CloudNest refuses a silent duplicate). Use the account row's **Reconnect**
  action to renew it, or disconnect the existing row first.
- **`two_factor_required`** (MEGA) — your MEGA account uses two-factor
  authentication; the connect form asks for a one-time code from your
  authenticator app. It is valid once, so a later re-authentication asks for
  a fresh code.
- **`refresh_token_missing`** — the provider did not return a durable refresh
  token. Reconnect and grant offline access.
- **Disconnect warns about stored chunks** — that is expected; disconnecting
  never deletes remote objects, it just marks them unavailable.

## Backup and restore

- **Restore refused: target must be absolute** — supply a full path, not a
  relative one.
- **Restore refused: target exists** — tick the overwrite confirmation, or
  choose a new directory. Restoring never touches the live data directory.
- **Provider accounts show as needing reconnect after a restore** — the
  credential key (`credential-master.key`) is not part of a metadata backup.
  Restore that file separately, or reconnect each account.

## Remote access (Cloudflare Tunnel)

CloudNest's tunnel is authorized **in your own browser** (Settings → Domain →
Connect your domain): CloudNest runs `cloudflared` for you, and you approve
the domain on Cloudflare's page. No Cloudflare API tokens are involved at all.

- **`cloudflared_not_installed`** — install the `cloudflared` binary yourself;
  CloudNest does not install it.
- **`tunnel_login_failed`** — the browser authorization did not complete
  (cancelled, timed out, or cloudflared could not reach Cloudflare). Start the
  authorization again.
- **DNS record conflict** — cloudflared refuses to overwrite a DNS record it
  does not own. Remove or rename the existing record yourself, then retry.
- **Disconnected but still unreachable later** — use **Check connection** on
  the Domain page; it reports the tunnel connector's own registration status,
  not a guess.
- **Local use must work without Cloudflare** — if it does not, start CloudNest
  without the tunnel and use `http://127.0.0.1:8787`.

## Getting diagnostics

Settings → Diagnostics produces a **redacted** report (tokens, passwords,
session identifiers, and secret-bearing URLs are replaced; local paths are
shortened). Include that report when filing an issue. Never paste raw tokens or
`.env` files into an issue.
