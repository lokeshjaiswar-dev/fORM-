import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { formSubmissions, forms, withTenant, type Db } from '@form/db';
import { z } from 'zod';
import { tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';

const fieldRow = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  table: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) }).optional(),
  choices: z.array(z.string()).optional(),
});

export const submissionSummary = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  submittedAt: z.iso.datetime({ offset: true }),
  fieldCount: z.number().int(),
});

export const submissionDetail = submissionSummary.extend({
  locale: z.string(),
  answers: z.record(z.string(), z.unknown()),
  fields: z.array(fieldRow),
});

const createBody = z.object({
  answers: z.record(z.string(), z.unknown()),
  fields: z.array(fieldRow).default([]),
  locale: z.string().min(2).max(35).default('en-IN'),
});

/** List, read, and create submissions for a form in the active org. */
export function submissionRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/forms/:formId/submissions',
    {
      config: { auth: 'user', perm: 'submissions.read' },
      schema: {
        tags: ['submissions'],
        summary: 'List submissions for a form',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ formId: z.uuid() }),
        response: { 200: z.object({ items: z.array(submissionSummary) }) },
      },
    },
    async (request) => {
      const { formId } = request.params;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select({
            id: formSubmissions.id,
            formId: formSubmissions.formId,
            submittedAt: formSubmissions.submittedAt,
            fields: formSubmissions.fields,
          })
          .from(formSubmissions)
          .where(eq(formSubmissions.formId, formId))
          .orderBy(desc(formSubmissions.submittedAt), desc(formSubmissions.id)),
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          formId: row.formId,
          submittedAt: row.submittedAt.toISOString(),
          fieldCount: row.fields.length,
        })),
      };
    },
  );

  r.get(
    '/v1/forms/:formId/submissions/:id',
    {
      config: { auth: 'user', perm: 'submissions.read' },
      schema: {
        tags: ['submissions'],
        summary: 'Read one submission',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ formId: z.uuid(), id: z.uuid() }),
        response: { 200: submissionDetail },
      },
    },
    async (request) => {
      const { formId, id } = request.params;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select()
          .from(formSubmissions)
          .where(and(eq(formSubmissions.formId, formId), eq(formSubmissions.id, id)))
          .limit(1),
      );
      const row = rows[0];
      if (!row) throw new ProblemError('NOT_FOUND', 'That submission is not on this form.');
      return {
        id: row.id,
        formId: row.formId,
        submittedAt: row.submittedAt.toISOString(),
        fieldCount: row.fields.length,
        locale: row.locale,
        answers: row.answers,
        fields: row.fields,
      };
    },
  );

  r.post(
    '/v1/forms/:formId/submissions',
    {
      config: { auth: 'user', perm: 'submissions.edit' },
      schema: {
        tags: ['submissions'],
        summary: 'Store a submission',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ formId: z.uuid() }),
        body: createBody,
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request) => {
      const { formId } = request.params;
      const id = randomUUID();
      const tenant = tenantOf(request);
      await withTenant(deps.db, tenant, async (tx) => {
        const found = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
        if (!found[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        await tx.insert(formSubmissions).values({
          id,
          orgId: tenant.orgId,
          formId,
          answers: request.body.answers,
          fields: request.body.fields,
          locale: request.body.locale,
        });
        await tx
          .update(forms)
          .set({
            submissionCount: sql`${forms.submissionCount} + 1`,
            lastSubmissionAt: new Date(),
          })
          .where(eq(forms.id, formId));
      });
      return { id };
    },
  );
}
