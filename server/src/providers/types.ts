/** Provider adapter contract (Step 3). One small typed contract, no plugin framework. */

export type ProviderId = 'google_drive' | 'dropbox' | 'pcloud' | 'mega' | 'onedrive';
export const PROVIDER_IDS: readonly ProviderId[] = ['google_drive', 'dropbox', 'pcloud', 'mega', 'onedrive'];

export const OAUTH_PROVIDER_IDS: readonly ProviderId[] = ['google_drive', 'dropbox', 'pcloud', 'onedrive'];

export type ProviderCredentialBundle =
  | { schemaVersion: 1; provider: 'google_drive'; accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number; grantedScopes: string[] }
  | { schemaVersion: 1; provider: 'dropbox'; accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number; grantedScopes: string[] }
  | { schemaVersion: 1; provider: 'pcloud'; accessToken: string; apiHost: 'api.pcloud.com' | 'eapi.pcloud.com'; userId: string }
  | { schemaVersion: 1; provider: 'mega'; email: string; password: string }
  | { schemaVersion: 1; provider: 'onedrive'; accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number; authority: string; grantedScopes: string[] };

export interface NormalizedQuota {
  totalBytes: number | null;
  usedBytes: number | null;
  status: 'current' | 'stale' | 'unknown';
  safeErrorCode?: 'quota_unavailable' | 'provider_rate_limited' | 'provider_unavailable';
}

export interface NormalizedAccount {
  providerAccountId: string; // stable provider ID, not email, when a stable ID exists
  displayLabel: string;
  quota: NormalizedQuota;
  grantedScopes?: string[]; // actual granted scopes where the provider returns them
  safeErrorCode?: string;   // e.g. refresh_token_missing
}

export interface DecryptedProviderAppConfig {
  provider: Exclude<ProviderId, 'mega'>;
  clientId: string;
  clientSecret: string;
  extra?: Record<string, string>; // e.g. Microsoft authority
}

export type ProviderSafeErrorCode =
  | 'provider_not_configured'
  | 'oauth_state_invalid'
  | 'oauth_denied'
  | 'token_exchange_failed'
  | 'refresh_token_missing'
  | 'needs_reauth'
  | 'identity_validation_failed'
  | 'invalid_credentials'
  | 'quota_unavailable'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'unsupported_security_mode';

export class ProviderError extends Error {
  readonly safeCode: ProviderSafeErrorCode;
  readonly httpStatus: number;
  /** `message` is for server-side diagnosis only and is never shown to the UI. */
  constructor(safeCode: ProviderSafeErrorCode, httpStatus = 502, message?: string) {
    super(message ?? safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly experimental: boolean;
  readonly displayName: string;
  readonly requiresAppConfig: boolean;
  /** Connect validates identity; returns quota in the same call when the provider exposes it. */
  connectAndReadAccount(credentialBundle: ProviderCredentialBundle, appConfig?: DecryptedProviderAppConfig): Promise<NormalizedAccount>;
  getQuota(credentialBundle: ProviderCredentialBundle, appConfig?: DecryptedProviderAppConfig): Promise<NormalizedQuota>;
  /** Refresh expiring OAuth tokens, validate non-expiring tokens, or report reauth needed. */
  ensureValidCredentials(credentialBundle: ProviderCredentialBundle, appConfig?: DecryptedProviderAppConfig): Promise<ProviderCredentialBundle>;
  revokeOrClose?(credentialBundle: ProviderCredentialBundle): Promise<{ revoked: boolean; safeErrorCode?: ProviderSafeErrorCode }>;
}

/** Minimal fetch helper: timeouts, size limits, no logging of bodies. */
export async function providerFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
  const { timeoutMs = 15000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    if (text.length > 1_000_000) throw new ProviderError('provider_unavailable', 502, 'response too large');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = json as Record<string, unknown> | null;
      const code = String(err?.['error'] ?? err?.['error_description'] ?? err?.['result'] ?? '');
      if (res.status === 401 || code.includes('invalid_grant') || code.includes('invalid_client') || code.includes('revoked')) {
        throw new ProviderError('needs_reauth', 401);
      }
      if (res.status === 429) throw new ProviderError('provider_rate_limited', 429);
      if (res.status >= 500) throw new ProviderError('provider_unavailable', 502);
      if (res.status === 403) throw new ProviderError('needs_reauth', 403);
      throw new ProviderError('provider_unavailable', 502);
    }
    return json;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') throw new ProviderError('provider_unavailable', 504, 'timeout');
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    clearTimeout(timer);
  }
}
