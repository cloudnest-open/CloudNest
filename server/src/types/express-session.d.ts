import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminId?: number;
    authVersion?: number;
    /** Roadmap Phase 3: a users-table principal (id + its auth_version). */
    userId?: string;
    userAuthVersion?: number;
  }
}
