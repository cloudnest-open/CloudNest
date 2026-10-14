/**
 * Minimal Cloudflare API v4 client for the optional CloudNest tunnel (M12.b).
 *
 * Guarantees this module makes:
 * - no dependency beyond the platform: the transport is an injected `fetchImpl`
 *   (default: the global `fetch`), so tests exercise it entirely offline;
 * - the API token is sent only as an `Authorization: Bearer` header. It is
 *   never placed in a URL, a query string, a log line, an error message or a
 *   returned object;
 * - every failure is reduced to a safe code. A raw Cloudflare response body is
 *   never surfaced to a caller, a log or an HTTP client.
 *
 * Operational honesty (measured, not assumed):
 * - the request paths below follow the documented Cloudflare API v4 layout.
 *   They were NOT exercised against a live Cloudflare account in this
 *   environment, so they remain unverified against the real service;
 * - `listZones` performs a single page of up to 50 zones. Accounts with more
 *   zones than that need paging, which this minimal client does not implement;
 * - creating a DNS record sends `ttl: 1` (Cloudflare "automatic"); that value
 *   is likewise unverified against the live service here.
 */

export const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

const DEFAULT_TIMEOUT_MS = 10_000;
const ZONE_PAGE_SIZE = 50;
/** Zone/record/tunnel identifiers are opaque to us; this charset blocks path
 * traversal through an identifier while accepting real Cloudflare ids. */
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TUNNEL_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DNS_NAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Safe failure codes this client can produce. */
export type CloudflareSafeErrorCode =
  | 'cloudflare_token_missing'
  | 'cloudflare_token_verify_failed'
  | 'cloudflare_auth_failed'
  | 'cloudflare_permission_denied'
  | 'cloudflare_not_found'
  | 'cloudflare_rate_limited'
  | 'cloudflare_server_error'
  | 'cloudflare_unreachable'
  | 'cloudflare_bad_response'
  | 'cloudflare_bad_request'
  | 'cloudflare_api_error';

export class CloudflareApiError extends Error {
  readonly safeCode: CloudflareSafeErrorCode;
  constructor(safeCode: CloudflareSafeErrorCode) {
    // the message is the safe code and nothing else: no upstream text, no secret
    super(safeCode);
    this.name = 'CloudflareApiError';
    this.safeCode = safeCode;
  }
}

export interface CloudflareHttpRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface CloudflareHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type CloudflareFetchImpl = (url: string, init: CloudflareHttpRequest) => Promise<CloudflareHttpResponse>;

export interface CloudflareApiOptions {
  /** Injected transport; tests pass a fake and therefore make no network call. */
  fetchImpl?: CloudflareFetchImpl;
  /** Overridden in tests only; production always uses the public API. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

/** The subset of the client the tunnel service depends on (injectable in tests). */
export interface CloudflareTunnelApi {
  verifyToken(): Promise<{ ok: boolean; safeErrorCode: string | null }>;
  listZones(): Promise<Array<{ id: string; name: string }>>;
  findDnsRecord(zoneId: string, hostname: string): Promise<CloudflareDnsRecord | null>;
  createCname(zoneId: string, hostname: string, target: string): Promise<CloudflareDnsRecord>;
}

interface CloudflareEnvelope {
  success: boolean;
  result: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readEnvelope(parsed: unknown): CloudflareEnvelope | null {
  const record = asRecord(parsed);
  if (!record) return null;
  const success = record['success'];
  if (typeof success !== 'boolean') return null;
  return { success, result: record['result'] };
}

function failureCodeForStatus(status: number): CloudflareSafeErrorCode {
  if (status === 401) return 'cloudflare_auth_failed';
  if (status === 403) return 'cloudflare_permission_denied';
  if (status === 404) return 'cloudflare_not_found';
  if (status === 429) return 'cloudflare_rate_limited';
  if (status >= 500) return 'cloudflare_server_error';
  if (status >= 400) return 'cloudflare_bad_request';
  return 'cloudflare_api_error';
}

function verifyCodeForStatus(status: number): CloudflareSafeErrorCode {
  if (status === 429) return 'cloudflare_rate_limited';
  if (status >= 500) return 'cloudflare_server_error';
  // any other rejection of the verification call means the token itself is not
  // usable, which is a distinct safe code from a permission denial elsewhere
  return 'cloudflare_token_verify_failed';
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

const defaultFetchImpl: CloudflareFetchImpl = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
  };
};

export class CloudflareApi implements CloudflareTunnelApi {
  private readonly token: string;
  private readonly fetchImpl: CloudflareFetchImpl;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(token: string, options: CloudflareApiOptions = {}) {
    const value = token.trim();
    if (value === '') throw new CloudflareApiError('cloudflare_token_missing');
    this.token = value;
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl;
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Call the token-verification endpoint. Any rejection of that call is
   * reported as a distinct safe code rather than thrown.
   */
  async verifyToken(): Promise<{ ok: boolean; safeErrorCode: string | null }> {
    try {
      await this.request('/user/tokens/verify', { method: 'GET', verify: true });
      return { ok: true, safeErrorCode: null };
    } catch (err) {
      if (err instanceof CloudflareApiError) return { ok: false, safeErrorCode: err.safeCode };
      throw err;
    }
  }

  /** Up to ZONE_PAGE_SIZE zones (see the module note about paging). */
  async listZones(): Promise<Array<{ id: string; name: string }>> {
    const envelope = await this.request('/zones', { method: 'GET', query: { per_page: String(ZONE_PAGE_SIZE) } });
    const result = envelope.result;
    if (!Array.isArray(result)) throw new CloudflareApiError('cloudflare_bad_response');
    const zones: Array<{ id: string; name: string }> = [];
    for (const entry of result) {
      const record = asRecord(entry);
      const id = record ? readString(record['id']) : null;
      const name = record ? readString(record['name']) : null;
      if (!id || !name) continue;
      zones.push({ id, name: normalizeDnsName(name) });
    }
    return zones;
  }

  /** Existing record for exactly this name, or null when none exists. */
  async findDnsRecord(zoneId: string, hostname: string): Promise<CloudflareDnsRecord | null> {
    const zone = this.assertZoneId(zoneId);
    const name = this.assertDnsName(hostname);
    const envelope = await this.request(`/zones/${encodeURIComponent(zone)}/dns_records`, {
      method: 'GET',
      query: { name, per_page: '5' },
    });
    const result = envelope.result;
    if (!Array.isArray(result)) throw new CloudflareApiError('cloudflare_bad_response');
    for (const entry of result) {
      const record = this.readDnsRecord(entry);
      if (record && normalizeDnsName(record.name) === name) return record;
    }
    return null;
  }

  /**
   * Create the CNAME that routes `hostname` to `<tunnel-id>.cfargotunnel.com`.
   * Both names are validated locally before any request is made.
   */
  async createCname(zoneId: string, hostname: string, target: string): Promise<CloudflareDnsRecord> {
    const zone = this.assertZoneId(zoneId);
    const name = this.assertDnsName(hostname);
    const content = this.assertDnsName(target);
    const envelope = await this.request(`/zones/${encodeURIComponent(zone)}/dns_records`, {
      method: 'POST',
      body: { type: 'CNAME', name, content, proxied: true, ttl: 1 },
    });
    const record = this.readDnsRecord(envelope.result);
    if (!record) throw new CloudflareApiError('cloudflare_bad_response');
    return record;
  }

  private assertZoneId(zoneId: string): string {
    const value = zoneId.trim();
    if (!ASSET_ID_RE.test(value)) throw new CloudflareApiError('cloudflare_bad_request');
    return value;
  }

  private assertDnsName(value: string): string {
    const name = normalizeDnsName(value);
    if (!DNS_NAME_RE.test(name)) throw new CloudflareApiError('cloudflare_bad_request');
    return name;
  }

  private readDnsRecord(entry: unknown): CloudflareDnsRecord | null {
    const record = asRecord(entry);
    if (!record) return null;
    const id = readString(record['id']);
    const name = readString(record['name']);
    const type = readString(record['type']);
    const content = readString(record['content']);
    if (!id || !name || !type || !content) return null;
    return { id, name, type, content, proxied: record['proxied'] === true };
  }

  private async request(
    pathname: string,
    options: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown; verify?: boolean },
  ): Promise<CloudflareEnvelope> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    // belt and braces: a token must never be able to reach a URL or a query string
    if (url.toString().includes(this.token)) throw new CloudflareApiError('cloudflare_api_error');

    const init: CloudflareHttpRequest = {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
    };

    let response: CloudflareHttpResponse;
    try {
      response = await this.fetchImpl(url.toString(), init);
    } catch {
      // the transport error text is deliberately dropped: it could echo a URL
      throw new CloudflareApiError('cloudflare_unreachable');
    }

    let envelope: CloudflareEnvelope | null = null;
    try {
      envelope = readEnvelope(await response.json());
    } catch {
      envelope = null;
    }

    if (!response.ok) {
      throw new CloudflareApiError(options.verify ? verifyCodeForStatus(response.status) : failureCodeForStatus(response.status));
    }
    if (!envelope) throw new CloudflareApiError('cloudflare_bad_response');
    if (envelope.success !== true) {
      throw new CloudflareApiError(options.verify ? 'cloudflare_token_verify_failed' : failureCodeForStatus(response.status));
    }
    return envelope;
  }
}

export { TUNNEL_ID_RE };
