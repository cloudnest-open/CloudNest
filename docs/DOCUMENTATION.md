# CloudNest user guide

CloudNest is a self-hosted personal cloud-storage aggregator. It keeps file
**metadata** in a local SQLite database and file **content** as chunk objects
inside **your own** cloud accounts (Google Drive, Dropbox, OneDrive, pCloud;
S3-compatible buckets for the business tier; MEGA experimentally). Large files
are split into app-managed chunks, placed across eligible accounts, and
reconstructed byte-for-byte on download — a full file is never stored on, or
staged on, the CloudNest host.

This guide explains day-to-day use. For installing and running, see
[RELEASE.md](../RELEASE.md); for connecting providers, see
[docs/provider-setup.md](provider-setup.md); for error codes, see
[docs/troubleshooting.md](troubleshooting.md).

## Getting started

1. **Install and start** — `npm ci`, `npm run build`, `npm start`; the app
   serves on `http://127.0.0.1:8787` (see README for configuration).
2. **First run** — the first-run screen asks you to create the administrator
   password. There is no default password.
3. **Configure a provider** — each provider needs an OAuth application you
   register yourself (client ID/secret pasted in Settings → Provider Setup),
   except S3, where you paste access/secret keys, and MEGA (experimental,
   email/password). Full per-provider steps and redirect URIs:
   [docs/provider-setup.md](provider-setup.md).
4. **Connect an account** — Cloud Accounts → Connect; authorize in the
   provider's window. Each connected account gets a dedicated CloudNest root
   folder; CloudNest only touches objects inside it.
5. **Upload** — Uploads → choose files or folders. CloudNest plans the
   placement across your accounts, uploads chunks (resumable, verifiable),
   and the file appears in Files.

## Dashboard

The home screen summarizes the whole pool: connected accounts (with attention
counts), files, active uploads and storage used. Administrator dashboards
also show per-provider health — each provider card reports a live verdict
(Healthy / Degraded / Down) derived from the server's own request metrics and
account states, with a last-checked timestamp. Invited members see their own
files, uploads and storage only.

## Files

- **All Files / Trash** — two tabs; Trash keeps deleted files for a 7-day
  restore window, then they can be purged (which really deletes the objects
  from your providers, with per-account outcome records).
- **Folders** — create, rename, move files between folders, delete empty
  folders; a breadcrumb shows where you are.
- **Search and pagination** — server-side search and paging, so large
  libraries stay responsive.
- **Mirror** (in the file row menu) — copies every chunk of a completed file
  to a second account in the same storage tier, so that losing one account no
  longer makes the file unreachable; downloads automatically fall back to a
  healthy copy. The dialog shows the real job state, including honest failure
  codes, and Retry resumes a failed mirror job.
- **Details** — chunk/placement information and an availability line; files
  that need an account reconnected show a "Reconnect required" badge in the
  list.

## Uploads

- **Multi-file and folder queue** — pick many files or a whole folder
  (directory drag-and-drop works too); items upload sequentially, each with
  its own plan preflight, and failures are shown per item.
- **Storage tier** — Personal (Google Drive/Dropbox/OneDrive/pCloud/MEGA) or
  Business (S3-compatible). Business-tier accounts can receive browser-direct
  transfers: CloudNest hands the browser a short-lived pre-signed URL for
  each chunk, and the bytes go straight to the bucket — with the server still
  verifying the result. The browser never sees account identifiers or
  credentials either way.
- **Placement control** — auto-spread spreads chunks across eligible
  accounts; when a plan cannot fit, CloudNest reports the exact shortfall and
  suggests the largest feasible smaller chunk size.
- **Pause / resume / retry** — resumable jobs survive restarts: on startup
  the server recovers paused jobs and rebuilds in-flight state.

## Downloads and Shared Links

- **Downloads** — pick a file, CloudNest reconstructs it from its chunks
  (with per-chunk verification) and saves it locally.
- **Shared Links** — create a link to any completed file, with an optional
  expiry date, download limit, and password. Links can be rotated (new token,
  old one dies) and revoked. Share downloads always stream through your
  CloudNest instance — provider URLs are never exposed.

## Multi-user

The administrator can invite members (Settings → Users): an invitation is a
one-time link the recipient opens to set their password. Each member has a
role (admin/member), a status, and an optional storage allowance. Members see
their own files, shares and dashboard only; admin-only surfaces (Cloud
Accounts, Settings, Users) are hidden and rejected server-side. A member who
forgets their password gets a fresh one-time reset link from the
administrator — there is no email flow in this product. Changing a password
or disabling a member immediately invalidates their sessions.

## Cloud Accounts

- Connect several accounts, including several accounts from the same
  provider; each is an independent row with its own quota observation.
- Accounts that are actually one organization pool (for example, one shared
  Google Workspace storage budget) can be grouped into a **shared quota
  scope** you confirm explicitly — they then draw from one budget instead of
  being counted separately.
- Disconnecting warns you with the real tracked-file count for that account
  and explains what becomes unavailable — it does not silently claim to
  delete remote data.
- S3-compatible accounts (Business tier) are connected by the administrator
  with access/secret keys; the capacity cap you set is treated as the
  account's quota (S3 buckets have no quota API), and used bytes are counted
  live from actual placements.

## Settings

Ten sections: **General** (language, theme), **Upload** (chunk size, workers,
routing, verification), **Downloads** (concurrency), **Sharing** (default
expiry, password requirement, download limit), **Domain** (public base URL),
**Security** (destructive-action confirmation), **System** (version, ports,
data directory), **Diagnostics**, **Provider Setup** (OAuth credentials), and
**Users** (admin only).

- **Backups** (System) — SQLite online backup while the app runs; restore
  into a target directory with an explicit two-step confirmation. A backup
  holds metadata/configuration, **not** file bytes and **not** the
  credential-encryption key — back that key up separately.
- **Diagnostics** — a one-page report of configuration state for support
  requests.
- **Cloudflare Tunnel** (Domain) — optional, explicitly enabled remote
  access; the server itself keeps binding to loopback only.

## Notifications

The bell shows a real feed: an owner is notified when an upload completes,
a share creator when a shared link is downloaded, and all active
administrators when a provider's quota observation goes stale. Unread
counts and mark-all-read are live.

## Current limitations (stated honestly)

- No cloud provider has been live-tested from the development environment;
  every connector is verified against mocks and synthetic fixtures (evidence
  status: [PROVIDER_STATUS.md](../PROVIDER_STATUS.md)). Real-provider
  behaviour is exercised the first time you connect your own accounts.
- MEGA is **experimental**: it cannot participate in uploads yet.
- Continuous folder-sync is not implemented (the Uploads toggle is an honest
  disabled placeholder).
- Two-factor authentication (TOTP) is not implemented.
- The product is a single-instance, self-hosted gateway — it is not a
  multi-tenant cloud service.

## More documentation

- [docs/provider-setup.md](provider-setup.md) — per-provider setup, scopes,
  redirect URIs, usage limits
- [docs/troubleshooting.md](troubleshooting.md) — error codes and recovery
- [docs/architecture.md](architecture.md) — how the system is built
- [SECURITY.md](../SECURITY.md) — security policy and threat model
- [PRIVACY.md](../PRIVACY.md) — what is stored, and where
- [SUPPORT.md](../SUPPORT.md) — where to ask for help
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to contribute
