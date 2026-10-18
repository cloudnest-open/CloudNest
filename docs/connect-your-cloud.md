# Connect your cloud — the beginner guide (Personal tier)

This guide walks you through connecting **your own** cloud accounts to
CloudNest, click by click, assuming you have never registered a developer app
before. If you already know your way around OAuth consoles and just want the
exact scopes and redirect URIs, the terse reference is
[provider-setup.md](provider-setup.md) instead.

You will need:

- a running CloudNest (see the [quick install](../README.md#install-and-run)),
- an account with the cloud provider you want to connect,
- about ten minutes per provider, once.

The same three steps apply to every personal provider:

```text
  Step 1                       Step 2                        Step 3
  At the provider's            In CloudNest:                 In CloudNest:
  developer site:              paste the app's               press Connect and
  create an app, copy its      ID + secret                   click "Allow" on the
  ID + secret, register        (encrypted on disk            provider's own sign-in
  CloudNest's callback URL     right after saving)           page — done.
```

The callback URL CloudNest will show you (and which every provider app must
be told to accept) looks like this:

```text
http://127.0.0.1:8787/api/providers/<provider>/oauth/callback
```

`<provider>` is `google_drive`, `dropbox`, `onedrive` or `pcloud`. If you
changed `APP_BASE_URL` in your `.env`, the address starts with that instead —
the wizard in CloudNest always displays the exact one to copy, so you never
have to guess.

---

## Google Drive

**What you get afterwards:** CloudNest can only see and manage files *it
created* in your Drive (the `drive.file` scope). Your existing Drive files
stay invisible to CloudNest.

1. Open [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (any name, e.g. `cloudnest`).
2. In **APIs & Services → Library**, search for **Google Drive API** and
   press **Enable**.
3. In **APIs & Services → OAuth consent screen**, choose **External**, fill in
   an app name and your e-mail, and under **Test users** add the Google
   account you will connect.
4. In **Credentials → Create credentials → OAuth client ID**, pick
   **Web application** and add the callback URL shown by CloudNest's wizard
   under **Authorized redirect URIs**.
5. Copy the **Client ID** and **Client secret**, and paste them into
   CloudNest: **Cloud Accounts → Connect → Google Drive** (first time) or
   **Settings → Provider Setup**.
6. Press **Connect** again — Google's own sign-in page opens, you approve,
   and the account appears in CloudNest with its real free space.

```text
  Google Cloud Console                    CloudNest
 ┌───────────────────────┐               ┌────────────────────────────┐
 │ project → Drive API ✓ │               │ Cloud Accounts             │
 │ consent screen ✓      │  ID + secret  │  ┌──────────────────────┐  │
 │ credentials ✓         │ ────────────► │  │ Google Drive  ✓ ready│  │
 │ redirect URI ✓        │               │  └──────────┬───────────┘  │
 └───────────────────────┘               │      Connect ─► Allow ─► connected
                                         └────────────────────────────┘
```

> **One important warning:** while your Google app is in **Testing** mode,
> Google expires CloudNest's reconnection token after **7 days** — the
> account stops uploading until you approve it again. The fix is one click:
> on the OAuth consent screen press **Publish app** (move it *In production*).
> CloudNest asks only for the narrow `drive.file` scope, so no Google review
> process is needed for personal use.

## Dropbox

**What you get afterwards:** CloudNest works inside a single **App folder**
in your Dropbox (e.g. `/Apps/CloudNest`) — the rest of your Dropbox is never
touched.

1. Open [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
   and press **Create app**.
2. Choose **Scoped access**, access type **App folder**, and any name.
3. On the **Permissions** tab tick these four and **press Submit** (forgetting
   Submit is the most common Dropbox mistake):
   `files.metadata.read`, `files.metadata.write`, `files.content.read`,
   `files.content.write`.
4. On the **Settings** tab add the callback URL under **Redirect URIs**.
5. Copy the **App key** and **App secret** into CloudNest, then press
   **Connect** and approve on Dropbox's page.

## OneDrive

**What you get afterwards:** CloudNest works inside its own folder in your
OneDrive via Microsoft Graph, with an offline token so uploads keep working.

1. Open [Microsoft Entra](https://entra.microsoft.com) → **App registrations**
   → **New registration** (name it anything; account type: personal +
   work/school accounts unless you know you want narrower).
2. Under **Authentication**, add a **Web** platform entry with the callback
   URL, and tick **Access tokens** and **ID tokens**.
3. Under **API permissions** add delegated **Files.ReadWrite** and
   **offline_access**.
4. Under **Certificates & secrets** create a client secret and copy its
   **Value** (shown only once).
5. Paste the **Application (client) ID** and the secret into CloudNest, then
   **Connect** and approve on Microsoft's page.

## pCloud

1. Open pCloud's developer portal and create an app; register the callback
   URL.
2. Paste the **Client ID** (and secret if the portal issues one) into
   CloudNest, then **Connect**.
3. Both the US (`api.pcloud.com`) and EU (`eapi.pcloud.com`) regions are
   supported — CloudNest detects which one your account uses.

## MEGA (experimental — works differently)

MEGA has no OAuth developer apps: CloudNest signs in with your **MEGA e-mail
and password** directly (typed into CloudNest's own connect form, encrypted on
disk like every other credential). If your MEGA account uses **two-factor
authentication**, the form asks for a one-time code from your authenticator
app — you type it once at connect time, and again whenever the account is
re-authenticated (the code is valid once each time, by design).

MEGA is currently **experimental**: you can connect it and see its quota, but
new uploads are not routed to it yet. This is stated honestly everywhere and
will change only after a live end-to-end test of its upload path.

---

## S3-compatible buckets (Business tier — for people who know S3)

If you administer S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2,
Wasabi, a MinIO server…), you already know what to have ready: an **endpoint
URL**, **region**, **access key ID** and **secret access key**, a **bucket**,
and optionally a **prefix** to work inside. Create the bucket and keys in your
provider's console the way you normally would, then fill in CloudNest's S3
form — no OAuth is involved. Because buckets have no quota API, you set the
**capacity cap** yourself and CloudNest tracks the used bytes against it.
Business-tier chunks transfer **browser-direct** over short-lived pre-signed
URLs.

## Common first-time hiccups

| What you see | What it means | The fix |
|---|---|---|
| `Invalid redirect uri` from the provider | The provider app's registered callback doesn't match CloudNest's | Copy the address again from the wizard and register it exactly (protocol, port, path) |
| A provider page says permissions are missing | Scopes were not saved on the provider side (Dropbox: Submit was not pressed) | Re-check the permissions list in the provider console |
| The account connects but never gets chosen for uploads | Quota is unknown or the account is excluded | Open Cloud Accounts and refresh the quota / check participation |
| Google reconnects every 7 days | Your Google app is still in Testing mode | Publish the app to production (see the warning above) |

Anything else: [docs/troubleshooting.md](troubleshooting.md) has the full
error-code list, and [PROVIDER_STATUS.md](../PROVIDER_STATUS.md) states
honestly which connectors are verified how far.
