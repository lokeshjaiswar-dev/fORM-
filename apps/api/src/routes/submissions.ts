import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db, ReadClient } from '@form/db';
import { z } from 'zod';
import { accountOf, clientInfo, memberOf, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import type { FileStore } from '../files.ts';
import { hex } from '../modules/auth/crypto.ts';
import { bulkAct } from '../submissions/bulk.ts';
import { readDetail, setFlags } from '../submissions/detail.ts';
import { listGrid, type GridFilters } from '../submissions/grid.ts';
import { createPlanLoader } from '../submissions/plans.ts';
import { createRedactionLoader } from '../submissions/review-view.ts';
import type { SearchIndexFactory } from '../submissions/search.ts';
import { bulkBody, bulkResponse, detailResponse, gridQuery, gridResponse, patchBody, patchResponse } from '../submissions/schemas.ts';

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const formParams = z.object({ formId: z.uuid() });
const submissionParams = z.object({ formId: z.uuid(), id: z.uuid() });

export interface SubmissionRouteDeps {
  db: Db;
  /** The respondent files' byte store: delete forever removes the bytes of the files a deleted response held. */
  files: FileStore;
  /** Signs the grid's cursors and keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  /** The deployment's search index (the composition root passes the Postgres adapter); without it `q` and `delete` answer 503. */
  searchIndex?: SearchIndexFactory | undefined;
  now: () => Date;
}

/**
 * The builder's responses API for a form of the active org (WP-1.15): the grid with the columns of every version of the
 * form, one response in full, the inbox flags, and bulk actions up to deleting forever. There is no route to create a
 * response: it comes from the published page (`POST /v1/p/:slug/submissions`), which validates it against the live version
 * and binds its files; the builder's preview keeps its rehearsal responses in the browser and sends nothing here.
 *
 * Every read is audited in the transaction that makes it (the grid page and the detail), so the reads are read-write
 * transactions; a write leaves its own record. Values of encrypted and sensitive fields never leave: they are masked.
 */
export function submissionRoutes(app: FastifyInstance, deps: SubmissionRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const plans = createPlanLoader();
  const redaction = createRedactionLoader();

  /** Where the request came from, for the audit records: the session and a keyed hash of the address, never the address. */
  const clientOf = (request: FastifyRequest): ReadClient => {
    const client = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(client.ipHash), actorUa: client.ua };
  };

  r.get(
    '/v1/forms/:formId/submissions',
    {
      config: { auth: 'user', perm: 'submissions.read' },
      schema: {
        tags: ['submissions'],
        summary: 'The responses grid of a form: columns of every version, filters, search, pages by cursor',
        description:
          'Columns are the union of the fields of every published version of the form, one per block id, labelled by the newest version. ' +
          'Cells are built on the server from the answers (the field type\'s own text); encrypted and sensitive fields are masked. ' +
          '`view` picks the inbox, the archive or the trash. `q` searches the non-sensitive answers of this form and orders by relevance. ' +
          '`nextCursor` is signed and bound to this exact query: pass it back unchanged for the next page, and stop when it is null; a page can hold fewer than `limit` rows while `nextCursor` is set (a search whose filters dropped hits). ' +
          '`status=pending_review` lists the responses held for review and `status=rejected` the ones a checker rejected; an item held for review carries its review units (name and state). ' +
          'A caller who reviews this form with `own_unit` visibility gets only the cells and columns of their own units, and `q` answers 403 `SEARCH_NOT_ALLOWED_FOR_REVIEWER`. ' +
          'The read is audited: one `submission.page_viewed` record per page with the ids shown.',
        security: SECURITY,
        params: formParams,
        querystring: gridQuery,
        response: { 200: gridResponse },
      },
    },
    async (request) => {
      const { formId } = request.params;
      const { limit, cursor, from, to, status, read, starred, view, q } = request.query;
      const filters: GridFilters = {
        view,
        status,
        read: read === undefined ? undefined : read === 'true',
        starred: starred === undefined ? undefined : starred === 'true',
        from: from === undefined ? undefined : new Date(from),
        to: to === undefined ? undefined : new Date(to),
        q: q || undefined,
      };
      return listGrid({ db: deps.db, secret: deps.secret, plans, searchIndex: deps.searchIndex, redaction }, tenantOf(request), clientOf(request), formId, filters, limit, cursor);
    },
  );

  r.get(
    '/v1/forms/:formId/submissions/:id',
    {
      config: { auth: 'user', perm: 'submissions.read' },
      schema: {
        tags: ['submissions'],
        summary: 'Read one response: its fields, answers, files and what the server recorded',
        description:
          'The fields are rebuilt from the answers and the version the response was received on. Encrypted and sensitive answers are masked. ' +
          'A caller who reviews this form with `own_unit` visibility gets the answers, fields and files of their own units only. `review`, present only on a response that was held for review, lists its review units (name and state). The read is audited (`submission.viewed`).',
        security: SECURITY,
        params: submissionParams,
        response: { 200: detailResponse },
      },
    },
    async (request) => {
      const { formId, id } = request.params;
      return readDetail({ db: deps.db, plans, now: deps.now, redaction }, tenantOf(request), clientOf(request), formId, id);
    },
  );

  r.patch(
    '/v1/forms/:formId/submissions/:id',
    {
      config: { auth: 'user', perm: 'submissions.edit' },
      schema: {
        tags: ['submissions'],
        summary: 'Mark a response read or unread, starred or not',
        description: 'A flag already at the asked value changes nothing and leaves no audit record.',
        security: SECURITY,
        params: submissionParams,
        body: patchBody,
        response: { 200: patchResponse },
      },
    },
    async (request) => {
      const { formId, id } = request.params;
      return setFlags({ db: deps.db, plans, now: deps.now, redaction }, tenantOf(request), clientOf(request), formId, id, request.body);
    },
  );

  r.post(
    '/v1/forms/:formId/submissions/bulk',
    {
      config: { auth: 'user', perm: 'submissions.edit' },
      schema: {
        tags: ['submissions'],
        summary: 'Act on up to 500 responses at once: read, star, archive, trash, restore, or delete forever',
        description:
          'All in one transaction. An id that is not a response of this form is counted as `missing` and touched by nothing; a response already in the asked state is `unchanged`. ' +
          '`delete` needs `submissions.delete` and refuses the whole call (409, nothing deleted) unless every response named is in the trash and free of holds; it removes the rows, their search documents, the records of the files they held and the file bytes.',
        security: SECURITY,
        params: formParams,
        body: bulkBody,
        response: { 200: bulkResponse },
      },
    },
    async (request) => {
      const { formId } = request.params;
      const tenant = tenantOf(request);
      const { action } = request.body;
      if (action === 'delete' && !memberOf(request).perms.includes('submissions.delete')) {
        // The route's own check covers `submissions.edit`; deleting forever is its own permission, and the refusal is audited like any other.
        throw new ProblemError('FORBIDDEN', 'Requires submissions.delete.', { orgId: tenant.orgId, actorId: tenant.userId ?? null, reason: 'missing_permission:submissions.delete' });
      }
      return bulkAct({ db: deps.db, files: deps.files, searchIndex: deps.searchIndex, now: deps.now }, tenant, clientOf(request), formId, request.body);
    },
  );
}
