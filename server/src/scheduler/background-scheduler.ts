import type { CredentialsStore } from '../providers/credentials-store.js';
import type { ProviderAccountService } from '../services/provider-account-service.js';
import type { ProviderMetrics } from '../metrics/provider-metrics.js';
import { refreshAllAccountQuotas } from '../services/quota-refresh.js';

/**
 * Roadmap Phase 5 — the background scheduler, the extended form of the hourly
 * sweep (§3 Phase 5). One module owns every recurring maintenance task:
 *
 * - sweepExpiredRows (hourly): the pre-existing cleanup of expired session
 *   rows, share sessions, unlock grants and trash past its restore window,
 *   unchanged in behaviour and log shape;
 * - retryCleanupObligations (hourly): durable remote-cleanup obligations
 *   (upload attempts in cleanup_pending), pending deletion jobs, and mirror
 *   jobs still queued/interrupted/failed — everything that must not be
 *   silently abandoned;
 * - refreshQuotas (every 6 hours): the ONE quota-refresh path over every
 *   account with credentials, so reservation reconciliation keeps flowing
 *   without anyone pressing "Refresh quota";
 * - metricsTick (hourly): prune daily metric buckets past the retention
 *   window and log the per-provider summary line.
 *
 * Discipline, unchanged from the original sweep: every task is best-effort
 * (a failure never prevents the others and never crashes the process), all
 * timers are unref'd so they cannot hold the process open, and startup runs
 * every task once before the server binds its port.
 */

export interface BackgroundSchedulerDeps {
  sessionStore?: { cleanupExpired?: () => number };
  shares?: { cleanupExpiredSessions?: () => number; cleanupExpiredUnlockGrants?: () => number };
  trash?: { purgeExpired: () => number };
  deletions?: { resumePending: () => Promise<{ attempted: number; completed: number }> };
  uploads?: { retryPendingCleanups: () => Promise<{ retried: number; cleaned: number; stillPending: number }> };
  mirror?: { resumePending: () => Promise<{ attempted: number; completed: number }> };
  accounts?: ProviderAccountService;
  store?: CredentialsStore;
  metrics?: ProviderMetrics;
}

export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly, like the original sweep
export const QUOTA_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createBackgroundScheduler(deps: BackgroundSchedulerDeps): {
  runAllOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
} {
  /** The pre-existing expired-row sweep, behaviour and logs unchanged. */
  async function sweepExpiredRows(): Promise<void> {
    try {
      let swept = 0;
      if (deps.sessionStore?.cleanupExpired) swept += deps.sessionStore.cleanupExpired();
      if (deps.shares?.cleanupExpiredSessions) swept += deps.shares.cleanupExpiredSessions();
      if (deps.shares?.cleanupExpiredUnlockGrants) swept += deps.shares.cleanupExpiredUnlockGrants();
      if (swept > 0) console.log(`[cloudnest] cleanup: expired ${swept} session/grant row(s)`);
    } catch {
      // cleanup is best-effort; rows remain for the next sweep
    }
    // trash past its restore window goes to the durable deletion engine;
    // queued jobs are driven exactly like startup recovery
    try {
      const purged = deps.trash?.purgeExpired() ?? 0;
      if (purged > 0) {
        console.log(`[cloudnest] trash: ${purged} file(s) past the restore window, queued for deletion`);
        await deps.deletions?.resumePending().catch(() => {
          // pending obligations remain recorded for the next sweep
        });
      }
    } catch {
      // best-effort; expired rows remain queued for the next sweep
    }
  }

  /** Everything recorded as "must not be forgotten" gets another honest try. */
  async function retryCleanupObligations(): Promise<void> {
    try {
      const cleanups = await deps.uploads?.retryPendingCleanups();
      if (cleanups && cleanups.cleaned > 0) {
        console.log(`[cloudnest] cleanup retry: ${cleanups.cleaned}/${cleanups.retried} remote object(s) cleaned`);
      }
    } catch {
      // obligations remain recorded for the next tick
    }
    try {
      const r = await deps.deletions?.resumePending();
      if (r && r.attempted > 0) {
        console.log(`[cloudnest] deletion retry: ${r.completed}/${r.attempted} completed`);
      }
    } catch {
      // pending deletion jobs remain queued
    }
    try {
      const r = await deps.mirror?.resumePending();
      if (r && r.attempted > 0) {
        console.log(`[cloudnest] mirror retry: ${r.completed}/${r.attempted} completed`);
      }
    } catch {
      // pending mirror jobs remain queued
    }
  }

  /** Keep reservation reconciliation flowing without anyone pressing refresh. */
  async function refreshQuotas(): Promise<void> {
    if (!deps.accounts || !deps.store) return;
    const rows = deps.accounts.list().filter((r) => r.credential_ciphertext !== null);
    if (rows.length === 0) return;
    try {
      const results = await refreshAllAccountQuotas(rows, deps.accounts, deps.store);
      const failed = results.filter((r) => !r.ok).length;
      console.log(
        `[cloudnest] quota refresh: ${results.length - failed}/${results.length} account(s) refreshed` +
        (failed > 0 ? `, ${failed} unavailable (recorded, retryable)` : ''),
      );
    } catch {
      // a failed batch refresh changes no auth state; the next tick tries again
    }
  }

  /** Bound the metrics table and speak the honest per-provider summary line. */
  function metricsTick(): void {
    if (!deps.metrics) return;
    try {
      deps.metrics.prune();
      const rows = [...deps.metrics.summary(1).values()];
      if (rows.length > 0) {
        const parts = rows.map((r) => {
          const rate = r.requestsTotal > 0
            ? `${Math.round(((r.requestsTotal - r.requestsFailed) / r.requestsTotal) * 100)}% ok`
            : 'no calls';
          return `${r.provider}: ${rate}, ${(r.bytesUploaded / (1024 * 1024)).toFixed(1)} MB up`;
        });
        console.log(`[cloudnest] metrics: ${parts.join('; ')}`);
      }
    } catch {
      // metrics are observational; they must never break the scheduler
    }
  }

  async function runAllOnce(): Promise<void> {
    await sweepExpiredRows();
    await retryCleanupObligations();
    await refreshQuotas();
    metricsTick();
  }

  let cleanupTimer: NodeJS.Timeout | null = null;
  let quotaTimer: NodeJS.Timeout | null = null;

  function start(): void {
    cleanupTimer = setInterval(() => {
      void sweepExpiredRows().then(retryCleanupObligations).then(metricsTick);
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    quotaTimer = setInterval(() => {
      void refreshQuotas();
    }, QUOTA_REFRESH_INTERVAL_MS);
    quotaTimer.unref();
  }

  function stop(): void {
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (quotaTimer) clearInterval(quotaTimer);
    cleanupTimer = null;
    quotaTimer = null;
  }

  return { runAllOnce, start, stop };
}
