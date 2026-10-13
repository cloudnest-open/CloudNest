import { csrfSync } from 'csrf-sync';

/**
 * Synchronizer-token CSRF protection via csrf-sync (csurf is archived; do not use).
 * The token is stored in the server-side session (state store), so it rotates
 * with the session ID automatically. The client sends it in X-CSRF-Token on
 * every unsafe request and must fetch a fresh token after setup/login/password
 * change (session regeneration clears the stored token).
 */
export function makeCsrf() {
  const { invalidCsrfTokenError, csrfSynchronisedProtection, generateToken } = csrfSync({
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    getTokenFromRequest: (req) => {
      const value = req.headers['x-csrf-token'];
      return (Array.isArray(value) ? value[0] : value) ?? '';
    },
  });
  return {
    doubleCsrfProtection: csrfSynchronisedProtection,
    generateToken,
    invalidCsrfTokenError,
  };
}

export type CsrfBundle = ReturnType<typeof makeCsrf>;
