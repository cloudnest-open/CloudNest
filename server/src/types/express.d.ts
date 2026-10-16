import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by requirePrincipal/requireAdmin once the session gate passes. */
      principal?: import('../middleware/require-admin.js').Principal;
    }
  }
}
