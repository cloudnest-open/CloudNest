import crypto from 'node:crypto';

/**
 * AWS Signature Version 4 (SigV4), implemented on node:crypto only.
 *
 * CloudNest adds no third-party AWS SDK dependency: the adapter needs exactly
 * five S3 operations, and SigV4 is a small, fully specified HMAC chain. All
 * functions here are pure and exported for deterministic test vectors.
 *
 * Requests are signed with `x-amz-content-sha256: UNSIGNED-PAYLOAD` when the
 * body is a stream (chunk uploads) and with the real SHA-256 when the body is
 * empty or fully known — both are documented S3 behaviours and work on
 * R2/B2/AWS alike.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** YYYYMMDD'T'HHMMSS'Z' — the amz-date format SigV4 requires. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** YYYYMMDD — the credential-scope date. */
export function scopeDate(date: Date): string {
  return amzDate(date).slice(0, 8);
}

export function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hmacBytes(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** The four-step SigV4 signing-key derivation: date → region → service → terminator. */
export function deriveSigningKey(secretAccessKey: string, date: string, region: string, service = 's3'): Buffer {
  let key = hmacBytes(`AWS4${secretAccessKey}`, date);
  key = hmacBytes(key, region);
  key = hmacBytes(key, service);
  return hmacBytes(key, 'aws4_request');
}

/**
 * URI-encode per SigV4 rules: unreserved characters stay, everything else
 * (including `/` when encoding a key) becomes %XX uppercase hex.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9._~-]/.test(char)) {
      out += char;
    } else if (char === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      out += [...Buffer.from(char, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    }
  }
  return out;
}

export interface CanonicalRequestInput {
  method: string;
  /** Path, starting with `/` (path-style: `/{bucket}/{key...}`), already URI-encoded. */
  pathname: string;
  /** Query parameters; encoded canonically and sorted by name. */
  query: Record<string, string> | URLSearchParams;
  headers: Record<string, string>;
  /** Hex SHA-256 of the payload, or 'UNSIGNED-PAYLOAD'. */
  payloadHash: string;
}

export function canonicalQuery(query: Record<string, string> | URLSearchParams): string {
  const entries: Array<[string, string]> = query instanceof URLSearchParams
    ? [...query.entries()]
    : Object.entries(query);
  return entries
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    // the spec sorts by encoded name, then by encoded value (duplicate names
    // are ordered by value, as the AWS SigV4 test suite's ordering case proves)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * The canonical request:
 *   HTTPMethod\n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n SignedHeaders \n PayloadHash
 * host, x-amz-*, range and content-type are signed (matching the AWS S3
 * documentation's own single-chunk examples); volatile headers such as
 * content-length stay unsigned so a streaming fetch cannot invalidate the
 * signature mid-flight.
 */
export function buildCanonicalRequest(input: CanonicalRequestInput): { canonicalRequest: string; signedHeaders: string } {
  const signed: Array<[string, string]> = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as [string, string])
    .filter(([k]) => k === 'host' || k.startsWith('x-amz') || k === 'range' || k === 'content-type')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = signed.map(([k]) => k).join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.pathname,
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  return { canonicalRequest, signedHeaders };
}

export function buildStringToSign(canonicalRequest: string, date: Date, region: string, service = 's3'): string {
  const scope = `${scopeDate(date)}/${region}/${service}/aws4_request`;
  return `AWS4-HMAC-SHA256\n${amzDate(date)}\n${scope}\n${sha256Hex(canonicalRequest)}`;
}

/**
 * Sign one request: returns the headers to merge into the outgoing fetch
 * (authorization, x-amz-date, x-amz-content-sha256). The SigV4 rules require
 * every x-amz-* header that is SENT to also be SIGNED, so x-amz-date and
 * x-amz-content-sha256 join the canonical header set before signing.
 */
export function signS3Request(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  credentials: SigV4Credentials;
  now?: Date;
}): Record<string, string> {
  const date = input.now ?? new Date();
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate(date),
    'x-amz-content-sha256': input.payloadHash,
  };
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: input.method,
    pathname: input.url.pathname,
    query: input.url.searchParams,
    headers,
    payloadHash: input.payloadHash,
  });
  const stringToSign = buildStringToSign(canonicalRequest, date, input.credentials.region);
  const key = deriveSigningKey(input.credentials.secretAccessKey, scopeDate(date), input.credentials.region);
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scopeDate(date)}/${input.credentials.region}/s3/aws4_request, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface PresignedUrl {
  /** The fully signed URL: the browser calls it directly, no extra headers. */
  url: string;
  /** ISO instant after which the provider will refuse the URL. */
  expiresAt: string;
}

/**
 * Query-string presign (roadmap Phase 2): the browser PUTs one chunk straight
 * to S3 with these query parameters instead of an Authorization header, so the
 * bytes never pass through CloudNest. Exactly `host` is signed — the browser
 * cannot reproduce our header set, so every other header must stay unsigned —
 * and the payload is UNSIGNED-PAYLOAD because the browser streams bytes it
 * does not hash for us. The signature is computed over the five query
 * parameters alone; X-Amz-Signature is appended afterwards and is itself never
 * part of the canonical request (per the SigV4 query-auth spec).
 */
export function presignS3Request(input: {
  method: string;
  url: URL;
  credentials: SigV4Credentials;
  /** Seconds the URL stays valid; S3 caps this at 604800 (7 days). */
  expiresInSeconds: number;
  now?: Date;
}): PresignedUrl {
  const date = input.now ?? new Date();
  const expires = Math.max(1, Math.floor(input.expiresInSeconds));
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scopeDate(date)}/${input.credentials.region}/s3/aws4_request`,
    'X-Amz-Date': amzDate(date),
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname,
    canonicalQuery(query),
    `host:${input.url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = buildStringToSign(canonicalRequest, date, input.credentials.region);
  const key = deriveSigningKey(input.credentials.secretAccessKey, scopeDate(date), input.credentials.region);
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  const queryString = [...Object.entries(query), ['X-Amz-Signature', signature] as const]
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join('&');
  return {
    url: `${input.url.origin}${input.url.pathname}?${queryString}`,
    expiresAt: new Date(date.getTime() + expires * 1000).toISOString(),
  };
}
