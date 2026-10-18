import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { MaintenanceService } from '../maintenance/maintenance-service.js';
import { MaintenanceError } from '../maintenance/maintenance-service.js';
import type { DiagnosticsService } from '../maintenance/diagnostics-service.js';
import type { TunnelService } from '../tunnel/tunnel-service.js';
import { TunnelError } from '../tunnel/tunnel-service.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';

/**
 * Maintenance, diagnostics and tunnel routes (M12.b/c/d).
 * Every route here is admin-only; state changes additionally require CSRF.
 * `/api/maintenance/restore` requires an explicit absolute `targetDir` and never
 * overwrites an existing destination database unless `confirmOverwrite: true`.
 */
export function maintenanceRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  maintenance: MaintenanceService;
  diagnostics: DiagnosticsService;
  tunnel: TunnelService;
  dbPath: string;
  counts: () => Record<string, number>;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);
  const heavyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'too_many_requests' },
  });

  // ---- backup / restore ----
  router.post('/api/maintenance/backup', adminOnly, deps.csrf.doubleCsrfProtection, heavyLimiter, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = deps.maintenance.backup(deps.dbPath, deps.counts());
      deps.queries.recordAudit('backup_created', true, 'metadata_backup');
      res.status(201).json({
        directory: result.directory,
        manifest: result.manifest,
        // the UI must repeat this: a metadata backup holds no file bytes
        notice:
          'Metadata/configuration backup created. It contains manifests, jobs, shares and account references — not the file bytes, and not the credential-encryption key.',
      });
    } catch (err) {
      if (err instanceof MaintenanceError) {
        res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
        return;
      }
      res.status(500).json({ error: 'backup_failed', code: 'backup_failed' });
    }
  });

  router.get('/api/maintenance/backups', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ backups: deps.maintenance.listBackups(), key: deps.maintenance.keyStatus() });
  });

  router.post('/api/maintenance/verify', adminOnly, deps.csrf.doubleCsrfProtection, heavyLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { databasePath?: unknown };
    try {
      const verified = deps.maintenance.verifyBackup(String(body.databasePath ?? ''));
      deps.queries.recordAudit('backup_verified', verified.readable, 'verified');
      res.json({ verification: verified });
    } catch (err) {
      if (err instanceof MaintenanceError) {
        res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
        return;
      }
      res.status(500).json({ error: 'verify_failed', code: 'verify_failed' });
    }
  });

  router.post('/api/maintenance/restore', adminOnly, deps.csrf.doubleCsrfProtection, heavyLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { databasePath?: unknown; targetDir?: unknown; confirmOverwrite?: unknown };
    try {
      // targetDir is required and must be absolute: the service refuses an empty
      // or relative value with `restore_target_invalid` rather than defaulting
      // to the process working directory.
      const restored = deps.maintenance.restoreInto(
        String(body.databasePath ?? ''),
        String(body.targetDir ?? ''),
        { confirmOverwrite: body.confirmOverwrite === true },
      );
      deps.queries.recordAudit('restore_performed', true, 'into_new_directory');
      res.json({
        ok: true,
        restoredPath: restored.restoredPath,
        overwritten: restored.overwritten,
        notice:
          'Restored into a new directory. The live data directory was not touched. Provider accounts need credential-master.key; without it they must be reconnected.',
      });
    } catch (err) {
      if (err instanceof MaintenanceError) {
        res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
        return;
      }
      res.status(500).json({ error: 'restore_failed', code: 'restore_failed' });
    }
  });

  // ---- diagnostics ----
  router.get('/api/maintenance/diagnostics', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const report = deps.diagnostics.build();
    // the redactor has already run inside both of these
    res.json({ report, text: deps.diagnostics.toText(report) });
  });

  // ---- tunnel (browser-authorized — approved design §6; NO API token) ----
  router.get('/api/tunnel', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: deps.tunnel.status(),
      connectionCheck: deps.tunnel.checkConnection(),
      notes: [
        'The tunnel is optional: CloudNest works locally without Cloudflare.',
        'Authorization is the cloudflared browser login — the owner approves in their own browser; no API token is ever requested.',
        'The app keeps listening on 127.0.0.1 only; enabling a tunnel does not change that.',
      ],
    });
  });

  /** Wizard step 1: open the Cloudflare authorize page (rclone-style). */
  router.post('/api/tunnel/auth/start', adminOnly, deps.csrf.doubleCsrfProtection, heavyLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const status = deps.tunnel.browserAuth.startLogin();
      deps.queries.recordAudit('tunnel_login_started', true, status.state);
      res.json({ ok: true, authorization: status });
    } catch (err) {
      const code = err instanceof Error && 'safeCode' in err ? (err as { safeCode: string }).safeCode : 'tunnel_failed';
      const http = err instanceof Error && 'httpStatus' in err ? (err as { httpStatus: number }).httpStatus : 500;
      deps.queries.recordAudit('tunnel_login_started', false, code);
      res.status(http).json({ error: code, code });
    }
  });

  /** Wizard step 2: poll until the owner finishes (or fails) the authorize. */
  router.get('/api/tunnel/auth/status', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ authorization: deps.tunnel.browserAuth.status() });
  });

  router.post('/api/tunnel/start', adminOnly, deps.csrf.doubleCsrfProtection, heavyLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { hostname?: unknown };
    try {
      if (typeof body.hostname !== 'string') throw new TunnelError('invalid_tunnel_hostname', 400);
      const result = await deps.tunnel.start({ hostname: body.hostname });
      deps.queries.recordAudit('tunnel_started', result.status.state !== 'error', result.status.state);
      res.json({ ok: true, status: result.status, actions: result.actions });
    } catch (err) {
      if (err instanceof TunnelError) {
        deps.queries.recordAudit('tunnel_started', false, err.safeCode);
        res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
        return;
      }
      res.status(500).json({ error: 'tunnel_failed', code: 'tunnel_failed' });
    }
  });

  router.post('/api/tunnel/stop', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const status = deps.tunnel.stop();
    deps.queries.recordAudit('tunnel_stopped', true, 'disconnected');
    res.json({
      ok: true,
      status,
      // owner requirement: Disconnect is reversible — Reconnect reuses the
      // stored authorization without a new browser login
      notice:
        'The local connector was stopped. The browser authorization and tunnel credentials stay stored, so Reconnect works without logging in again. Anything created in Cloudflare is NOT deleted automatically.',
    });
  });

  /** The explicit "start over": deletes the stored cert/credentials/metadata. */
  router.post('/api/tunnel/forget', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const status = deps.tunnel.forgetAuthorization();
    deps.queries.recordAudit('tunnel_authorization_forgotten', true, status.authorization.state);
    res.json({ ok: true, status });
  });

  return router;
}
