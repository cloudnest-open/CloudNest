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

  // ---- tunnel ----
  router.get('/api/tunnel', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: deps.tunnel.status(),
      requiredPermissions: [
        'Account → Cloudflare Tunnel → Edit (create and manage the tunnel)',
        'Zone → DNS → Edit (create the CNAME route for the chosen subdomain)',
      ],
      notes: [
        'The tunnel is optional: CloudNest works locally without Cloudflare.',
        'CloudNest has no registered Cloudflare OAuth app, so a narrowly scoped API token is used. A Global API Key is never requested.',
        'The app keeps listening on 127.0.0.1 only; enabling a tunnel does not change that.',
      ],
    });
  });

  router.post('/api/tunnel/start', adminOnly, deps.csrf.doubleCsrfProtection, heavyLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      hostname?: unknown;
      runtimeToken?: unknown;
      cloudflareToken?: unknown;
      zoneId?: unknown;
    };
    try {
      if (typeof body.runtimeToken !== 'string') throw new TunnelError('tunnel_token_required', 400);
      // the service validates the token shape AND encrypts it at rest before
      // anything is spawned; a Global API Key is refused inside it
      const result = await deps.tunnel.start({
        runtimeToken: body.runtimeToken,
        hostname: String(body.hostname ?? ''),
        cloudflareToken: typeof body.cloudflareToken === 'string' ? body.cloudflareToken : null,
        zoneId: typeof body.zoneId === 'string' ? body.zoneId : null,
      });
      deps.queries.recordAudit('tunnel_started', result.status.state !== 'error', result.status.state);
      res.json({
        ok: true,
        status: result.status,
        dnsRecord: result.dnsRecord,
        // a plain-language trace; never contains a token
        dnsActions: result.dnsActions,
      });
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
      notice:
        'The local connector was stopped and the runtime token file removed. Any DNS route or tunnel created in Cloudflare is NOT deleted automatically — remove it there if you no longer need it.',
    });
  });

  return router;
}
