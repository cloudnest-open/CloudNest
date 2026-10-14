# Contributing to CloudNest

Thank you for considering a contribution. CloudNest is a small, focused,
security-sensitive application; these rules keep it reviewable and safe.

## Ground rules

- **Security first.** Anything that widens network exposure, weakens the auth
  boundary, logs secrets, or touches cloud objects outside CloudNest's own
  namespace will be rejected. See `SECURITY.md` for the threat model.
- **No new dependencies without justification.** Each dependency adds supply
  chain and license surface. Name the dependency, its license, its maintenance
  status, and why the platform cannot do the job natively.
- **The approved architecture is small on purpose:** one Node.js process,
  Express 5, React + Vite, plain CSS, SQLite (WAL) via `better-sqlite3`, npm.
  Proposals to add services, databases, or frameworks belong in an issue first.

## Development workflow

1. Fork/branch from `main`.
2. `npm ci` then `npm run build` — the tree must build before you edit.
3. Make the change with its regression test. A bug fix without a test that
   fails against the old code is not complete.
4. Run the full gate:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
   Live provider tests are opt-in (`CLOUDNEST_LIVE_*` environment variables)
   and never run against real accounts in CI.
5. Keep commits focused; one logical change per commit; no secrets, no
   databases, no logs, no local configuration in commits.

## Code conventions

- TypeScript strict mode; no `any` without a comment justifying it.
- Server-side validation is the only validation: never trust client input,
  including file names, ranges, and settings values.
- Error handling uses safe codes (`ShareError`, `DownloadError`, `ProviderError`,
  `UploadError`) — raw provider or filesystem messages must not reach clients.
- All state-changing HTTP routes require the session + double-CSRF pair; the
  public share surface is the deliberate exception and must stay minimal.
- SQLite access goes through the prepared-statement query bundles; ad-hoc SQL
  with string interpolation is rejected.

## Tests

- `server/test/` is the canonical suite (`node:test`). Place new tests there.
- Provider adapter tests are mock contract tests; a live smoke test is opt-in
  and must never be claimed as evidence in a regular PR.
- Memory-budget, reservation, and verification invariants have dedicated tests —
  extend them when you touch those paths.

## Reporting issues

Open a GitHub issue with: expected behavior, actual behavior, reproduction
steps, and the version (`appVersion` from Settings → System). For suspected
security issues, use the private channel in `SECURITY.md` instead.

## License

By contributing, you agree that your contributions are licensed under the
Apache-2.0 license that covers the repository.
