# Support

CloudNest is a self-hosted, open-source project maintained as a volunteer
effort. There is no paid support desk, no SLA, and no chat channel — support
means the documentation plus GitHub Issues. Here is the fastest path to an
answer.

## 1. Check the documentation first

Most setup and operations questions are answered in the repository docs:

| Topic | Where |
|---|---|
| How CloudNest works, in diagrams | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| Connecting your cloud accounts, step by step (beginner) | [docs/connect-your-cloud.md](docs/connect-your-cloud.md) |
| Installing, running, upgrading, backups | [RELEASE.md](RELEASE.md) |
| Connecting your cloud accounts (OAuth apps, scopes, redirect URIs) | [docs/provider-setup.md](docs/provider-setup.md) |
| Error codes and recovery steps | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Using the app (files, folders, uploads, shares, users) | [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) |
| Architecture and design decisions | [docs/architecture.md](docs/architecture.md) |
| Configuration variables | [README.md](README.md#configuration-env-all-optional-and-non-secret) |
| Known limitations of the current release | [RELEASE.md](RELEASE.md) |

## 2. Report a problem on GitHub Issues

Open an issue at
[github.com/cloudnest-open/CloudNest/issues](https://github.com/cloudnest-open/CloudNest/issues)
for bugs and feature requests. Include:

- the CloudNest version (Settings → System shows `appVersion`)
- your OS and Node.js version (`node --version`)
- what you did, what you expected, and what actually happened
- the exact error message or the relevant log lines

Please **do not** include in any report:

- your administrator or member passwords
- the credential-encryption key (`credential-master.key`)
- provider secrets, OAuth tokens, or account identifiers
- links that embed share tokens

Redact anything that looks like a secret before pasting logs — the public
issue tracker is a public place.

## 3. Security issues are different

Do **not** open a public issue for a security problem. Follow
[SECURITY.md](SECURITY.md) and use GitHub's private vulnerability reporting
(Security tab → Report a vulnerability) instead.

## 4. Before you ask about a failing provider connection

CloudNest has **not been live-tested against every provider** in the
development environment (see
[PROVIDER_STATUS.md](PROVIDER_STATUS.md) for the honest evidence status of
each connector). When a real account fails to connect or upload:

1. re-run the connection check in Cloud Accounts and note the error code
2. verify your OAuth app's redirect URI and scopes against
   [docs/provider-setup.md](docs/provider-setup.md)
3. check the provider's own status page and quota/dashboard

That information belongs in your issue report — it is the first thing a
maintainer needs.
