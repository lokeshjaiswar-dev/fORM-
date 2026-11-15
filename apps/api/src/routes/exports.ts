import type { FastifyInstance } from 'fastify';
import type { Db } from '@form/db';
import type { Queue, Storage } from '@form/ports';

export interface ExportRouteDeps {
  /** The request pool: every read and write goes through `withTenant` on it, so row-level security limits it to the caller's org. */
  db: Db;
  /** The small separate pool for denied and failed audit records (ADR-0006). */
  auditDb: Db;
  /** Core's producer queue: a request sends `export.build` through it inside the transaction that inserts the export. */
  queue?: Queue | undefined;
  /** Keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
  /** Where the finished files are kept and streamed from (the composition root passes it once the exports are wired); without it the routes answer 503. */
  storage?: Storage | undefined;
}

/**
 * Submissions exports: `POST /v1/forms/:formId/exports` and `/v1/exports/:id` (WP-1.17). A stub until the exports task
 * fills it; it registers nothing yet, so every route it adds needs a case in `test/isolation-cases/exports.ts`.
 */
export function exportRoutes(_app: FastifyInstance, _deps: ExportRouteDeps): void {}
