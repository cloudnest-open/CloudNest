# Security Policy

## Reporting a vulnerability

Do **not** open a public GitHub issue for security problems. Use GitHub's
private vulnerability reporting (Security tab → Report a vulnerability) or
contact the repository owner directly. Include: affected component, a
reproduction or proof of concept, and your assessment of impact. You will get
an acknowledgement; fixes land in `main` and are called out in release notes.

## Threat model in one page

CloudNest is a **single-instance**, self-hosted gateway. One trusted
administrator (the built-in `admin` account) owns the instance and the cloud
credentials; the administrator may invite **members**, who are strictly
isolated to their own files, shares and quota and are rejected server-side
from admin surfaces. It is not a multi-tenant cloud service — do not invite
strangers; every member is someone the administrator chose to trust.

- **Bind address.** The server binds to `127.0.0.1` only. Remote access exists
  solely through the optional Cloudflare Tunnel, which the owner starts
  explicitly. There is no listening interface beyond loopback.
- **Authentication.** First-run setup creates the administrator (no default
  password; scrypt-hashed; the login name is renameable in-app). Sessions are
  server-side in SQLite, rotate on login, and expire on a rolling 12-hour
  timeout. Every state-changing route requires the session plus a
  double-submit CSRF token. Changing the root admin's password invalidates
  every session — members' included — as a deliberate precaution; a member
  changing their own password invalidates only their own sessions (renaming
  the login name invalidates none — sessions reference the fixed account id).
- **Public surface.** Only the share endpoints, the OAuth callback, and
  health/setup status are reachable unauthenticated. Share tokens are 256-bit
  random values stored as SHA-256 hashes; password-protected links reveal no
  metadata before a successful unlock, and download sessions require that
  unlock (share-bound grant) plus per-request revalidation of the parent link.
- **Secrets.** Provider credentials are encrypted at rest with AES-256-GCM
  (key: `<DATA_DIR>/credential-master.key`, 0600, fail-closed when absent).
  Tokens never reach the browser or logs; log output passes a redactor.
- **Cloud isolation.** Every adapter works inside a dedicated CloudNest root
  folder per account. Deletion only targets objects CloudNest created; deletes
  are durable jobs that report partial failures honestly instead of claiming
  success.
- **Supply chain.** CI runs on GitHub-hosted runners with least-privilege
  permissions (`contents: read`), commit-SHA-pinned third-party actions, and no
  secrets available to fork pull requests.

## What is out of scope

- Attacks that require an attacker to already control the host (they would
  own the database and the credential key).
- Social-engineering of the cloud provider accounts themselves.
- The experimental MEGA connector beyond the honest capability gate
  documented in `PROVIDER_STATUS.md`.

## Hardening recommendations for operators

1. Back up `credential-master.key` separately from any database backup.
2. Keep the installation loopback-only unless you specifically need the
   tunnel; when the tunnel is enabled, the session cookie is marked Secure and
   rate limits key per real visitor.
3. Keep Node.js 24.x current with security patches.
4. Use a dedicated cloud account (or at least a dedicated app folder) per
   provider rather than your primary personal account.
