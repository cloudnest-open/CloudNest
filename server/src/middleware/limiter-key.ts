import type { Request } from 'express';

/**
 * BE-01 / BE-02 remediation helpers.
 *
 * Behind the optional Cloudflare tunnel every visitor shares 127.0.0.1 as the
 * socket address, so naive per-IP rate limiting collapses into one global
 * bucket (an attacker could lock the admin out of login with 10 requests).
 * When the request really did arrive through the guarded tunnel path we key
 * on Cloudflare's verified client header instead. The header is only trusted
 * when the tunnel is actually running — a direct loopback caller cannot
 * forge a wider identity.
 */

/** The verified client header Cloudflare sets on tunneled requests. */
const CF_CLIENT_HEADER = 'cf-connecting-ip';

/** True when this request plausibly arrived through the running tunnel. */
export function requestIsTunneled(req: Request, tunnelRunning: boolean): boolean {
  if (!tunnelRunning) return false;
  // hostOriginGuard has already constrained the Host; a tunneled request
  // always reaches us over the loopback socket with a CF client header.
  return typeof req.header(CF_CLIENT_HEADER) === 'string';
}

/**
 * Stable limiter key: the CF client id for tunneled traffic, otherwise the
 * socket address. Falls back safely when the header is absent.
 */
export function limiterKeyFor(req: Request, tunnelRunning: boolean): string {
  if (tunnelRunning) {
    const cf = req.header(CF_CLIENT_HEADER);
    if (typeof cf === 'string' && cf.length > 0 && cf.length <= 64) {
      return `cf:${cf}`;
    }
  }
  return req.ip ?? 'unknown';
}

/** Shared keyGenerator factory so every limiter uses the same policy. */
export function makeLimiterKey(tunnelRunning: () => boolean): (req: Request) => string {
  return (req: Request) => limiterKeyFor(req, tunnelRunning());
}
