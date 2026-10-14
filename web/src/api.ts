/** Tiny CSRF-aware API client for the CloudNest UI. */

let csrfToken = '';

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  // A Blob body is sent raw (chunk upload); anything else is JSON.
  const isBlob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined && !isBlob ? { 'content-type': 'application/json' } : {}),
      ...(isBlob ? { 'content-type': 'application/octet-stream' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
      ...(extraHeaders ?? {}),
    },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
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

  // ---- uploads (Step 4 / M9) ----
  dashboardSummary: () => request('GET', '/api/dashboard/summary'),
  listFiles: (limit = 50, offset = 0, search = '') =>
    request('GET', `/api/files?limit=${limit}&offset=${offset}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  planUpload: (body: { originalName: string; sizeBytes: number; chunkSizeMiB: number; mimeType: string | null }, idempotencyKey: string) =>
    request('POST', '/api/uploads/plan', body, { 'idempotency-key': idempotencyKey }),
  listUploads: () => request('GET', '/api/uploads'),
  getUploadJob: (jobId: string) => request('GET', `/api/uploads/${jobId}`),
  resumeManifest: (jobId: string, offset = 0, limit = 200) =>
    request('GET', `/api/uploads/${jobId}/resume-manifest?offset=${offset}&limit=${limit}`),
  pauseUpload: (jobId: string) => request('POST', `/api/uploads/${jobId}/pause`),
  resumeUpload: (jobId: string) => request('POST', `/api/uploads/${jobId}/resume`),
  cancelUpload: (jobId: string) => request('POST', `/api/uploads/${jobId}/cancel`),
  retryUpload: (jobId: string) => request('POST', `/api/uploads/${jobId}/retry`),

  /**
   * One raw logical chunk as the request body — never multipart, never JSON.
   * The server streams and hashes these exact bytes.
   */
  uploadChunkRaw: (jobId: string, chunkIndex: number, body: Blob): Promise<{ status: number; data: unknown }> =>
    request('PUT', `/api/uploads/${jobId}/chunks/${chunkIndex}`, body),

  // ---- downloads + rename (Step 5 / M10) ----
  fileDetails: (fileId: string) => request('GET', `/api/files/${fileId}`),
  renameFile: (fileId: string, name: string) => request('POST', `/api/files/${fileId}/rename`, { name }),
  listDownloads: (limit = 50, offset = 0) => request('GET', `/api/downloads?limit=${limit}&offset=${offset}`),
  getDownload: (jobId: string) => request('GET', `/api/downloads/${jobId}`),
  cancelDownload: (jobId: string) => request('POST', `/api/downloads/${jobId}/cancel`),

  // ---- share links + deletion (Step 5 / M11) ----
  listShareLinks: () => request('GET', '/api/share-links'),
  createShareLink: (body: { fileIds: string[]; password?: string; expiresAt?: string | null; downloadLimit?: number | null }) =>
    request('POST', '/api/share-links', body),
  updateShareLink: (id: string, body: { expiresAt?: string | null; downloadLimit?: number | null }) =>
    request('PATCH', `/api/share-links/${id}`, body),
  rotateShareLink: (id: string) => request('POST', `/api/share-links/${id}/rotate`),
  revokeShareLink: (id: string) => request('POST', `/api/share-links/${id}/revoke`),
  deleteFile: (fileId: string) => request('DELETE', `/api/files/${fileId}`),
  deletionStatus: (jobId: string) => request('GET', `/api/deletions/${jobId}`),
  retryDeletion: (jobId: string) => request('POST', `/api/deletions/${jobId}/retry`),

  // ---- settings, maintenance, tunnel (Step 6 / M12) ----
  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (patch: Record<string, unknown>) => request('PATCH', '/api/settings', patch),
  createBackup: () => request('POST', '/api/maintenance/backup'),
  listBackups: () => request('GET', '/api/maintenance/backups'),
  verifyBackup: (databasePath: string) => request('POST', '/api/maintenance/verify', { databasePath }),
  restoreBackup: (databasePath: string, targetDir: string, confirmOverwrite = false) =>
    request('POST', '/api/maintenance/restore', { databasePath, targetDir, confirmOverwrite }),
  getDiagnostics: () => request('GET', '/api/maintenance/diagnostics'),
  getTunnel: () => request('GET', '/api/tunnel'),
  startTunnel: (body: {
    hostname: string;
    runtimeToken: string;
    /** Scoped Cloudflare API token: enables the DNS pre-check; never stored. */
    cloudflareToken?: string;
    /** Optional zone hint when the token can see several zones. */
    zoneId?: string;
  }) => request('POST', '/api/tunnel/start', body),
  stopTunnel: () => request('POST', '/api/tunnel/stop'),

  /** URL for a browser-native download (Range/resume handled by the browser). */
  downloadUrl: (fileId: string) => `/api/files/${fileId}/download`,

  /** Internal: expose the CSRF token flow for raw-body uploads. */
  refreshCsrf: refreshCsrfToken,
};
