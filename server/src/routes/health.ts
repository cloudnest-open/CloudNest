import { Router } from 'express';

/**
 * GET /api/health — small, non-sensitive startup status.
 * No environment values, paths, or secrets are exposed.
 */
export function healthRouter(appVersion: string): Router {
  const router = Router();
  router.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok', version: appVersion });
  });
  return router;
}
