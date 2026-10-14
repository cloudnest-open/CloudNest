# Provider setup and usage

CloudNest connects to your **own** cloud accounts through official OAuth flows.
CloudNest does not ship, host, or share any provider application credentials:
you register the application with each provider yourself, then paste the
client ID/secret into Settings → Provider Setup. Secrets are stored encrypted
(AES-256-GCM) and are never displayed again after saving.

Each connected account gets a dedicated CloudNest root folder; CloudNest only
ever lists, reads, uploads, and deletes objects inside that root.

## Redirect URI to register

Register exactly this callback for every OAuth provider, substituting your
configured `APP_BASE_URL` if you changed it:

```
http://127.0.0.1:8787/api/providers/<provider>/oauth/callback
```

The provider is one of `google_drive`, `dropbox`, `onedrive`, `pcloud`.
The OAuth `state` value is validated on return, and PKCE is used wherever the
provider supports it.

## Google Drive

1. In Google Cloud Console create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External is fine for personal use; add
   yourself as a test user while the app is unverified).
3. Create an OAuth **Web application** client with the redirect URI above.
4. Paste the client ID and secret into Settings → Provider Setup → Google Drive.
5. Cloud Accounts → Connect → Google Drive.

Scope requested: `https://www.googleapis.com/auth/drive.file` — CloudNest can
only see files it created, never your other Drive content.

## Dropbox

1. Create an app at the Dropbox App Console with **Scoped access** and
   **App folder** access type.
2. Add the redirect URI above under OAuth 2 → Redirect URIs.
3. Enable the permissions: `files.metadata.read`, `files.metadata.write`,
   `files.content.read`, `files.content.write`.
4. Paste the App key/secret into Settings → Provider Setup → Dropbox.

CloudNest requests offline access so uploads keep working unattended.

## OneDrive

1. In Microsoft Entra (Azure AD) register an application.
2. Add a **Web** platform redirect URI as above.
3. Grant delegated Microsoft Graph permissions `Files.ReadWrite` and
   `offline_access`, and create a client secret.
4. Paste the Application (client) ID and secret into Settings → Provider
   Setup → OneDrive.

An optional `authority` value (tenant) can be supplied to restrict the account
to a single tenant; the default `common` accepts personal and work accounts.
CloudNest never sends credentials to the storage host on a redirect download.

## pCloud

1. Create an app at pCloud's developer portal and set the redirect URI above.
2. Paste the App client ID (and secret if issued) into Settings → Provider
   Setup → pCloud.
3. Both the US (`api.pcloud.com`) and EU (`eapi.pcloud.com`) regions are
   supported; CloudNest validates the returned host/region pair instead of
   guessing the endpoint.

pCloud's OAuth code flow has no scope parameter, and pCloud passes the access
token in request URLs (their documented convention).

## MEGA (experimental)

MEGA uses the community `megajs` library, not an official SDK. It is pinned and
labelled **experimental**. Until a live smoke test proves streaming upload and
recovery end to end, MEGA is **excluded from automatic upload placement** — you
can connect it and inspect its quota, but new chunks are not routed to it.

Provide the MEGA e-mail and password in Settings → Provider Setup. Two-factor
accounts may not complete the automated login.

## Usage notes and provider limitations

- **Quota is advisory.** Provider quotas and rate limits change without notice.
  Where a provider does not report quota, CloudNest shows **Unknown** and that
  account is excluded from automatic space-based placement rather than being
  treated as empty.
- **Policies and limits vary per provider and per account.** Free tiers in
  particular may restrict API usage or flag unusual automated activity. Read
  each provider's terms; do not treat any CloudNest behaviour as a guarantee
  that a provider permits a given volume or pattern of use. Using a dedicated
  account for CloudNest reduces the risk to your primary account, but **the
  provider's own policies govern your account** — CloudNest imposes no separate
  account limit and cannot override a provider's enforcement.
- **Multiple accounts per provider** are supported and are never assumed to
  have equal free space.
- **Disconnecting** an account never deletes remote objects. If CloudNest-managed
  chunks live there, they are marked unavailable pending a reconnect.
- **Provider-native upload limits** are honoured: CloudNest refuses an object
  larger than a provider's single-request ceiling rather than attempting it.
- **Live testing**: no connector has been verified against a live account in the
  development environment. See `PROVIDER_STATUS.md` for the per-provider truth.
