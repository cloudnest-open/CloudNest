/** Tiny CSRF-aware API client for the CloudNest UI. */

let csrfToken = '';

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown; retryAfterMs?: number | null }> {
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
  // §9 backoff: the server may tell the client exactly how long to wait
  // (per-account contention answers with Retry-After).
  const retryAfter = res.headers.get('retry-after');
  const retrySeconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, retryAfterMs: retrySeconds !== null ? retrySeconds * 1000 : null };
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
  /** Storage tier (roadmap Phase 1): personal OAuth pools vs business S3 pools. */
  tier: 'personal' | 'business';
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
  /** Owner-confirmed shared-pool key (§6.2); null = independent quota scope. */
  quotaScopeKey: string | null;
  /** Owner-set per-bucket cap (S3-compatible accounts); null elsewhere. */
  capacityCapBytes: number | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  hasCredentials: boolean;
  /** Files/chunks that reference this account's active placements (disconnect-warning data). */
  usage: { trackedFiles: number; trackedChunks: number };
  createdAt: string;
  updatedAt: string;
}

export interface MeInfo {
  authenticated: boolean;
  kind?: 'admin' | 'user';
  role?: 'admin' | 'member';
  username?: string;
  displayName?: string;
  email?: string;
  userId?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  status: 'active' | 'invited' | 'disabled';
  allowanceBytes: number | null;
  usedBytes: number;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  setupStatus: () => request('GET', '/api/setup/status'),
  me: () => request('GET', '/api/auth/me'),
  setup: (password: string) => request('POST', '/api/setup', { password, confirm: password }),
  /** The username field accepts the built-in admin's name OR a member's email. */
  login: (username: string, password: string) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('POST', '/api/auth/change-password', { currentPassword, newPassword, confirmNew: newPassword }),
  /** Public: set a password from a one-time invite / reset token. */
  acceptInvite: (token: string, password: string) =>
    request('POST', '/api/auth/accept-invite', { token, password, confirm: password }),

  // ---- users admin (roadmap Phase 3) ----
  listUsers: () => request('GET', '/api/users'),
  inviteUser: (body: { email: string; displayName: string; role: 'admin' | 'member'; allowanceBytes: number | null }) =>
    request('POST', '/api/users', body),
  updateUser: (id: string, body: { role?: 'admin' | 'member'; status?: 'active' | 'disabled'; allowanceBytes?: number | null }) =>
    request('PATCH', `/api/users/${id}`, body),
  resetUserPassword: (id: string) => request('POST', `/api/users/${id}/password-reset`, {}),
  removeUser: (id: string) => request('DELETE', `/api/users/${id}`),

  // providers + accounts (Step 3)
  providers: () => request('GET', '/api/providers'),
  saveProviderConfig: (provider: string, body: { clientId: string; clientSecret: string; authority?: string }) =>
    request('PUT', `/api/providers/${provider}/config`, body),
  oauthStart: (provider: string) => request('POST', `/api/providers/${provider}/oauth/start`),
  megaConnect: (email: string, password: string) =>
    request('POST', '/api/providers/mega/credentials', { email, password }),
  connectS3: (body: {
    endpoint: string; region: string; accessKeyId: string; secretAccessKey: string;
    bucket: string; prefix: string; capacityCapBytes: number | null;
  }) => request('POST', '/api/providers/s3/credentials', body),
  accounts: () => request('GET', '/api/provider-accounts'),
  refreshQuota: (id: string) => request('POST', `/api/provider-accounts/${id}/refresh-quota`),
  refreshAllQuotas: () => request('POST', '/api/provider-accounts/refresh-quotas'),
  updateAccount: (id: string, body: { displayLabel?: string; reserveBytes?: number }) =>
    request('PATCH', `/api/provider-accounts/${id}`, body),
  reconnect: (id: string) => request('POST', `/api/provider-accounts/${id}/reconnect`),
  /** §6.2 owner-confirmed shared-pool grouping: explicit accountIds, or clear. */
  setQuotaScope: (provider: string, accountIds: string[] | null) =>
    request('POST', '/api/provider-accounts/quota-scope', accountIds ? { provider, accountIds } : { provider, clear: true }),
  disconnect: (id: string) => request('POST', `/api/provider-accounts/${id}/disconnect`),

  // ---- uploads (Step 4 / M9) ----
  dashboardSummary: () => request('GET', '/api/dashboard/summary'),
  listFiles: (limit = 50, offset = 0, search = '') =>
    request('GET', `/api/files?limit=${limit}&offset=${offset}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  planUpload: (body: { originalName: string; sizeBytes: number; chunkSizeMiB: number; mimeType: string | null; tier?: 'personal' | 'business' }, idempotencyKey: string) =>
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
  uploadChunkRaw: (jobId: string, chunkIndex: number, body: Blob) =>
    request('PUT', `/api/uploads/${jobId}/chunks/${chunkIndex}`, body),

  // ---- presigned direct transfer (roadmap Phase 2, business tier) ----
  /** Ask the server where one chunk goes: a presigned URL or the proxy path. */
  beginChunkDirect: (jobId: string, chunkIndex: number) =>
    request('POST', `/api/uploads/${jobId}/chunks/${chunkIndex}/begin`, {}),
  /** Report a finished direct PUT; the server re-verifies the size at the provider. */
  completeChunkDirect: (jobId: string, chunkIndex: number, body: { attemptId: string; sha256: string; etag: string | null }) =>
    request('POST', `/api/uploads/${jobId}/chunks/${chunkIndex}/complete`, body),
  /** Report a direct PUT that failed, so the server-side in-flight slot frees. */
  failChunkDirect: (jobId: string, chunkIndex: number, attemptId: string, code: string | null) =>
    request('POST', `/api/uploads/${jobId}/chunks/${chunkIndex}/fail`, { attemptId, code }),

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
  createBackup: () => request('POST', '/api/maintenance/backup'),  listBackups: () => request('GET', '/api/maintenance/backups'),
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

/**
 * One chunk straight to the provider with a presigned URL (roadmap Phase 2):
 * no cookies, no CSRF token and no CloudNest server in the path — the URL's
 * own query-string signature is the whole authorization. Returns the provider
 * ETag when the response exposes it (bucket CORS permitting); the server
 * never trusts it as a verification claim.
 */
export async function presignedPut(url: string, body: Blob): Promise<{ ok: boolean; status: number; etag: string | null }> {
  const res = await fetch(url, {
    method: 'PUT',
    body,
    credentials: 'omit',
    headers: { 'content-type': 'application/octet-stream' },
  });
  let etag: string | null = null;
  try {
    etag = res.headers.get('etag');
  } catch {
    etag = null;
  }
  return { ok: res.ok, status: res.status, etag };
}
