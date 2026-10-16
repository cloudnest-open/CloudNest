# Provider capability matrix

This file states the **actual, verified** status of each provider connector.
It is the honest record the project requires: a connector is never called
production-ready because TypeScript compiles or because mocks pass.

| Provider | OAuth / auth | Identity + quota | Upload | Download | Delete | Verified by | Status |
|---|---|---|---|---|---|---|---|
| Google Drive | implemented | implemented | implemented (resumable, resume from acknowledged range) | implemented (byte ranges) | implemented | mocked contract tests | `mock-tested` |
| Dropbox | implemented (`token_access_type=offline`) | implemented | implemented (single-request, ≤64 MiB objects) | implemented | implemented | mocked contract tests | `mock-tested` |
| OneDrive | implemented (explicit `offline_access`) | implemented | implemented (single-request `PUT .../content`) | implemented | implemented | mocked contract tests | `mock-tested` |
| pCloud | implemented (US/EU host allowlist) | implemented | implemented (streaming multipart, `nopartial=1`) | implemented | implemented | mocked contract tests | `mock-tested` |
| MEGA | implemented (email/password, unofficial `megajs` 1.3.10) | implemented | **gated off** | **gated off** | implemented | capability gate tests | `experimental` |
| S3-compatible (R2/B2/AWS) | implemented (SigV4 access-key/secret, no OAuth) | identity via HeadBucket; quota = owner-set cap + CloudNest-tracked bytes (no S3 quota API exists) | implemented (single-PUT streaming; chunks are ≤64 MiB) | implemented (byte ranges) | implemented (prefix-scoped) | mocked contract tests incl. AWS SigV4 suite vectors | `mock-tested` (roadmap Phase 1) |

## What "mock-tested" means here

Every connector is exercised against carefully constructed fake provider
responses that assert the real contract: request shape, headers, path scoping,
error mapping, cancellation and cleanup. **No connector has been run against a
live cloud account in this environment.**

## Live smoke tests (opt-in, never part of `npm test`)

Each live test is skipped unless its credential variables are present:

| Provider | Enable with | Variables |
|---|---|---|
| Google Drive | `CLOUDNEST_LIVE_GOOGLE=1` | `CLOUDNEST_LIVE_GOOGLE_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` |
| Dropbox | `CLOUDNEST_LIVE_DROPBOX=1` | `CLOUDNEST_LIVE_DROPBOX_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` |
| OneDrive | `CLOUDNEST_LIVE_ONEDRIVE=1` | `CLOUDNEST_LIVE_ONEDRIVE_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, optional `_AUTHORITY` |
| pCloud | `CLOUDNEST_LIVE_PCLOUD=1` | `CLOUDNEST_LIVE_PCLOUD_ACCESS_TOKEN`, optional `_HOST` |
| MEGA | `CLOUDNEST_LIVE_MEGA=1` | `CLOUDNEST_LIVE_MEGA_EMAIL`, `_PASSWORD` (dedicated test account; 2FA not automated) |
| S3-compatible | `CLOUDNEST_LIVE_S3=1` (planned) | `CLOUDNEST_LIVE_S3_ENDPOINT`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_BUCKET`, `_PREFIX` — not implemented yet; connect via the Cloud Accounts form and a real test bucket instead |

A passing live smoke test is the precondition for raising MEGA's advertised
capabilities. Until then MEGA is correctly excluded from automatic upload
placement, and the other four connectors continue to work unaffected.

## Truthfulness rules applied

- A provider checksum with a different algorithm is never compared to SHA-256.
- `verified` is only claimed when our own digest of the received bytes matches,
  or a provider checksum of the same algorithm matches.
- Unknown or stale quota is never counted as free space.
- An unsupported capability is reported, never silently substituted.
