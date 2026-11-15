import type { FastifyInstance } from 'fastify';
import type { Db } from '@form/db';
import type { ApiConfig } from '../config.ts';
import type { Throttle } from '../modules/auth/throttle.ts';

/** What the access routes will need; `app.ts` already passes all of it, so filling this module touches no shared file. */
export interface AccessRouteDeps {
  db: Db;
  /** The separate audit pool, for denied records written outside the business transaction. */
  auditDb: Db;
  config: ApiConfig;
  throttle: Throttle;
  now: () => Date;
}

/**
 * The builder's form-access routes (WP-1.07): open and close times, submission limit, redirect and embed allowlists and
 * the password. A stub until that work package: it registers nothing, and exists so `app.ts` does not change when it lands.
 * Every route added here is `auth: 'user'` and needs a case in `test/isolation-cases/access.ts`.
 */
export function accessRoutes(app: FastifyInstance, deps: AccessRouteDeps): void {
  void app;
  void deps;
}
