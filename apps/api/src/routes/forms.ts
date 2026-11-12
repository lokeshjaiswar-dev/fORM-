import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { FORM_LIFECYCLES, formDrafts, forms, withTenant, type Db } from '@form/db';
import { FormDefinitionSchema, mergeForms, type FormDefinition, type MergeFormInput } from '@form/schema';
import { z } from 'zod';
import { accountOf, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';

export const formSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  lifecycle: z.enum(FORM_LIFECYCLES),
  teamId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  lifecycle: z.enum(FORM_LIFECYCLES).default('active'),
});

/** `GET /v1/forms`: the RLS demonstration. The query names no org; the database returns only the caller's. */
export function formRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/forms',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'List forms in the active org',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        querystring: listQuery,
        response: { 200: z.object({ items: z.array(formSummary) }) },
      },
    },
    async (request) => {
      const { limit, lifecycle } = request.query;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select({ id: forms.id, title: forms.title, lifecycle: forms.lifecycle, teamId: forms.teamId, updatedAt: forms.updatedAt })
          .from(forms)
          .where(eq(forms.lifecycle, lifecycle))
          .orderBy(desc(forms.updatedAt), desc(forms.id))
          .limit(limit),
      );
      return { items: rows.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() })) };
    },
  );

  r.post(
    '/v1/forms',
    {
      config: { auth: 'user', perm: 'forms.create' },
      schema: {
        tags: ['forms'],
        summary: 'Create a form row in the active org (id may already exist)',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        body: z.object({ id: z.uuid().optional(), title: z.string().max(200).default('') }),
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const id = request.body.id ?? randomUUID();
      const title = request.body.title.trim() || 'Untitled form';
      await withTenant(deps.db, tenant, async (tx) => {
        await tx
          .insert(forms)
          .values({ id, orgId: tenant.orgId, teamId: tenant.orgId, ownerUserId: accountOf(request).userId, title })
          .onConflictDoNothing({ target: forms.id });
      });
      return { id };
    },
  );

  r.get(
    '/v1/forms/:id/draft',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'Read the v2 draft for a form in the active org',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({
            draftRev: z.number().int(),
            schemaVersion: z.number().int(),
            draft: z.record(z.string(), z.unknown()),
            updatedAt: z.iso.datetime({ offset: true }),
          }),
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select({
            draft: formDrafts.draft,
            draftRev: formDrafts.draftRev,
            schemaVersion: formDrafts.schemaVersion,
            updatedAt: formDrafts.updatedAt,
          })
          .from(formDrafts)
          .where(eq(formDrafts.formId, id))
          .limit(1),
      );
      const row = rows[0];
      if (!row) throw new ProblemError('NOT_FOUND', 'That form has no draft in this organisation.');
      return { ...row, updatedAt: row.updatedAt.toISOString() };
    },
  );

  r.put(
    '/v1/forms/:id/draft',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: ['forms'],
        summary: 'Save the v2 form definition as the org draft (ops and plaintext passwords stay on the client)',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          draft: z
            .object({ schemaVersion: z.literal(2), title: z.string().max(500).optional() })
            .passthrough(),
        }),
        response: { 200: z.object({ draftRev: z.number().int(), updatedAt: z.iso.datetime({ offset: true }) }) },
      },
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const draft = request.body.draft as Record<string, unknown>;
      const sizeBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
      if (sizeBytes > 5_242_880) throw new ProblemError('PAYLOAD_TOO_LARGE', 'The draft is larger than 5 MB.');
      const title = (typeof draft.title === 'string' ? draft.title : '').trim() || 'Untitled form';
      const match = request.headers['if-match'];
      const expectedRev = typeof match === 'string' && /^\d+$/.test(match) ? Number(match) : null;

      const saved = await withTenant(deps.db, tenant, async (tx) => {
        const found = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, id)).limit(1);
        if (!found[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');

        const existing = await tx
          .select({ draftRev: formDrafts.draftRev })
          .from(formDrafts)
          .where(eq(formDrafts.formId, id))
          .limit(1);
        const current = existing[0];
        if (expectedRev !== null) {
          if (!current && expectedRev !== 0) throw new ProblemError('DRAFT_REV_CONFLICT');
          if (current && current.draftRev !== expectedRev) throw new ProblemError('DRAFT_REV_CONFLICT');
        }

        const nextRev = current ? current.draftRev + 1 : 1;
        const now = new Date();
        if (!current) {
          await tx.insert(formDrafts).values({
            formId: id,
            orgId: tenant.orgId,
            draft,
            draftRev: nextRev,
            schemaVersion: 2,
            sizeBytes,
            updatedBy: userId,
            updatedAt: now,
          });
        } else {
          await tx
            .update(formDrafts)
            .set({ draft, draftRev: nextRev, schemaVersion: 2, sizeBytes, updatedBy: userId, updatedAt: now })
            .where(eq(formDrafts.formId, id));
        }
        await tx.update(forms).set({ title, updatedAt: now, updatedBy: userId }).where(eq(forms.id, id));
        return { draftRev: nextRev, updatedAt: now.toISOString() };
      });
      return saved;
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
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
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
        title: request.body.title,
        resolutions: request.body.resolutions,
        newId: () => randomUUID(),
      });
      if (!merged.ok) {
        return reply.code(409).send({ status: 'conflict' as const, conflicts: merged.conflicts });
      }

      const id = merged.definition.formId;
      const draft = merged.definition as unknown as Record<string, unknown>;
      const sizeBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
      if (sizeBytes > 5_242_880) throw new ProblemError('PAYLOAD_TOO_LARGE', 'The merged form is larger than 5 MB.');
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
