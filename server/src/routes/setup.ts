import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type Database from 'better-sqlite3';
import { hashPassword, validatePasswordPolicy } from '../auth/password.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';

/** First-run setup: public only while no admin exists; rate-limited; CSRF-protected. */
export function setupRouter(queries: Queries, csrf: CsrfBundle, getDb: () => Database.Database): Router {
  const router = Router();
  const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again later.' },
  });

  router.get('/api/setup/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ setupRequired: !queries.getAdmin() });
  });

  router.post('/api/setup', setupLimiter, csrf.doubleCsrfProtection, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (queries.getAdmin()) {
        queries.recordAudit('setup', false, 'already_exists');
        res.status(409).json({ error: 'Setup is already complete.' });
        return;
      }
      const body = (req.body ?? {}) as { password?: unknown; confirm?: unknown };
      const password = typeof body.password === 'string' ? body.password : '';
      const confirm = typeof body.confirm === 'string' ? body.confirm : '';
      if (password !== confirm) {
        res.status(400).json({ error: 'Passwords do not match.' });
        return;
      }
      const policy = validatePasswordPolicy(password);
      if (!policy.ok) {
        res.status(400).json({ error: policy.reason });
        return;
      }
      const passwordHash = await hashPassword(password);
      const nowIso = new Date().toISOString();

      // race-safe transactional creation of the single admin row
      const createTxn = getDb().transaction(() => {
        if (queries.getAdmin()) throw new Error('ALREADY_EXISTS');
        queries.createAdmin('admin', passwordHash, nowIso);
      });
      try {
        createTxn();
      } catch (err) {
        if (err instanceof Error && err.message === 'ALREADY_EXISTS') {
          queries.recordAudit('setup', false, 'already_exists');
          res.status(409).json({ error: 'Setup is already complete.' });
          return;
        }
        throw err;
      }
      queries.recordAudit('setup', true, 'created');

      const admin = queries.getAdmin();
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.adminId = 1;
        req.session.authVersion = admin?.auth_version ?? 1;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.status(201).json({ ok: true, username: 'admin' });
        });
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
