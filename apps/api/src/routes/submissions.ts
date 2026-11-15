import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { formVersions, forms, submissionKey, submissions, withTenant, type Db, type Tx } from '@form/db';
import type { Answers, FormDefinition } from '@form/schema';
import { z } from 'zod';
import { tenantOf } from '../auth.ts';
import { displayRows, type DisplayRow } from '../display-rows.ts';
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

/** The language a response was given in: `meta.locale`, which the submit route always writes. */
const localeOf = (meta: Record<string, unknown>): string => (typeof meta['locale'] === 'string' ? meta['locale'] : 'en-IN');

/**
 * The definition of each version the given submissions were received on, read once per version. A response stores its
 * answers and the id of the version they were validated against, not display rows: the rows (a field's own label and its
 * answer as readable text) are rebuilt from the two on every read, with the same builder the submit route validated
 * against, so a page cannot show a line the form never asked.
 */
async function definitionsOf(tx: Tx, versionIds: readonly string[]): Promise<Map<string, FormDefinition>> {
  if (versionIds.length === 0) return new Map();
  const rows = await tx.select({ id: formVersions.id, definition: formVersions.definition }).from(formVersions).where(inArray(formVersions.id, [...new Set(versionIds)]));
  return new Map(rows.map((row) => [row.id, row.definition as unknown as FormDefinition]));
}

function rowsOf(definitions: Map<string, FormDefinition>, row: { formVersionId: string; answers: Record<string, unknown> }): DisplayRow[] {
  const definition = definitions.get(row.formVersionId);
  return definition ? displayRows(definition, row.answers as unknown as Answers) : [];
}

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
      const items = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        // RLS hides another org's form, so a foreign or made-up id is a 404 rather than an empty inbox.
        const found = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
        if (!found[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        // Newest first by the moment received: the order of the grid index, which leaves trashed responses out.
        const rows = await tx
          .select({ id: submissions.id, formId: submissions.formId, receivedAt: submissions.receivedAt, formVersionId: submissions.formVersionId, answers: submissions.answers })
          .from(submissions)
          .where(and(eq(submissions.formId, formId), isNull(submissions.trashedAt)))
          .orderBy(desc(submissions.receivedAt), desc(submissions.id));
        const definitions = await definitionsOf(tx, rows.map((row) => row.formVersionId));
        return rows.map((row) => ({
          id: row.id,
          formId: row.formId,
          submittedAt: row.receivedAt.toISOString(),
          fieldCount: rowsOf(definitions, row).length,
        }));
      });
      return { items };
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
      return withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        // By id and the partition key it implies, so one partition is read; an id that is not a UUIDv7 matches nothing.
        const rows = await tx
          .select()
          .from(submissions)
          .where(and(eq(submissions.formId, formId), submissionKey(id)))
          .limit(1);
        const row = rows[0];
        if (!row) throw new ProblemError('NOT_FOUND', 'That submission is not on this form.');
        const fields = rowsOf(await definitionsOf(tx, [row.formVersionId]), row);
        return {
          id: row.id,
          formId: row.formId,
          submittedAt: row.receivedAt.toISOString(),
          fieldCount: fields.length,
          locale: localeOf(row.meta),
          answers: row.answers,
          fields,
        };
      });
    },
  );
}
