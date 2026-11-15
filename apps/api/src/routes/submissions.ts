import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { formSubmissions, forms, withTenant, type Db } from '@form/db';
import { z } from 'zod';
import { tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';

const fieldRow = z.object({ key: z.string(), label: z.string(), value: z.string() });

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

/**
 * List and read the submissions of a form in the active org. There is no route to create one: a response comes from
 * the published page (`POST /v1/p/:slug/submissions`), which validates it against the live version and binds its files;
 * the builder's preview keeps its rehearsal responses in the browser and sends nothing here.
 */
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
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        // RLS hides another org's form, so a foreign or made-up id is a 404 rather than an empty inbox.
        const found = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
        if (!found[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        return tx
          .select({
            id: formSubmissions.id,
            formId: formSubmissions.formId,
            submittedAt: formSubmissions.submittedAt,
            fields: formSubmissions.fields,
          })
          .from(formSubmissions)
          .where(eq(formSubmissions.formId, formId))
          .orderBy(desc(formSubmissions.submittedAt), desc(formSubmissions.id));
      });
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
}
