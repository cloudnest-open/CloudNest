# How CloudNest works — a picture-first tour

This page explains the whole product with simple diagrams. You do not need any
special knowledge to read it: every box is explained in plain words right under
the picture. If you want the deep technical notes afterwards, see
[architecture.md](architecture.md).

The one-sentence version:

> CloudNest keeps a **table of contents on your computer** and the **actual
> file pieces inside your own cloud accounts** — so no cloud provider, and not
> even CloudNest itself, ever holds a whole file in one place.

```text
   Your computer                              Your cloud accounts (yours, not ours)
 ┌──────────────────────┐                    ┌──────────┐ ┌──────────┐ ┌──────────┐
 │  Browser (the app)   │                    │  Google  │ │ Dropbox  │ │ OneDrive │
 │  Files · Uploads ·   │                    │  Drive   │ │          │ │  pCloud  │
 │  Shares · Settings   │                    └────▲─────┘ └────▲─────┘ └────▲─────┘
 └──────────▲───────────┘                         │            │            │
            │ http://127.0.0.1:8787               │  pieces of │  your files│ (chunks)
 ┌──────────┴───────────┐                         │            │            │
 │  CloudNest server    │─────────────────────────┴────────────┴────────────┘
 │  (one small program) │   sends / fetches pieces through each provider's
 │  ┌────────────────┐  │   official API — never a whole file in one place,
 │  │ SQLite (index) │  │   and never on this computer.
 │  │ + settings     │  │
 │  └────────────────┘  │
 └──────────────────────┘
```

Two words that appear everywhere below:

- **chunk** — CloudNest cuts a big file into equal-size pieces (chunks). Each
  piece is stored separately, so one account holds only part of a file.
- **CloudNest root** — a folder CloudNest creates inside each connected
  account. CloudNest only ever touches objects inside that folder.

## 1. Install and run

```text
  GitHub repo                your computer
 ┌────────────┐   clone    ┌──────────────────────────────────────────────┐
 │ CloudNest  │ ─────────► │  CloudNest/                                  │
 └────────────┘            │                                              │
                           │  npm ci        → downloads the toolbox       │
                           │  npm run build → compiles UI + server        │
                           │  npm start     → serves on 127.0.0.1:8787    │
                           └──────────────────────────────────────────────┘
```

What each line actually does:

- `git clone` downloads the source code from GitHub — nothing is installed
  system-wide.
- `npm ci` downloads the dependencies Node needs (the "toolbox") into a local
  `node_modules/` folder inside the project. Nothing outside that folder
  changes.
- `npm run build` compiles the browser UI and the server into a `dist/`
  folder.
- `npm start` starts **one** program. It listens **only on your own machine**
  (`127.0.0.1`), on port `8787`. No other computer can reach it unless you
  later turn on the optional tunnel (section 6).

You need **Node.js 24** installed first (it brings `npm` with it). See
[RELEASE.md](../RELEASE.md) for the exact steps on a fresh computer.

## 2. First run — you become the administrator

```text
   Browser                                Database (SQLite on your disk)
 ┌───────────────────┐                    ┌──────────────────────────────┐
 │ "Create admin     │   your password    │ admin row:                   │
 │  password" screen │ ─────────────────► │   scrypt hash (never the     │
 └───────────────────┘                    │   password itself)           │
                                          │ sessions: server-side,       │
                                          │   rotate at every login      │
                                          └──────────────────────────────┘
```

- There is **no default password** — the very first screen makes you create
  it. The password itself is never stored; only an irreversible hash is.
- After this you sign in with the login name (it starts as `admin`; you can
  change it later in **Profile → Change login name**) and your password.
- Every "do something" request from the browser carries a second, invisible
  token (CSRF) so that a malicious web page cannot command CloudNest behind
  your back.

## 3. Connecting a cloud account

```text
   CloudNest                 your browser                    the provider
 ┌───────────┐  "Connect" ┌──────────────────┐  sign in +  ┌─────────────┐
 │ prepares  │ ─────────► │ provider's own   │  "Allow"    │ Google/Drop │
 │ a secret  │            │ sign-in page     │ ──────────► │ box/…       │
 │ one-time  │            └──────────────────┘             └──────┬──────┘
 │ handshake │                                                   │ redirect
 │ (state)   │ ◄───────────────── back to CloudNest ─────────────┘
 └───────────┘        tokens stored ENCRYPTED on your disk
      │
      └─► creates a dedicated "CloudNest" root folder in the account
```

- The sign-in happens **on the provider's own page** — CloudNest never sees
  your Google/Dropbox/… password. Only the resulting access tokens come back,
  and those are encrypted (AES-256-GCM) before they touch the disk.
- You register the provider app yourself (one time per provider); CloudNest's
  built-in wizard shows the exact address to copy. Full steps:
  [connect-your-cloud.md](connect-your-cloud.md) (beginner) and
  [provider-setup.md](provider-setup.md) (technical).
- CloudNest can use **several accounts, even several from the same provider**,
  and treats each one's real free space separately.

## 4. Upload — how a file becomes chunks

```text
   one 90 MB file
 ┌───────────────────────────────────────────────┐
 │ ████████████████████████████████████████████ │
 └───────────────────────────────────────────────┘
        │ CloudNest cuts it (example: 64 MB chunks)
        ▼
   ┌───────────────┬───────────────┐
   │  chunk 1      │  chunk 2      │   ← the plan: who has room for what?
   └──────┬────────┴───────┬───────┘
          ▼                ▼
   Google Drive       OneDrive          ← pieces land in different accounts;
   (CloudNest root)   (CloudNest root)    each is verified after landing
```

- Before sending anything, CloudNest **plans**: it asks every account how much
  free space it really has and picks where each chunk goes. If nothing fits,
  it says exactly what is missing instead of failing halfway.
- Every chunk is **verified** after upload, and the whole plan is
  **resumable** — pause, close the browser, restart the computer; the job
  continues from the last confirmed piece.
- Business tier (S3-compatible buckets) works the same way, but chunks move
  **browser-direct** over short-lived pre-signed URLs.

## 5. Download and sharing

```text
   "download report.pdf"
           │
           ▼
   ┌─ fetch chunk 1 from Google Drive ── verify checksum ─┐
   │  fetch chunk 2 from OneDrive    ── verify checksum ──┼──► the exact
   │  (mirror copy used automatically if an account       │    original file,
   │   is down)                                           │    byte for byte
   └──────────────────────────────────────────────────────┘
```

- Downloads are **reconstructed** piece by piece and each piece is checked
  against its recorded checksum. A corrupted or missing piece is reported
  honestly instead of delivered silently broken.
- **Share links** hand a file to someone without giving them your cloud
  passwords: they open a link served by *your* CloudNest, which streams the
  file through and hides the providers completely. Links can expire, be
  limited to N downloads, or require a password.

## 6. Optional: opening it to your other devices (tunnel)

```text
   phone / laptop elsewhere            your computer
 ┌──────────────┐  https (tunnel)  ┌──────────────────────────┐
 │ CloudNest UI │ ───────────────► │ Cloudflare edge ◄────────│── CloudNest
 └──────────────┘                  │ (your own domain)        │    stays bound
                                   └──────────────────────────┘    to 127.0.0.1
```

- Out of the box CloudNest is **private to your machine**. If you want to use
  it from outside, Settings → Domain walks you through Cloudflare's own
  browser authorization (you approve it on Cloudflare's page — CloudNest never
  asks for a Cloudflare password or API token). You can disconnect it any
  time; the app itself keeps listening on loopback only.

## 7. Where everything lives on your disk

```text
  <DATA_DIR>/                      (default: your OS per-user data folder)
  ├─ cloudnest.db            ← the index: names, folders, chunk map, users,
  │                             shares, sessions (metadata ONLY — no bytes)
  ├─ credential-master.key   ← the key that decrypts provider tokens.
  │                             ★ back this up separately ★
  └─ backups/                ← metadata backups you create in Settings
```

Your files' bytes exist **only inside your cloud accounts**, as chunks inside
each account's CloudNest root folder. Uninstalling CloudNest means deleting
this folder plus the app — the stored file pieces in your providers remain
yours, under your control, and providers still show them.

## 8. The promises these pictures are bound to

- **No whole file on this computer** — metadata only; pieces live in your
  accounts.
- **No telemetry** — the app talks to your providers and nowhere else unless
  you enable the tunnel.
- **Unknown is not zero** — if an account's free space can't be read, it is
  never guessed at; the account just isn't used for automatic placement until
  its quota is refreshed.
- **Honest states** — a failed job says it failed; a disconnected account says
  which files became unreachable. Nothing pretends.

Details and code-level notes: [architecture.md](architecture.md) ·
Error messages explained: [troubleshooting.md](troubleshooting.md) ·
Connecting accounts: [connect-your-cloud.md](connect-your-cloud.md)
