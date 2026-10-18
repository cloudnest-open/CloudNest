import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyPassword, hashPassword, validatePasswordPolicy } from '../auth/password.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { makeLimiterKey } from '../middleware/limiter-key.js';
import { resolvePrincipal, ADMIN_USER_ID } from '../middleware/require-admin.js';
import type { UserService } from '../users/user-service.js';
import { UserError } from '../users/user-service.js';

/**
 * Authentication routes. Generic errors only — never reveal whether an admin
 * row or a user account exists, never echo a password, never log secrets.
 *
 * Roadmap Phase 3: two principal kinds share this router. The root admin keeps
 * signing in with the fixed username 'admin' (credentials in admin_users); a
 * users-table account signs in with its email. Both get server-side sessions
 * with the same rotation, CSRF, rate limit and audit treatment.
 */
export function authRouter(
  queries: Queries,
  csrf: CsrfBundle,
  /** BE-02: whether the Cloudflare tunnel is currently serving traffic. */
  tunnelRunning: () => boolean = () => false,
  /** Phase 3: invite/password-reset token claims. */
  users?: UserService,
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
  // token claims are pre-auth public writes: tightly limited like login
  const claimLimiter = rateLimit({
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
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (username.length === 0 || password.length === 0) {
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }

      // the built-in root admin keeps its dedicated credential row and path
      if (username === 'admin') {
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
          req.session.authVersion = admin!.auth_version;
          req.session.save((saveErr) => {
            if (saveErr) return next(saveErr);
            res.json({ ok: true, username: admin!.username });
          });
        });
        return;
      }

      // a users-table account signs in with its email
      const user = queries.getUserByEmail(username.toLowerCase());
      const ok =
        user !== undefined &&
        user.status === 'active' &&
        user.password_hash !== null &&
        (await verifyPassword(password, user.password_hash));
      if (!ok) {
        queries.recordAudit('login', false, user && user.status !== 'active' ? 'account_disabled' : 'invalid_credentials');
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }
      queries.recordAudit('login', true, 'success', { userId: user!.id });
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user!.id;
        req.session.userAuthVersion = user!.auth_version;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.json({ ok: true, username: user!.email });
        });
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const principal = resolvePrincipal(req, queries);
    if (!principal) {
      res.json({ authenticated: false });
      return;
    }
    if (principal.kind === 'admin') {
      const admin = queries.getAdmin();
      res.json({
        authenticated: true,
        kind: 'admin',
        role: 'admin',
        username: admin?.username ?? 'admin',
        displayName: admin?.username ?? 'admin',
        userId: ADMIN_USER_ID,
      });
      return;
    }
    const user = queries.getUser(principal.id);
    if (!user) {
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      kind: 'user',
      role: user.role,
      username: user.email,
      displayName: user.display_name,
      email: user.email,
      userId: user.id,
    });
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
      const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown; confirmNew?: unknown };
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const confirmNew = typeof body.confirmNew === 'string' ? body.confirmNew : '';
      if (newPassword !== confirmNew) {
        res.status(400).json({ error: 'New passwords do not match.' });
        return;
      }
      const session = req.session;
      const principal = resolvePrincipal(req, queries);
      if (!principal) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (principal.kind === 'admin') {
        const admin = queries.getAdmin();
        if (!admin) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const currentOk = await verifyPassword(currentPassword, admin.password_hash);
        if (!currentOk) {
          queries.recordAudit('password_change', false, 'wrong_current_password');
          res.status(401).json({ error: 'Current password is incorrect.' });
          return;
        }
        const policy = validatePasswordPolicy(newPassword);
        if (!policy.ok) {
          res.status(400).json({ error: policy.reason });
          return;
        }
        const newHash = await hashPassword(newPassword);
        const newAuthVersion = queries.updateAdminPassword(newHash, new Date().toISOString());
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
        return;
      }

      // a users-table principal changes their own password
      if (typeof session.userId !== 'string' || !users) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        await users.changeOwnPassword(session.userId, currentPassword, newPassword);
        const user = queries.getUser(session.userId)!;
        queries.recordAudit('password_change', true, 'success', { userId: user.id });
        req.session.regenerate((err) => {
          if (err) return next(err);
          req.session.userId = user.id;
          req.session.userAuthVersion = user.auth_version;
          req.session.save((saveErr) => {
            if (saveErr) return next(saveErr);
            res.json({ ok: true });
          });
        });
      } catch (err) {
        if (err instanceof UserError && err.safeCode === 'wrong_current_password') {
          queries.recordAudit('password_change', false, 'wrong_current_password');
          res.status(401).json({ error: 'Current password is incorrect.' });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // ---- Roadmap Phase 3: one-time invite / password-reset claim ----
  // The public half of the invite flow: the admin hands out a URL, its holder
  // sets the password here. One endpoint serves both token purposes — the
  // token itself says which. Pre-auth public write: CSRF + tight limiter,
  // exactly like login and setup.
  router.post('/api/auth/accept-invite', claimLimiter, csrf.doubleCsrfProtection, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!users) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const body = (req.body ?? {}) as { token?: unknown; password?: unknown; confirm?: unknown };
      const token = typeof body.token === 'string' ? body.token : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const confirm = typeof body.confirm === 'string' ? body.confirm : '';
      if (!token || password !== confirm) {
        res.status(400).json({ error: 'invalid_token', code: 'invalid_token' });
        return;
      }
      const claimed = await users.claimToken(token, password);
      queries.recordAudit('user_token_claimed', true, 'password_set');
      res.json({ ok: true, email: claimed.email });
    } catch (err) {
      if (err instanceof UserError) {
        // a failed claim is a pre-auth public write — audited like login
        queries.recordAudit('user_token_claimed', false, err.safeCode);
        res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
        return;
      }
      next(err);
    }
  });

  return router;
}
