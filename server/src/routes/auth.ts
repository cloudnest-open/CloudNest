import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyPassword, hashPassword, validatePasswordPolicy } from '../auth/password.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { makeLimiterKey } from '../middleware/limiter-key.js';

/**
 * Authentication routes. Generic errors only — never reveal whether an
 * admin row exists, never echo a password, never log secrets.
 */
export function authRouter(
  queries: Queries,
  csrf: CsrfBundle,
  /** BE-02: whether the Cloudflare tunnel is currently serving traffic. */
  tunnelRunning: () => boolean = () => false,
): Router {
  const router = Router();
  // BE-02: behind the tunnel every visitor shares one socket address, so the
  // login limiter keys on the verified CF client header instead.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: makeLimiterKey(tunnelRunning),
    message: { error: 'Too many attempts. Try again later.' },
  });

  router.get('/api/auth/csrf-token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = csrf.generateToken(req);
    res.json({ csrfToken: token });
  });

  router.post('/api/auth/login', loginLimiter, csrf.doubleCsrfProtection, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const admin = queries.getAdmin();
      const ok =
        admin !== undefined &&
        username === admin.username &&
        (await verifyPassword(password, admin.password_hash));
      if (!ok) {
        queries.recordAudit('login', false, 'invalid_credentials');
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }
      queries.recordAudit('login', true, 'success');
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.adminId = 1;
        req.session.authVersion = admin.auth_version;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.json({ ok: true, username: admin.username });
        });
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const admin = queries.getAdmin();
    const session = req.session;
    if (
      !session ||
      session.adminId !== 1 ||
      typeof session.authVersion !== 'number' ||
      !admin ||
      session.authVersion !== admin.auth_version
    ) {
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, username: admin.username });
  });

  router.post('/api/auth/logout', csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    req.session.destroy(() => {
      res.clearCookie('cloudnest.sid', { path: '/' });
      res.json({ ok: true });
    });
  });

  router.post('/api/auth/change-password', csrf.doubleCsrfProtection, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const admin = queries.getAdmin();
      const session = req.session;
      if (
        !session ||
        session.adminId !== 1 ||
        typeof session.authVersion !== 'number' ||
        !admin ||
        session.authVersion !== admin.auth_version
      ) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown; confirmNew?: unknown };
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const confirmNew = typeof body.confirmNew === 'string' ? body.confirmNew : '';
      const currentOk = await verifyPassword(currentPassword, admin.password_hash);
      if (!currentOk) {
        queries.recordAudit('password_change', false, 'wrong_current_password');
        res.status(401).json({ error: 'Current password is incorrect.' });
        return;
      }
      if (newPassword !== confirmNew) {
        res.status(400).json({ error: 'New passwords do not match.' });
        return;
      }
      const policy = validatePasswordPolicy(newPassword);
      if (!policy.ok) {
        res.status(400).json({ error: policy.reason });
        return;
      }
      const newHash = await hashPassword(newPassword);
      const nowIso = new Date().toISOString();
      const newAuthVersion = queries.updateAdminPassword(newHash, nowIso);
      queries.recordAudit('password_change', true, 'success');
      // invalidate all old sessions, then regenerate and re-authenticate this one
      queries.deleteAllSessions();
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.adminId = 1;
        req.session.authVersion = newAuthVersion;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.json({ ok: true });
        });
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
