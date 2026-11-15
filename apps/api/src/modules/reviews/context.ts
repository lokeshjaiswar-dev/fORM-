import type { Db } from '@form/db';
import type { KeyProvider, Queue } from '@form/ports';

/**
 * What the approvals routes get from the composition root (`app.ts`). Kept apart from `index.ts` so each route file can
 * import the type without a cycle through the module that registers it (the pattern of `modules/orgs/context.ts`).
 */
export interface ReviewModuleDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Core's producer queue (the composition root makes it); without it no job is sent, which only tests do. */
  queue?: Queue | undefined;
  keys?: KeyProvider | undefined;
  /** Keys the IP hash of audit records and signs cursors (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
}
