import type Database from 'better-sqlite3';
import { ALLOWED_CHUNK_SIZES, type ChunkSizeMiB } from '../uploads/chunk-math.js';

/**
 * Application settings (M12.a).
 *
 * Only allowlisted, non-secret keys are accepted. Values are stored as JSON in
 * `app_settings`; an unknown key is rejected rather than silently ignored, so a
 * typo can never masquerade as a saved preference. Nothing here ever holds a
 * credential — secrets live only in the encrypted credential store.
 */

export const WORKER_LIMITS = { min: 1, hardCeiling: 8, autoDefault: 4 } as const;

export interface SettingsShape {
  'upload.chunkSizeMiB': number;
  'upload.workerLimit': number;
  'upload.spaceAwareRouting': boolean;
  'upload.verifyIntegrity': boolean;
  'download.concurrency': number;
  'share.defaultExpiryDays': number | null;
  'share.requirePassword': boolean;
  'share.defaultDownloadLimit': number | null;
  'security.confirmDestructive': boolean;
  'domain.publicBaseUrl': string | null;
  'domain.tunnelEnabled': boolean;
}

export const SETTINGS_DEFAULTS: SettingsShape = {
  'upload.chunkSizeMiB': 64,
  'upload.workerLimit': WORKER_LIMITS.autoDefault,
  'upload.spaceAwareRouting': true,
  'upload.verifyIntegrity': true,
  'download.concurrency': 3,
  'share.defaultExpiryDays': null,
  'share.requirePassword': false,
  'share.defaultDownloadLimit': null,
  'security.confirmDestructive': true,
  'domain.publicBaseUrl': null,
  'domain.tunnelEnabled': false,
};

export class SettingsError extends Error {
  readonly safeCode = 'invalid_setting';
  readonly httpStatus = 400;
}

/** Validate one setting; throws with a precise reason when it is unacceptable. */
export function validateSetting(key: string, raw: unknown): unknown {
  switch (key) {
    case 'upload.chunkSizeMiB': {
      const n = Number(raw);
      if (!(ALLOWED_CHUNK_SIZES as readonly number[]).includes(n)) {
        throw new SettingsError(`chunk size must be one of ${ALLOWED_CHUNK_SIZES.join(', ')} MiB`);
      }
      return n;
    }
    case 'upload.workerLimit': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < WORKER_LIMITS.min || n > WORKER_LIMITS.hardCeiling) {
        throw new SettingsError(`worker limit must be an integer between ${WORKER_LIMITS.min} and ${WORKER_LIMITS.hardCeiling}`);
      }
      return n;
    }
    case 'download.concurrency': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > WORKER_LIMITS.hardCeiling) {
        throw new SettingsError(`download concurrency must be an integer between 1 and ${WORKER_LIMITS.hardCeiling}`);
      }
      return n;
    }
    case 'share.defaultExpiryDays': {
      if (raw === null || raw === '') return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        throw new SettingsError('default expiry must be null or an integer number of days between 1 and 3650');
      }
      return n;
    }
    case 'share.defaultDownloadLimit': {
      if (raw === null || raw === '') return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
        throw new SettingsError('default download limit must be null or a positive integer');
      }
      return n;
    }
    case 'domain.publicBaseUrl': {
      if (raw === null || raw === '') return null;
      const value = String(raw).trim();
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new SettingsError('public base URL must be a valid origin');
      }
      // the scheme must be explicitly http(s): a scheme such as javascript: has
      // an origin of the literal string "null" and must never be accepted
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new SettingsError('public base URL must use https (or http for a local address)');
      }
      if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        throw new SettingsError('public base URL must be an origin only (scheme, host, optional port)');
      }
      return url.origin;
    }
    case 'upload.spaceAwareRouting':
    case 'upload.verifyIntegrity':
    case 'share.requirePassword':
    case 'security.confirmDestructive':
    case 'domain.tunnelEnabled': {
      if (typeof raw !== 'boolean') throw new SettingsError(`value for ${key} must be a boolean`);
      return raw;
    }
    default:
      throw new SettingsError(`unknown setting: ${key}`);
  }
}

export class SettingsService {
  constructor(private readonly db: Database.Database) {}

  all(): SettingsShape {
    const rows = this.db.prepare('SELECT setting_key, value_json FROM app_settings').all() as Array<{
      setting_key: string;
      value_json: string;
    }>;
    const result: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
    for (const row of rows) {
      if (!(row.setting_key in SETTINGS_DEFAULTS)) continue; // ignore stale keys
      try {
        result[row.setting_key] = JSON.parse(row.value_json);
      } catch {
        // a corrupt value falls back to the default rather than breaking startup
      }
    }
    return result as unknown as SettingsShape;
  }

  get<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
    return this.all()[key];
  }

  set(key: string, raw: unknown): SettingsShape {
    const validated = validateSetting(key, raw);
    this.db.prepare(
      `INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(validated), new Date().toISOString());
    return this.all();
  }

  /** All-or-nothing bulk update: one bad key means nothing is written. */
  setMany(patch: Record<string, unknown>): SettingsShape {
    const accepted: Array<[string, unknown]> = [];
    for (const [key, raw] of Object.entries(patch)) {
      accepted.push([key, validateSetting(key, raw)]);
    }
    const txn = this.db.transaction(() => {
      for (const [key, value] of accepted) {
        this.db.prepare(
          `INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        ).run(key, JSON.stringify(value), new Date().toISOString());
      }
    });
    txn();
    return this.all();
  }

  /** Effective chunk size for new uploads (documented default is 64 MiB). */
  effectiveChunkSizeMiB(): ChunkSizeMiB {
    return this.get('upload.chunkSizeMiB') as ChunkSizeMiB;
  }

  /** Effective worker limit, clamped to the hard ceiling. */
  effectiveWorkerLimit(): number {
    const configured = this.get('upload.workerLimit');
    return Math.min(Math.max(configured, WORKER_LIMITS.min), WORKER_LIMITS.hardCeiling);
  }
}
