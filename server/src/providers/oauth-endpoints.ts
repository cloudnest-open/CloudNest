import type { DecryptedProviderAppConfig, ProviderId } from './types.js';

/**
 * Per-provider OAuth endpoints, exact callback URIs and scope sets.
 * All values are derived from trusted server configuration only.
 */

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  usesPkce: boolean;
  extraAuthParams?: Record<string, string>;
  /** Provider-specific transport for the token exchange. */
  exchange: (params: URLSearchParams) => { url: string; body: string; contentType: string };
}

export function callbackUri(appBaseUrl: string, provider: ProviderId): string {
  return `${appBaseUrl}/api/providers/${provider}/oauth/callback`;
}

export function oauthEndpoints(provider: Exclude<ProviderId, 'mega' | 's3'>, config: DecryptedProviderAppConfig): OAuthEndpoints {
  switch (provider) {
    case 'google_drive':
      return {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
        usesPkce: true,
        extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
        exchange: (params) => ({ url: 'https://oauth2.googleapis.com/token', body: params.toString(), contentType: 'application/x-www-form-urlencoded' }),
      };
    case 'dropbox':
      return {
        authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
        tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
        scopes: ['files.metadata.read', 'files.metadata.write', 'files.content.read', 'files.content.write'],
        usesPkce: true,
        // App Folder access; offline access type is required for unattended use
        extraAuthParams: { token_access_type: 'offline' },
        exchange: (params) => ({ url: 'https://api.dropboxapi.com/oauth2/token', body: params.toString(), contentType: 'application/x-www-form-urlencoded' }),
      };
    case 'pcloud':
      return {
        authorizeUrl: 'https://my.pcloud.com/oauth2/authorize',
        tokenUrl: 'https://api.pcloud.com/oauth2_token',
        scopes: [], // pCloud has no scope parameter for the code flow
        usesPkce: false,
        exchange: (_params) => ({ url: 'https://api.pcloud.com/oauth2_token', body: '', contentType: 'application/x-www-form-urlencoded' }),
      };
    case 'onedrive':
      const authority = (config.extra?.['authority'] ?? 'common') as string;
      return {
        authorizeUrl: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
        scopes: ['offline_access', 'Files.ReadWrite'],
        usesPkce: true,
        extraAuthParams: {},
        exchange: (params) => ({ url: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`, body: params.toString(), contentType: 'application/x-www-form-urlencoded' }),
      };
  }
}

export const PCLOUD_US_HOST = 'api.pcloud.com';
export const PCLOUD_EU_HOST = 'eapi.pcloud.com';

/** Validate the callback's returned hostname/locationid pair against the documented mapping. */
export function validatePcloudHost(hostname: string | undefined, locationId: string | undefined): 'api.pcloud.com' | 'eapi.pcloud.com' | null {
  if (!hostname) return null;
  const host = hostname.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  if (![PCLOUD_US_HOST, PCLOUD_EU_HOST].includes(host)) return null;
  // documented mapping: locationid 1 = US (api), 2 = EU (eapi)
  if (locationId === '1' && host !== PCLOUD_US_HOST) return null;
  if (locationId === '2' && host !== PCLOUD_EU_HOST) return null;
  return host as 'api.pcloud.com' | 'eapi.pcloud.com';
}
