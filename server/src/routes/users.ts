import { Router } from 'express';
import type { UserService, PublicUser } from '../users/user-service.js';
import { UserError } from '../users/user-service.js';
import type { Queries } from '../db/queries.js';
import type { CsrfBundle } from '../auth/csrf.js';
import { requireAdmin } from '../middleware/require-admin.js';
import type { SettingsService } from '../settings/settings-service.js';

/**
 * Users admin API (roadmap Phase 3 / §4.3). Every route is admin-only; the
 * invite/reset URLs are built from the configured public base URL when set,
 * otherwise the app's own base URL — never from the request's Host header.
 */
export function usersRouter(deps: {
  queries: Queries;
  csrf: CsrfBundle;
  users: UserService;
  appBaseUrl: string;
  settings?: SettingsService;
}): Router {
  const router = Router();
  const adminOnly = requireAdmin(deps.queries);

  function userError(res: import('express').Response, err: unknown): void {
    if (err instanceof UserError) {
      res.status(err.httpStatus).json({ error: err.safeCode, code: err.safeCode });
      return;
    }
    res.status(500).json({ error: 'user_operation_failed', code: 'user_operation_failed' });
  }

  /** Same origin rule as share links: configured public base wins, request Host never. */
  function baseUrl(req: import('express').Request): string {
    const registered = req.app.get('settings') as SettingsService | undefined;
    const settings = deps.settings ?? (typeof registered?.get === 'function' ? registered : null);
    return settings?.get('domain.publicBaseUrl') ?? deps.appBaseUrl;
  }

  router.get('/api/users', adminOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ users: deps.users.listUsers() });
  });

  router.post('/api/users', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const created = deps.users.inviteUser({
        email: typeof body['email'] === 'string' ? body['email'] : '',
        displayName: typeof body['displayName'] === 'string' ? body['displayName'] : '',
        role: body['role'] === 'admin' ? 'admin' : 'member',
        allowanceBytes: body['allowanceBytes'] === null || body['allowanceBytes'] === undefined
          ? null
          : Number(body['allowanceBytes']),
        baseUrl: baseUrl(req),
      });
      deps.queries.recordAudit('user_invited', true, 'created', { userId: created.user.id });
      // the accept URL is returned exactly once, here
      res.status(201).json({ user: created.user, acceptUrl: created.acceptUrl });
    } catch (err) {
      userError(res, err);
    }
  });

  router.patch('/api/users/:id', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const patch: Parameters<UserService['updateUser']>[1] = {};
      if (body['role'] === 'admin' || body['role'] === 'member') patch.role = body['role'];
      if (body['status'] === 'active' || body['status'] === 'disabled') patch.status = body['status'];
      if (body['allowanceBytes'] !== undefined) {
        patch.allowanceBytes = body['allowanceBytes'] === null ? null : Number(body['allowanceBytes']);
      }
      const user = deps.users.updateUser(String(req.params['id']), patch);
      res.json({ user });
    } catch (err) {
      userError(res, err);
    }
  });

  router.post('/api/users/:id/password-reset', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const issued = deps.users.startPasswordReset(String(req.params['id']), baseUrl(req));
      deps.queries.recordAudit('user_password_reset_issued', true, 'created', { userId: String(req.params['id']) });
      // the reset URL is returned exactly once, here
      res.json({ resetUrl: issued.resetUrl });
    } catch (err) {
      userError(res, err);
    }
  });

  router.delete('/api/users/:id', adminOnly, deps.csrf.doubleCsrfProtection, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      deps.users.deleteUser(String(req.params['id']));
      deps.queries.recordAudit('user_deleted', true, 'deleted', { userId: String(req.params['id']) });
      res.json({ ok: true });
    } catch (err) {
      userError(res, err);
    }
  });

  return router;
}

export type { PublicUser };
