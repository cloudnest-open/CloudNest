import { Router } from 'express';
import type { Queries } from '../db/queries.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { PROVIDER_IDS } from '../providers/types.js';
import type { ProviderMetrics } from '../metrics/provider-metrics.js';
import type { ProviderAccountService } from '../services/provider-account-service.js';

/**
 * Roadmap Phase 5 (§4.5) — per-provider reliability metrics for the Dashboard
 * health badge. Admin-only: provider accounts are admin knowledge (Phase 3),
 * and so is their reliability data. Every number is derived from real rows:
 * daily metric buckets, live account statuses, and tracked placement bytes.
 * Nothing is extrapolated — a provider with no traffic says so.
 */

export type ProviderHealth = 'healthy' | 'degraded' | 'down' | 'unconfigured';

export function metricsRouter(deps: {
  queries: Queries;
  metrics: ProviderMetrics;
  accounts: ProviderAccountService;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);

  router.get('/api/metrics/providers', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const usage = deps.metrics.summary(1);
    const accounts = deps.accounts.list();
    const tracked = deps.accounts.trackedPlacementBytes();

    const providers = PROVIDER_IDS.map((provider) => {
      const list = accounts.filter((a) => a.provider === provider);
      const m = usage.get(provider);
      const total = m?.requestsTotal ?? 0;
      const failed = m?.requestsFailed ?? 0;
      const connected = list.filter((a) => a.status === 'connected').length;
      const attention = list.filter((a) => a.status === 'needs_reauth' || a.status === 'error').length;
      // an error rate is only honest once it has enough samples to mean
      // something; below that the badge leans on account status alone
      const errorRate = total >= 5 ? failed / total : null;
      // "down" means genuinely unreachable: disconnected/errored accounts, or
      // a provider that mostly fails. needs_reauth keeps the data intact —
      // that is degraded, not down.
      const unreachable = list.filter((a) => a.status === 'disconnected' || a.status === 'error').length;
      let health: Exclude<ProviderHealth, 'unconfigured'> = 'healthy';
      if (list.length > 0 && connected === 0 && unreachable === list.length) health = 'down';
      else if (errorRate !== null && errorRate > 0.5) health = 'down';
      else if (attention > 0 || (errorRate !== null && errorRate > 0.1)) health = 'degraded';
      const lastCheckAt = list
        .map((a) => a.last_quota_check_at)
        .filter((v): v is string => typeof v === 'string')
        .sort()
        .pop() ?? null;
      return {
        provider,
        health: list.length === 0 ? ('unconfigured' as const) : health,
        accounts: { total: list.length, connected, attention },
        storedBytes: list.reduce((sum, a) => sum + (tracked.get(a.id) ?? 0), 0),
        requests: { total, failed, errorRate },
        bytes: { uploaded: m?.bytesUploaded ?? 0, downloaded: m?.bytesDownloaded ?? 0 },
        lastErrorCode: m?.lastErrorCode ?? null,
        lastErrorAt: m?.lastErrorAt ?? null,
        lastCheckAt,
      };
    });

    res.json({ providers, windowDays: 1 });
  });

  return router;
}
