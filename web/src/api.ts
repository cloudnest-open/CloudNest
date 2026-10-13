/** Tiny CSRF-aware API client for the CloudNest UI. */

let csrfToken = '';

async function request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** Always fetch a token before the first unsafe request and after auth changes. */
export async function refreshCsrfToken(): Promise<void> {
  const { data } = await request('GET', '/api/auth/csrf-token');
  csrfToken = (data as { csrfToken?: string })?.csrfToken ?? '';
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  experimental: boolean;
  requiresAppConfig: boolean;
  callbackUri: string | null;
  verificationStatus: string;
  lastVerifiedAt: string | null;
  lastSafeErrorCode: string | null;
}

export interface AccountInfo {
  id: string;
  provider: string;
  displayName: string;
  experimental: boolean;
  displayLabel: string;
  accountIdentifier: string | null;
  status: 'connected' | 'needs_reauth' | 'disconnected' | 'error';
  quota: {
    totalBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    status: 'current' | 'stale' | 'unknown';
    lastCheckedAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
  };
  reserveBytes: number;
  reservedInflightBytes: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  setupStatus: () => request('GET', '/api/setup/status'),
  me: () => request('GET', '/api/auth/me'),
  setup: (password: string) => request('POST', '/api/setup', { password, confirm: password }),
  login: (password: string) => request('POST', '/api/auth/login', { username: 'admin', password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('POST', '/api/auth/change-password', { currentPassword, newPassword, confirmNew: newPassword }),

  // providers + accounts (Step 3)
  providers: () => request('GET', '/api/providers'),
  saveProviderConfig: (provider: string, body: { clientId: string; clientSecret: string; authority?: string }) =>
    request('PUT', `/api/providers/${provider}/config`, body),
  oauthStart: (provider: string) => request('POST', `/api/providers/${provider}/oauth/start`),
  megaConnect: (email: string, password: string) =>
    request('POST', '/api/providers/mega/credentials', { email, password }),
  accounts: () => request('GET', '/api/provider-accounts'),
  refreshQuota: (id: string) => request('POST', `/api/provider-accounts/${id}/refresh-quota`),
  refreshAllQuotas: () => request('POST', '/api/provider-accounts/refresh-quotas'),
  updateAccount: (id: string, body: { displayLabel?: string; reserveBytes?: number }) =>
    request('PATCH', `/api/provider-accounts/${id}`, body),
  reconnect: (id: string) => request('POST', `/api/provider-accounts/${id}/reconnect`),
  disconnect: (id: string) => request('POST', `/api/provider-accounts/${id}/disconnect`),
};
