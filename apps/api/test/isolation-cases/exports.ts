import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createFakeStorage } from '../fake-storage.ts';
import type { Fixture, IsolationCase, IsolationDomain, Res, SeedEnv } from './types.ts';

/**
 * Cases for the export routes (WP-1.17): asking for an export, reading its state and downloading it. Each is an
 * `auth: 'user'` route, so each needs a case here or the suite fails.
 *
 * Org A's export is a finished one, put in by the seed: a row inserted as the migrator (the worker's part, which the API
 * cannot play) and its file in `ISOLATION_STORAGE`, the object store the suite's app is built with. The request for an
 * export is not seeded through the API because the suite's app has no job queue; the request route is covered by
 * `exports.int.test.ts`, which does, and here by the one thing this suite is for: org B cannot reach org A's form.
 */

/** The object store of the suite's app (`isolation.int.test.ts` passes it to `buildApp`); the seed puts org A's file in it. */
export const ISOLATION_STORAGE = createFakeStorage();

/** What org A's file holds: a marker the suite also looks for in every answer to org B. */
export const EXPORT_MARKER = 'Org A private export 9d2e';

async function seed(env: SeedEnv, f: Fixture): Promise<Record<string, string>> {
  const id = randomUUID();
  const key = `${f.a.orgId}/${id}.csv`;
  await env.owner.query(
    `insert into exports (id, org_id, form_id, requested_by, format, scope, idempotency_key, status, row_count, object_key, bytes, finished_at, expires_at)
     values ($1, $2, $3, $4, 'csv', '{"kind":"all"}'::jsonb, 'iso-org-a-export', 'ready', 1, $5, $6, now(), now() + interval '2 hours')`,
    [id, f.a.orgId, f.a.formId, f.a.ownerId, key, Buffer.byteLength(EXPORT_MARKER)],
  );
  ISOLATION_STORAGE.seed('exports', key, EXPORT_MARKER);
  return { exportId: id, exportMarker: EXPORT_MARKER };
}

const bodyOf = (res: Res) => res.json<Record<string, unknown>>();

const cases: IsolationCase[] = [
  {
    route: 'POST /v1/forms/:formId/exports',
    call: (f) => ({
      url: `/v1/forms/${f.a.formId}/exports`,
      body: { format: 'xlsx', scope: { kind: 'all' }, includeSensitive: true, reason: 'org B asks for org A’s sensitive answers' },
      headers: { 'idempotency-key': 'iso-org-b-export-1' },
    }),
    note: 'A valid request with the Idempotency-Key it needs and the strongest options: org B’s owner has submissions.export, so only org A’s form not being visible stops it. The baseline check proves org A has no new export row, and the audit chain shows no submission.exported for it.',
  },
  {
    route: 'GET /v1/exports/:id',
    call: (f) => ({ url: `/v1/exports/${f.extra.exportId}` }),
    note: 'Org A’s own owner gets 200 for the same request (the suite checks it): a ready export. Org B must not learn that the id exists.',
  },
  {
    route: 'GET /v1/exports/:id/download',
    call: (f) => ({ url: `/v1/exports/${f.extra.exportId}/download` }),
    own: {
      status: 404,
      check: (res, f) => {
        expect(res.body).not.toContain(f.extra.exportMarker);
        expect(bodyOf(res).code).toBe('NOT_FOUND');
      },
    },
    note: 'Org A’s own owner gets the file (200, the suite checks it). Org B gets a 404 problem: no bytes, and no export.downloaded record in org A’s chain.',
  },
];

export const EXPORTS_ISOLATION: IsolationDomain = { cases, seed };
