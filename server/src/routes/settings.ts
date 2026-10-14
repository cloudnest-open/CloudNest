import { Router } from 'express';
import type { SettingsService } from '../settings/settings-service.js';
import { SettingsError } from '../settings/settings-service.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';

/**
 * Settings API (M12.a). Only allowlisted non-secret keys are writable, and a
 * bulk update is all-or-nothing so a typo cannot partially apply.
 */
export function settingsRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  settings: SettingsService;
  appVersion: string;
  dataDir: string;
  port: number;
  appBaseUrl: string;
  tunnelStatus: () => {
    enabled: boolean;
    state: string;
    hostname: string | null;
    cloudflaredAvailable: boolean;
    safeErrorCode: string | null;
  };
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);

  router.get('/api/settings', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      settings: deps.settings.all(),
      system: {
        appVersion: deps.appVersion,
        dataDir: deps.dataDir,
        port: deps.port,
        appBaseUrl: deps.appBaseUrl,
        // an honest statement of where the app is reachable
        bindMode: 'loopback-only' as const,
      },
      tunnel: deps.tunnelStatus(),
    });
  });

  router.patch('/api/settings', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const updated = deps.settings.setMany(body);
      deps.queries.recordAudit('settings_updated', true, 'saved', { keys: Object.keys(body).length });
      res.json({ ok: true, settings: updated });
    } catch (err) {
      if (err instanceof SettingsError) {
        res.status(400).json({ error: err.safeCode, code: err.safeCode, message: err.message });
        return;
      }
      res.status(500).json({ error: 'settings_failed', code: 'settings_failed' });
    }
  });

  return router;
}
