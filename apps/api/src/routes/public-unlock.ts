import type { FastifyInstance } from 'fastify';
import type { Db } from '@form/db';
import type { ApiConfig } from '../config.ts';
import type { Throttle } from '../modules/auth/throttle.ts';

/** What the unlock route will need; `app.ts` already passes all of it, so filling this module touches no shared file. */
export interface PublicUnlockDeps {
  db: Db;
  /** The separate audit pool, for denied records written outside the business transaction. */
  auditDb: Db;
  config: ApiConfig;
  throttle: Throttle;
  now: () => Date;
}

/**
 * The respondent's password unlock for a protected form, `POST /v1/p/:slug/unlock` (WP-1.07). A stub until that work
 * package: it registers nothing. The route will be public, with no session (a respondent has no account), so its commit must say
 * why, and it must be throttled per IP and form like the other public writes.
 */
export function publicUnlockRoutes(app: FastifyInstance, deps: PublicUnlockDeps): void {
  void app;
  void deps;
}
