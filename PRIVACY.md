# Privacy

CloudNest is **self-hosted**: it runs on your machine, keeps its metadata
database on your machine, and stores your file bytes in **your own** cloud
storage accounts. There is no CloudNest service, account, or server on the
other end of a network call. This page describes exactly what the application
stores, where it goes, and what it never does.

## What CloudNest stores, and where

**Local SQLite database** (inside your configured `DATA_DIR`):

- file metadata: names, sizes, MIME types, folder structure, trash state
- chunk manifests: which logical chunk of a file lives on which of your
  connected accounts (but never the bytes themselves)
- the cloud accounts you connected, and their daily request/error counters
- users you invited, their roles and per-user storage allowances
- share links and their settings, session records, and audit events

**Your connected cloud accounts:** file content, split into app-managed
chunks, stored as objects inside the accounts *you* connect. CloudNest only
ever lists, reads, uploads, and deletes objects inside a dedicated
CloudNest root folder on each account (`docs/provider-setup.md`).

**A local encryption key** (`<DATA_DIR>/credential-master.key`) that encrypts
provider credentials at rest.

## What CloudNest never does

- **No telemetry, analytics, or crash reporting.** The application makes no
  outbound network calls except to the cloud providers *you* connect and —
  during OAuth connect — to the authorization endpoints those providers
  document, and — only if you explicitly enable the optional Cloudflare
  Tunnel — to Cloudflare's API (tunnel provisioning and token verification).
  There is no tracking code in the web UI.
- **No files staged on the host.** Full files are never stored in the
  database and never staged whole on the CloudNest host; downloads are
  reconstructed chunk by chunk and verified byte-for-byte.
- **No credentials in the browser.** Provider secrets and OAuth tokens are
  stored encrypted (AES-256-GCM) server-side, and are never sent back to the
  browser or written to logs. Provider URLs are never exposed to the browser:
  share downloads stream through your CloudNest instance.
- **No third-party JavaScript or CDNs** — the UI is served entirely by your
  own instance.

## Access and accounts

- The application binds to `127.0.0.1` only. Public access exists solely
  through the optional, explicitly enabled Cloudflare Tunnel (`docs/` and
  `RELEASE.md` describe it); enabling it never changes the loopback bind.
- Passwords (administrator and invited members) are stored as versioned
  scrypt hashes with constant-time verification. Login sessions are
  server-side records referenced by a hashed session ID; every
  state-changing API request requires a CSRF token.
- Share links use 256-bit random tokens stored **as hashes**; a share token
  that leaks is useless without your server. Password-protected links require
  a server-side unlock before any download starts.
- Invited members only ever see their own files; other users' resources
  return the same 404 as nonexistent ones (no existence probing).

## Your cloud providers are separate

When you connect Google Drive, Dropbox, OneDrive, pCloud, an S3-compatible
bucket (or MEGA, which is experimental), data inside those accounts is covered
by **the provider's own terms and privacy policy**, not this document.
CloudNest authenticates with the credentials you supply; it does not ship,
host, or share provider application credentials — you register the OAuth
application yourself (`docs/provider-setup.md`).

## Deleting data

- Deleting a file from Trash purges it by deleting CloudNest's objects from
  your connected accounts through the provider API, and the deletion outcome
  is recorded per account rather than assumed.
- Uninstalling means removing the application and your `DATA_DIR` (database +
  credential key); file bytes live only in your own provider accounts, which
  you control directly.
- Backups you create are also local, in `DATA_DIR`; a backup holds metadata,
  not file bytes, and not the credential-encryption key.

## Reporting a privacy concern

If you believe CloudNest itself mishandles your data, follow
[SECURITY.md](SECURITY.md) — the same private reporting channel covers
privacy-relevant defects. Please never include credentials, tokens, or
account identifiers in any report.
