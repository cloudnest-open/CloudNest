import type Database from 'better-sqlite3';
import { PROVIDER_IDS, type ProviderId } from '../providers/types.js';

/**
 * Roadmap Phase 5 — per-provider reliability metrics (M0015 `provider_metrics`).
 *
 * Aggregated DAILY buckets per provider: call counts, failure counts, and the
 * bytes that actually crossed the server. Never per-request rows, never
 * provider-external data, never an invented number — a bucket only grows when
 * a real call/transfer was recorded. The scheduler prunes days past the
 * retention window, so the table stays bounded no matter how long the
 * instance runs.
 */

/** Days of daily buckets kept before the scheduler prunes them. */
export const METRICS_RETENTION_DAYS = 30;

export interface ProviderMetricsSummaryRow {
  provider: string;
  requestsTotal: number;
  requestsFailed: number;
  bytesUploaded: number;
  bytesDownloaded: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

export class ProviderMetrics {
  private readonly recordCallStmt;
  private readonly recordBytesStmt;
  private readonly pruneStmt;
  private readonly windowStmt;
  private readonly lastErrorStmt;

  constructor(private readonly db: Database.Database) {
    this.recordCallStmt = db.prepare(`
      INSERT INTO provider_metrics (provider, day, requests_total, requests_failed, bytes_uploaded, bytes_downloaded, last_error_code, last_error_at, updated_at)
      VALUES (@provider, @day, 1, @failed, 0, 0, @last_error_code, @last_error_at, @updated_at)
      ON CONFLICT(provider, day) DO UPDATE SET
        requests_total = requests_total + 1,
        requests_failed = requests_failed + @failed,
        last_error_code = COALESCE(@last_error_code, last_error_code),
        last_error_at = COALESCE(@last_error_at, last_error_at),
        updated_at = @updated_at
    `);
    this.recordBytesStmt = db.prepare(`
      INSERT INTO provider_metrics (provider, day, requests_total, requests_failed, bytes_uploaded, bytes_downloaded, last_error_code, last_error_at, updated_at)
      VALUES (@provider, @day, 0, 0, @bytes_uploaded, @bytes_downloaded, NULL, NULL, @updated_at)
      ON CONFLICT(provider, day) DO UPDATE SET
        bytes_uploaded = bytes_uploaded + @bytes_uploaded,
        bytes_downloaded = bytes_downloaded + @bytes_downloaded,
        updated_at = @updated_at
    `);
    this.pruneStmt = db.prepare('DELETE FROM provider_metrics WHERE day < ?');
    this.windowStmt = db.prepare(`
      SELECT provider,
             SUM(requests_total) AS requestsTotal,
             SUM(requests_failed) AS requestsFailed,
             SUM(bytes_uploaded) AS bytesUploaded,
             SUM(bytes_downloaded) AS bytesDownloaded
      FROM provider_metrics
      WHERE day >= ?
      GROUP BY provider
    `);
    this.lastErrorStmt = db.prepare(
      'SELECT provider, last_error_code AS lastErrorCode, last_error_at AS lastErrorAt FROM provider_metrics ORDER BY updated_at DESC',
    );
  }

  recordCall(provider: string, ok: boolean, safeCode: string | null): void {
    if (!isKnownProvider(provider)) return;
    const now = new Date();
    this.recordCallStmt.run({
      provider,
      day: now.toISOString().slice(0, 10),
      failed: ok ? 0 : 1,
      last_error_code: ok ? null : (safeCode ?? 'provider_unavailable'),
      last_error_at: ok ? null : now.toISOString(),
      updated_at: now.toISOString(),
    });
  }

  recordBytes(provider: string, direction: 'up' | 'down', bytes: number): void {
    if (!isKnownProvider(provider) || !Number.isFinite(bytes) || bytes <= 0) return;
    const now = new Date();
    this.recordBytesStmt.run({
      provider,
      day: now.toISOString().slice(0, 10),
      bytes_uploaded: direction === 'up' ? Math.floor(bytes) : 0,
      bytes_downloaded: direction === 'down' ? Math.floor(bytes) : 0,
      updated_at: now.toISOString(),
    });
  }

  /** Drop daily buckets older than the retention window; returns rows removed. */
  prune(nowMs: number = Date.now()): number {
    const cutoff = new Date(nowMs - METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return this.pruneStmt.run(cutoff).changes;
  }

  /** Aggregated counters over the trailing window (1 = today+the last 24h of buckets). */
  summary(windowDays: number): Map<string, ProviderMetricsSummaryRow> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = this.windowStmt.all(cutoff) as Array<{
      provider: string; requestsTotal: number | null; requestsFailed: number | null;
      bytesUploaded: number | null; bytesDownloaded: number | null;
    }>;
    const lastErrors = new Map<string, { lastErrorCode: string | null; lastErrorAt: string | null }>();
    for (const row of this.lastErrorStmt.all() as Array<{ provider: string; lastErrorCode: string | null; lastErrorAt: string | null }>) {
      if (!lastErrors.has(row.provider)) {
        lastErrors.set(row.provider, { lastErrorCode: row.lastErrorCode, lastErrorAt: row.lastErrorAt });
      }
    }
    const out = new Map<string, ProviderMetricsSummaryRow>();
    for (const row of rows) {
      const err = lastErrors.get(row.provider);
      out.set(row.provider, {
        provider: row.provider,
        requestsTotal: row.requestsTotal ?? 0,
        requestsFailed: row.requestsFailed ?? 0,
        bytesUploaded: row.bytesUploaded ?? 0,
        bytesDownloaded: row.bytesDownloaded ?? 0,
        lastErrorCode: err?.lastErrorCode ?? null,
        lastErrorAt: err?.lastErrorAt ?? null,
      });
    }
    return out;
  }
}

function isKnownProvider(provider: string): provider is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(provider);
}

/**
 * The one process-wide recorder. Services record calls/bytes through the
 * module functions so call sites stay one line and no service needs to thread
 * the recorder through constructors. `configureProviderMetrics` runs once at
 * app creation; before that (and in any context without a database) recording
 * is an honest no-op — metrics are never invented.
 */
let recorder: ProviderMetrics | null = null;

export function configureProviderMetrics(metrics: ProviderMetrics): void {
  recorder = metrics;
}

export function recordProviderCall(provider: string, ok: boolean, safeCode: string | null): void {
  recorder?.recordCall(provider, ok, safeCode);
}

export function recordProviderBytes(provider: string, direction: 'up' | 'down', bytes: number): void {
  recorder?.recordBytes(provider, direction, bytes);
}
