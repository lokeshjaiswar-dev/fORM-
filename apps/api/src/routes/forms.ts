import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, auditActor, FORM_LIFECYCLES, formDrafts, formFavourites, forms, isUuid, withTenant, type Db, type FormLifecycle, type Tx } from '@form/db';
import { FormDefinitionSchema, mergeForms, type FormDefinition, type MergeFormInput } from '@form/schema';
import { z } from 'zod';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { MAX_CURSOR_LENGTH, readCursor, signCursor } from '../cursor.ts';
import { PROBLEM_CONTENT_TYPE, problemOf, ProblemError, sendProblem, type FieldIssue } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { uuidv7 } from '../uuid7.ts';
import { importBody, importNote, importV1Form, type AuditClient } from './forms-import.ts';

const isoInstant = z.iso.datetime({ offset: true });

export const formSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  lifecycle: z.enum(FORM_LIFECYCLES),
  teamId: z.uuid(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
  /** Whether the signed-in member starred the form; stars are personal, a colleague's are never visible. */
  favourite: z.boolean(),
  /** From the counter the submit transaction keeps, not counted here. */
  submissionCount: z.number().int().min(0),
  /** An active form with a published version: its public link opens. */
  isLive: z.boolean(),
});

/**
 * What each `sort` orders by. `expr` is the sort key as SQL, `cast` the type the key is compared as, and `dir` the
 * direction a list takes when the request names none (newest and busiest first, titles A to Z). The key travels in the
 * cursor as text (`(expr)::text`), so a timestamp keeps its microseconds, which a JavaScript Date would round.
 */
const SORTS = {
  updated: { expr: sql`forms.updated_at`, cast: 'timestamptz', dir: 'desc' },
  created: { expr: sql`forms.created_at`, cast: 'timestamptz', dir: 'desc' },
  title: { expr: sql`lower(forms.title)`, cast: 'text', dir: 'asc' },
  submissions: { expr: sql`forms.submission_count`, cast: 'bigint', dir: 'desc' },
} as const;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  lifecycle: z.enum(FORM_LIFECYCLES).default('active'),
  /** Words in the title, in any case (ILIKE, served by the `forms_title_trgm` index). */
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['updated', 'created', 'title', 'submissions']).default('updated'),
  dir: z.enum(['asc', 'desc']).optional(),
  /** Only the forms the caller starred. Only `true` is a filter: leave the parameter out for all forms. */
  favourite: z.literal('true').optional(),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const idParams = z.object({ id: z.uuid() });
const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const MAX_DRAFT_BYTES = 5_242_880;
const MAX_TITLE = 500;

/** `LIKE` treats `%`, `_` and `\` in the search words as wildcards unless escaped. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, '\\$&');
/** A strong entity tag: the draft revision in quotes (RFC 9110). */
const etagOf = (rev: number) => `"${rev}"`;

/**
 * The revision in an `If-Match` header: `"3"`, `W/"3"` or `3`. `0` means "the form has no draft yet". A write that does
 * not say what it read would overwrite a newer save from another tab without a word, so a missing header is refused.
 */
function expectedDraftRev(header: string | undefined): number {
  if (header === undefined) {
    throw new ProblemError('PRECONDITION_REQUIRED', 'Send If-Match with the draftRev you last read ("0" for a form that has no draft yet).');
  }
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (!m) throw new ProblemError('BAD_REQUEST', 'If-Match must be the draftRev from your last read, such as "3".');
  return Number(m[1]);
}

/** The columns of a form row the list and the single-form routes return, for the caller's own stars. */
const summaryColumns = (userId: string) => ({
  id: forms.id,
  title: forms.title,
  lifecycle: forms.lifecycle,
  teamId: forms.teamId,
  createdAt: forms.createdAt,
  updatedAt: forms.updatedAt,
  submissionCount: forms.submissionCount,
  favourite: sql<boolean>`exists (select 1 from form_favourites f where f.form_id = forms.id and f.user_id = ${userId}::uuid)`,
  isLive: sql<boolean>`(forms.live_version_id is not null and forms.lifecycle = 'active')`,
});

type SummaryRow = {
  id: string;
  title: string;
  lifecycle: FormLifecycle;
  teamId: string;
  createdAt: Date;
  updatedAt: Date;
  submissionCount: number;
  favourite: boolean;
  isLive: boolean;
};

const toSummary = (row: SummaryRow): z.infer<typeof formSummary> => ({
  id: row.id,
  title: row.title,
  lifecycle: row.lifecycle,
  teamId: row.teamId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  favourite: row.favourite,
  submissionCount: row.submissionCount,
  isLive: row.isLive,
});

/** One form of the caller's org (row-level security decides), or a 404 that is the same for "not yours" and "not there". */
async function loadSummary(tx: Tx, userId: string, id: string): Promise<z.infer<typeof formSummary>> {
  const rows = await tx.select(summaryColumns(userId)).from(forms).where(eq(forms.id, id)).limit(1);
  if (!rows[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
  return toSummary(rows[0]);
}

/** The first few problems of a draft the strict twin refused, as field issues (paths are JSON pointers). */
function issuesOf(error: z.ZodError): FieldIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: `/${issue.path.map(String).join('/')}`.replace(/\/$/, '') || '/', message: issue.message }));
}

/** What a lifecycle verb does: the states it may start from and the one it ends in. */
const TRANSITIONS = {
  archive: { from: ['active'], to: 'archived' },
  trash: { from: ['active', 'archived'], to: 'trashed' },
  restore: { from: ['archived', 'trashed'], to: 'active' },
} as const satisfies Record<string, { from: readonly FormLifecycle[]; to: FormLifecycle }>;

/**
 * Moves a form to the state `verb` ends in, under a row lock, so two clicks race to one answer. A form already in that
 * state is left as it is (`changed: false`: a retry is safe and writes no second audit record); a form in a state the
 * verb may not start from is refused. Trash is not delete: the row and everything under it stay (hard delete waits for
 * the legal-hold work, WP-1.22).
 */
async function moveForm(tx: Tx, userId: string, id: string, verb: keyof typeof TRANSITIONS, now: Date): Promise<{ from: FormLifecycle; changed: boolean }> {
  const rule = TRANSITIONS[verb];
  const rows = await tx.select({ lifecycle: forms.lifecycle }).from(forms).where(eq(forms.id, id)).limit(1).for('update');
  const current = rows[0]?.lifecycle;
  if (!current) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
  if (current === rule.to) return { from: current, changed: false };
  if (!(rule.from as readonly FormLifecycle[]).includes(current)) {
    throw new ProblemError('FORM_STATE_CONFLICT', `A form that is ${current} cannot be ${verb === 'archive' ? 'archived' : verb === 'trash' ? 'moved to the trash' : 'restored'}.`);
  }
  await tx
    .update(forms)
    .set({ lifecycle: rule.to, trashedAt: rule.to === 'trashed' ? now : null, updatedAt: now, updatedBy: userId })
    .where(eq(forms.id, id));
  return { from: current, changed: true };
}

export interface FormRouteDeps {
  db: Db;
  /** Signs list cursors and keys the IP hash of audit records (`config.auth.secret`). */
  secret: Uint8Array;
  now: () => Date;
}

const conflictBody = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  code: z.literal('DRAFT_REV_CONFLICT'),
  detail: z.string().optional(),
  instance: z.string(),
  requestId: z.string(),
  /** The server's draft, so the builder can offer a merge instead of a bare "reload". Null only when the form has no draft. */
  draftRev: z.number().int(),
  updatedAt: isoInstant,
  updatedBy: z.uuid().nullable(),
  draft: z.record(z.string(), z.unknown()).nullable(),
});

const createBody = z.strictObject({ id: z.uuid().optional(), title: z.string().max(200).default('') });

/** The forms routes: the list, one form, its draft, lifecycle, stars, clone, merge and v1 import (WP-1.06). */
export function formRoutes(app: FastifyInstance, deps: FormRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const auditClient = (request: FastifyRequest): AuditClient => {
    const client = clientInfo(request, deps.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(client.ipHash), actorUa: client.ua };
  };

  r.get(
    '/v1/forms',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'List forms in the active org: search, sort, favourites, pages by cursor',
        description:
          'The query names no org; the database returns only the caller\'s (row-level security). `nextCursor` is signed and bound to this exact query (sort, filters and caller): pass it back unchanged for the next page, and stop when it is null.',
        security: SECURITY,
        querystring: listQuery,
        response: { 200: z.object({ items: z.array(formSummary), nextCursor: z.string().nullable() }) },
      },
    },
    async (request) => {
      const { limit, lifecycle, q, sort, favourite, cursor } = request.query;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const spec = SORTS[sort];
      const dir = request.query.dir ?? spec.dir;
      // The signature covers everything that changes which rows come in which order, so a cursor cannot be carried to
      // another query, another member (stars are personal) or another org.
      const scope = JSON.stringify(['forms', tenant.orgId, userId, sort, dir, lifecycle, q ?? null, favourite === 'true']);
      let after: [string, string] | undefined;
      if (cursor !== undefined) {
        const values = readCursor(deps.secret, scope, cursor);
        const [key, id] = values ?? [];
        if (values?.length !== 2 || typeof key !== 'string' || !isUuid(id)) throw new ProblemError('INVALID_CURSOR');
        after = [key, id];
      }

      const rows = await withTenant(deps.db, { ...tenant, readOnly: true }, (tx) =>
        tx
          .select({ ...summaryColumns(userId), sortKey: sql<string>`(${spec.expr})::text` })
          .from(forms)
          .where(
            and(
              eq(forms.lifecycle, lifecycle),
              q ? ilike(forms.title, `%${likeEscape(q)}%`) : undefined,
              favourite
                ? sql`exists (select 1 from form_favourites f where f.form_id = forms.id and f.user_id = ${userId}::uuid)`
                : undefined,
              // The row after the cursor in the list's own order. A row comparison reads (key, id) as one position.
              after
                ? sql`(${spec.expr}, forms.id) ${sql.raw(dir === 'desc' ? '<' : '>')} (${after[0]}::${sql.raw(spec.cast)}, ${after[1]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(dir === 'desc' ? desc(spec.expr) : asc(spec.expr), dir === 'desc' ? desc(forms.id) : asc(forms.id))
          // One row more than the page, to know whether there is a next page without a count.
          .limit(limit + 1),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toSummary),
        nextCursor: rows.length > limit && last ? signCursor(deps.secret, scope, [last.sortKey, last.id]) : null,
      };
    },
  );

  r.post(
    '/v1/forms',
    {
      config: { auth: 'user', perm: 'forms.create' },
      schema: {
        tags: ['forms'],
        summary: 'Create a form row in the active org (id may already exist), or import a v1 form',
        description:
          'Without `from`: creates an empty form row; a client-chosen id that already exists changes nothing, so a retry is safe. With `from: "importV1"`: the v1 form is migrated on the server and stored as a v2 draft; a v1 password is hashed (argon2id) into the form\'s access settings in the same transaction and is never stored in the draft; the answer carries the migration notes.',
        security: SECURITY,
        body: z.union([importBody, createBody]),
        response: {
          200: z.object({
            id: z.uuid(),
            notes: z.array(importNote).optional(),
            enabled: z.boolean().optional(),
            hasPassword: z.boolean().optional(),
          }),
        },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const body = request.body;
      if ('from' in body) return importV1Form(deps, tenant, userId, auditClient(request), body);
      const id = body.id ?? randomUUID();
      const title = body.title.trim() || 'Untitled form';
      await withTenant(deps.db, tenant, async (tx) => {
        await tx
          .insert(forms)
          .values({ id, orgId: tenant.orgId, teamId: tenant.orgId, ownerUserId: userId, title })
          .onConflictDoNothing({ target: forms.id });
      });
      return { id };
    },
  );

  r.get(
    '/v1/forms/:id',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'Read one form row of the active org',
        security: SECURITY,
        params: idParams,
        response: { 200: formSummary },
      },
    },
    async (request) => {
      const userId = accountOf(request).userId;
      return withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) => loadSummary(tx, userId, request.params.id));
    },
  );

  r.patch(
    '/v1/forms/:id',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: ['forms'],
        summary: 'Rename a form',
        description:
          'The title also lives in the draft, so a rename changes the draft too and bumps its `draftRev`: a builder open on the old revision gets a 409 with the renamed draft on its next save rather than silently renaming the form back.',
        security: SECURITY,
        params: idParams,
        body: z.strictObject({ title: z.string().trim().min(1).max(MAX_TITLE) }),
        response: { 200: formSummary },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { title } = request.body;
      const userId = accountOf(request).userId;
      return withTenant(deps.db, tenantOf(request), async (tx) => {
        const now = deps.now();
        const renamed = await tx.update(forms).set({ title, updatedAt: now, updatedBy: userId }).where(eq(forms.id, id)).returning({ id: forms.id });
        if (!renamed[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const drafts = await tx
          .select({ draft: formDrafts.draft, draftRev: formDrafts.draftRev })
          .from(formDrafts)
          .where(eq(formDrafts.formId, id))
          .limit(1)
          .for('update');
        const current = drafts[0];
        if (current) {
          const draft = { ...current.draft, title };
          await tx
            .update(formDrafts)
            .set({ draft, draftRev: current.draftRev + 1, sizeBytes: Buffer.byteLength(JSON.stringify(draft), 'utf8'), updatedBy: userId, updatedAt: now })
            .where(eq(formDrafts.formId, id));
        }
        return loadSummary(tx, userId, id);
      });
    },
  );

  for (const verb of ['PUT', 'DELETE'] as const) {
    const star = verb === 'PUT';
    r.route({
      method: verb,
      url: '/v1/forms/:id/favourite',
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: star ? 'Star a form for the signed-in member' : 'Remove the signed-in member\'s star from a form',
        description: 'Stars are personal: no other member, whatever their role, sees or changes them. Repeating the call changes nothing.',
        security: SECURITY,
        params: idParams,
        response: { 200: z.object({ favourite: z.boolean() }) },
      },
      handler: async (request) => {
        const { id } = request.params;
        const tenant = tenantOf(request);
        const userId = accountOf(request).userId;
        await withTenant(deps.db, tenant, async (tx) => {
          // Through row-level security first: a form of another org is a 404 here, not a foreign-key error.
          const found = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, id)).limit(1);
          if (!found[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
          if (star) {
            await tx.insert(formFavourites).values({ formId: id, userId, orgId: tenant.orgId }).onConflictDoNothing();
          } else {
            await tx.delete(formFavourites).where(and(eq(formFavourites.formId, id), eq(formFavourites.userId, userId)));
          }
        });
        return { favourite: star };
      },
    });
  }

  r.post(
    '/v1/forms/:id/clone',
    {
      config: { auth: 'user', perm: 'forms.create' },
      schema: {
        tags: ['forms'],
        summary: 'Copy a form as a new draft titled "Copy of …"',
        description:
          'The copy gets a new server-made id and its own draft (revision 1) with the same definition under that id. Access settings, slugs, the published version and submissions are not copied: the copy is unpublished and open with the defaults.',
        security: SECURITY,
        params: idParams,
        response: { 201: formSummary },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const client = auditClient(request);
      const copy = await withTenant(deps.db, tenant, async (tx) => {
        const sources = await tx
          .select({ title: forms.title, teamId: forms.teamId, templateOrigin: forms.templateOrigin, brandKitId: forms.brandKitId })
          .from(forms)
          .where(eq(forms.id, id))
          .limit(1);
        const source = sources[0];
        if (!source) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const drafts = await tx.select({ draft: formDrafts.draft }).from(formDrafts).where(eq(formDrafts.formId, id)).limit(1);

        const newId = uuidv7();
        const now = deps.now();
        const title = `Copy of ${source.title}`.slice(0, MAX_TITLE);
        await tx.insert(forms).values({
          id: newId,
          orgId: tenant.orgId,
          teamId: source.teamId,
          ownerUserId: userId,
          title,
          templateOrigin: source.templateOrigin,
          brandKitId: source.brandKitId,
          updatedAt: now,
          updatedBy: userId,
        });
        const original = drafts[0];
        if (original) {
          const draft = { ...original.draft, formId: newId, title };
          await tx.insert(formDrafts).values({
            formId: newId,
            orgId: tenant.orgId,
            draft,
            draftRev: 1,
            schemaVersion: 2,
            sizeBytes: Buffer.byteLength(JSON.stringify(draft), 'utf8'),
            updatedBy: userId,
            updatedAt: now,
          });
        }
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: client.sessionId,
          actorIpHash: client.actorIpHash,
          actorUa: client.actorUa,
          action: 'form.cloned',
          resourceType: 'form',
          resourceId: newId,
          formId: newId,
          outcome: 'success',
          metadata: { sourceFormId: id, hadDraft: original !== undefined },
        });
        return loadSummary(tx, userId, newId);
      });
      return reply.code(201).send(copy);
    },
  );

  const lifecycleSchema = (summary: string, description: string) => ({
    tags: ['forms'],
    summary,
    description,
    security: SECURITY,
    params: idParams,
    response: { 200: formSummary },
  });

  r.post(
    '/v1/forms/:id/archive',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: lifecycleSchema('Archive a form', 'Active forms only; archiving an archived form is a no-op, a trashed form is a 409. An archived form\'s public link stops resolving.'),
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const client = auditClient(request);
      return withTenant(deps.db, tenant, async (tx) => {
        const moved = await moveForm(tx, userId, id, 'archive', deps.now());
        if (moved.changed) {
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: client.sessionId,
            actorIpHash: client.actorIpHash,
            actorUa: client.actorUa,
            action: 'form.archived',
            resourceType: 'form',
            resourceId: id,
            formId: id,
            outcome: 'success',
            metadata: { from: moved.from, to: 'archived' },
          });
        }
        return loadSummary(tx, userId, id);
      });
    },
  );

  r.post(
    '/v1/forms/:id/trash',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: lifecycleSchema('Move a form to the trash', 'Active and archived forms; the form is hidden and its public link stops resolving, and it is restorable. Nothing is deleted.'),
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const client = auditClient(request);
      return withTenant(deps.db, tenant, async (tx) => {
        const moved = await moveForm(tx, userId, id, 'trash', deps.now());
        if (moved.changed) {
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: client.sessionId,
            actorIpHash: client.actorIpHash,
            actorUa: client.actorUa,
            action: 'form.trashed',
            resourceType: 'form',
            resourceId: id,
            formId: id,
            outcome: 'success',
            metadata: { from: moved.from, to: 'trashed' },
          });
        }
        return loadSummary(tx, userId, id);
      });
    },
  );

  r.post(
    '/v1/forms/:id/restore',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: lifecycleSchema('Restore an archived or trashed form', 'Makes the form active again; a form that is already active is a no-op.'),
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const client = auditClient(request);
      return withTenant(deps.db, tenant, async (tx) => {
        const moved = await moveForm(tx, userId, id, 'restore', deps.now());
        if (moved.changed) {
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: client.sessionId,
            actorIpHash: client.actorIpHash,
            actorUa: client.actorUa,
            action: 'form.restored',
            resourceType: 'form',
            resourceId: id,
            formId: id,
            outcome: 'success',
            metadata: { from: moved.from, to: 'active' },
          });
        }
        return loadSummary(tx, userId, id);
      });
    },
  );

  r.get(
    '/v1/forms/:id/draft',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'Read the v2 draft for a form in the active org',
        description: 'The `ETag` header is the draft revision in quotes (the same number as `draftRev`); send it back as `If-Match` on the next PUT.',
        security: SECURITY,
        params: idParams,
        response: {
          200: z.object({
            draftRev: z.number().int(),
            schemaVersion: z.number().int(),
            draft: z.record(z.string(), z.unknown()),
            updatedAt: isoInstant,
            updatedBy: z.uuid(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select({
            draft: formDrafts.draft,
            draftRev: formDrafts.draftRev,
            schemaVersion: formDrafts.schemaVersion,
            updatedAt: formDrafts.updatedAt,
            updatedBy: formDrafts.updatedBy,
          })
          .from(formDrafts)
          .where(eq(formDrafts.formId, id))
          .limit(1),
      );
      const row = rows[0];
      if (!row) throw new ProblemError('NOT_FOUND', 'That form has no draft in this organisation.');
      reply.header('etag', etagOf(row.draftRev)).header('cache-control', 'private, no-store');
      return { ...row, updatedAt: row.updatedAt.toISOString() };
    },
  );

  r.put(
    '/v1/forms/:id/draft',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: ['forms'],
        summary: 'Save the v2 form definition as the org draft (compare-and-swap on If-Match)',
        description:
          'Needs `If-Match: <draftRev from your last read>` (`0` for a form with no draft yet): 428 without it. The body is parsed with the strict definition schema, so an unknown key (for example `settings.password`) is a 422, not stored. When the draft moved on, the answer is a 409 `DRAFT_REV_CONFLICT` carrying the server\'s `draft`, `draftRev`, `updatedAt` and `updatedBy`; nothing is written. Ops and plaintext passwords are never part of a draft.',
        security: SECURITY,
        params: idParams,
        // Loose on purpose: the draft is parsed in the handler so a bad one is a 422 with paths, and a request that
        // reaches the handler has passed the permission check (body validation runs before it).
        body: z.object({ draft: z.unknown() }),
        response: { 200: z.object({ draftRev: z.number().int(), updatedAt: isoInstant }), 409: conflictBody },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const expectedRev = expectedDraftRev(request.headers['if-match']);

      const parsed = FormDefinitionSchema.safeParse(request.body.draft);
      if (!parsed.success) return sendProblem(reply, 'DRAFT_INVALID', 'The draft is not a valid v2 form definition.', issuesOf(parsed.error));
      // The address names the form; a draft that says it is another form's would be published under the wrong id.
      if (parsed.data.formId !== id) {
        return sendProblem(reply, 'DRAFT_INVALID', 'The draft names a different form than the address.', [{ path: '/formId', message: 'must equal the form id in the address' }]);
      }
      const draft = parsed.data as unknown as Record<string, unknown>;
      const sizeBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
      if (sizeBytes > MAX_DRAFT_BYTES) throw new ProblemError('PAYLOAD_TOO_LARGE', 'The draft is larger than 5 MB.');
      const title = parsed.data.title.trim() || 'Untitled form';

      const outcome = await withTenant(deps.db, tenant, async (tx) => {
        const found = await tx.select({ updatedAt: forms.updatedAt, updatedBy: forms.updatedBy }).from(forms).where(eq(forms.id, id)).limit(1);
        const form = found[0];
        if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const now = deps.now();

        // One statement decides: the write happens only if the revision is still the one the client read, so two saves
        // from the same revision cannot both win (the second waits for the first's row lock, then finds the revision moved).
        const written =
          expectedRev === 0
            ? await tx
                .insert(formDrafts)
                .values({ formId: id, orgId: tenant.orgId, draft, draftRev: 1, schemaVersion: 2, sizeBytes, updatedBy: userId, updatedAt: now })
                .onConflictDoNothing({ target: formDrafts.formId })
                .returning({ draftRev: formDrafts.draftRev, updatedAt: formDrafts.updatedAt })
            : await tx
                .update(formDrafts)
                .set({ draft, draftRev: sql`${formDrafts.draftRev} + 1`, schemaVersion: 2, sizeBytes, updatedBy: userId, updatedAt: now })
                .where(and(eq(formDrafts.formId, id), eq(formDrafts.draftRev, expectedRev)))
                .returning({ draftRev: formDrafts.draftRev, updatedAt: formDrafts.updatedAt });
        const saved = written[0];
        if (saved) {
          await tx.update(forms).set({ title, updatedAt: now, updatedBy: userId }).where(eq(forms.id, id));
          return { saved };
        }
        const current = await tx
          .select({ draft: formDrafts.draft, draftRev: formDrafts.draftRev, updatedAt: formDrafts.updatedAt, updatedBy: formDrafts.updatedBy })
          .from(formDrafts)
          .where(eq(formDrafts.formId, id))
          .limit(1);
        // A form with no draft yet, written against a revision that never existed: its row is the server's state.
        return { conflict: current[0] ?? { draft: null, draftRev: 0, updatedAt: form.updatedAt, updatedBy: form.updatedBy } };
      });

      if ('conflict' in outcome) {
        const { conflict } = outcome;
        return reply
          .code(409)
          .type(PROBLEM_CONTENT_TYPE)
          .header('etag', etagOf(conflict.draftRev))
          .send({
            ...problemOf(request, 'DRAFT_REV_CONFLICT', 'The draft changed since you read it. Merge the changes below, then save again from this revision.'),
            status: 409 as const,
            code: 'DRAFT_REV_CONFLICT' as const,
            draftRev: conflict.draftRev,
            updatedAt: conflict.updatedAt.toISOString(),
            updatedBy: conflict.updatedBy,
            draft: conflict.draft,
          });
      }
      reply.header('etag', etagOf(outcome.saved.draftRev));
      return { draftRev: outcome.saved.draftRev, updatedAt: outcome.saved.updatedAt.toISOString() };
    },
  );

  const mergeSide = z.object({
    formId: z.string(),
    formTitle: z.string(),
    blockId: z.string(),
    summary: z.string(),
  });
  const mergeConflict = z.object({
    label: z.string(),
    type: z.string(),
    reason: z.string(),
    message: z.string(),
    sides: z.array(mergeSide),
  });
  const mergeResolution = z.object({
    label: z.string().min(1),
    type: z.string().min(1),
    chosenFormId: z.uuid(),
  });

  r.post(
    '/v1/forms/merge',
    {
      config: { auth: 'user', perm: 'forms.create' },
      schema: {
        tags: ['forms'],
        summary: 'Merge selected forms into a new form (match on label + type)',
        security: SECURITY,
        body: z.object({
          formIds: z.array(z.uuid()).min(2).max(20),
          title: z.string().max(200).optional(),
          resolutions: z.array(mergeResolution).max(200).optional(),
        }),
        response: {
          200: z.object({ id: z.uuid() }),
          409: z.object({ status: z.literal('conflict'), conflicts: z.array(mergeConflict) }),
        },
      },
    },
    async (request, reply) => {
      const ids = [...new Set(request.body.formIds)];
      if (ids.length < 2) throw new ProblemError('VALIDATION_FAILED', 'Select at least two different forms.');
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;

      const loaded = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        const rows = await tx
          .select({ id: forms.id, title: forms.title, draft: formDrafts.draft })
          .from(forms)
          .innerJoin(formDrafts, eq(formDrafts.formId, forms.id))
          .where(inArray(forms.id, ids));
        return rows;
      });

      const byId = new Map(loaded.map((row) => [row.id, row]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw new ProblemError('NOT_FOUND', 'One of the selected forms has no draft in this organisation.');

      const inputs: MergeFormInput[] = [];
      for (const id of request.body.formIds) {
        if (inputs.some((item) => item.id === id)) continue;
        const row = byId.get(id);
        if (!row) continue;
        const parsed = FormDefinitionSchema.safeParse(row.draft);
        if (!parsed.success) throw new ProblemError('VALIDATION_FAILED', `The draft for “${row.title}” cannot be merged.`);
        inputs.push({ id: row.id, title: row.title, definition: parsed.data as FormDefinition });
      }

      const merged = mergeForms(inputs, {
        newFormId: randomUUID(),
        ...(request.body.title !== undefined ? { title: request.body.title } : {}),
        ...(request.body.resolutions !== undefined ? { resolutions: request.body.resolutions } : {}),
        newId: () => randomUUID(),
      });
      if (!merged.ok) {
        return reply.code(409).send({ status: 'conflict' as const, conflicts: merged.conflicts });
      }

      const id = merged.definition.formId;
      const draft = merged.definition as unknown as Record<string, unknown>;
      const sizeBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
      if (sizeBytes > MAX_DRAFT_BYTES) throw new ProblemError('PAYLOAD_TOO_LARGE', 'The merged form is larger than 5 MB.');
      const title = merged.definition.title.trim() || 'Untitled form';
      const now = new Date();

      await withTenant(deps.db, tenant, async (tx) => {
        await tx.insert(forms).values({
          id,
          orgId: tenant.orgId,
          teamId: tenant.orgId,
          ownerUserId: userId,
          title,
          updatedAt: now,
          updatedBy: userId,
        });
        await tx.insert(formDrafts).values({
          formId: id,
          orgId: tenant.orgId,
          draft,
          draftRev: 1,
          schemaVersion: 2,
          sizeBytes,
          updatedBy: userId,
          updatedAt: now,
        });
      });
      return { id };
    },
  );
}
