import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { editionSummary, runtimeEdition, type RuntimeEdition } from '@form/config';
import { formSubmissions, formVersions, forms, resolveFormSlug, withTenant, type Db } from '@form/db';
import { projectForRuntime } from '@form/logic';
import type { CompiledForm, FormDefinition, FormId, FormVersion, FormVersionId, IsoInstant, OrgId, Sha256Hex, UserId } from '@form/schema';
import { z } from 'zod';
import type { ApiConfig } from '../config.ts';
import { ProblemError } from '../errors.ts';

const slugParam = z.object({ slug: z.string().min(1).max(128) });

const fieldRow = z.object({ key: z.string(), label: z.string(), value: z.string() });

export function publicFormRoutes(app: FastifyInstance, deps: { db: Db; config: ApiConfig }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const edition: RuntimeEdition = runtimeEdition(editionSummary(deps.config.edition));

  r.get(
    '/v1/p/:slug',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Public runtime projection of the live version',
        params: slugParam,
        response: {
          200: z.object({
            slug: z.string(),
            formId: z.uuid(),
            version: z.unknown(),
          }),
        },
      },
    },
    async (request) => {
      const found = await resolveFormSlug(deps.db, request.params.slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const rows = await withTenant(deps.db, { orgId: found.orgId, actor: 'system', requestId: request.id, readOnly: true }, (tx) =>
        tx
          .select()
          .from(formVersions)
          .where(and(eq(formVersions.id, found.liveVersionId), eq(formVersions.formId, found.formId)))
          .limit(1),
      );
      const row = rows[0];
      if (!row) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const version: FormVersion = {
        id: row.id as FormVersionId,
        orgId: row.orgId as OrgId,
        formId: row.formId as FormId,
        number: row.number,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt.toISOString() as IsoInstant,
        publishedBy: row.publishedBy as UserId,
        definition: row.definition as unknown as FormDefinition,
        compiled: row.compiled as unknown as CompiledForm,
        contentHash: row.contentHash as Sha256Hex,
        templateLineage: [],
        variablesSnapshot: { variables: {} },
      };
      return {
        slug: request.params.slug,
        formId: found.formId,
        version: projectForRuntime(version, { state: 'open' }, {
          edition,
          upload: { presignUrl: '', maxFileBytes: 0 },
          branding: false,
          thirdPartyTrackingAllowed: false,
        }),
      };
    },
  );

  r.post(
    '/v1/p/:slug/submissions',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['runtime'],
        summary: 'Submit answers on a published form',
        params: slugParam,
        body: z.object({
          formVersionId: z.uuid(),
          answers: z.record(z.string(), z.unknown()),
          fields: z.array(fieldRow).default([]),
          locale: z.string().min(2).max(35).default('en-IN'),
        }),
        response: { 200: z.object({ id: z.uuid() }) },
      },
    },
    async (request) => {
      const found = await resolveFormSlug(deps.db, request.params.slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      if (request.body.formVersionId !== found.liveVersionId) {
        throw new ProblemError('NOTICE_OUTDATED', 'This form was updated. Reload and try again.');
      }
      const id = randomUUID();
      await withTenant(deps.db, { orgId: found.orgId, actor: 'system', requestId: request.id }, async (tx) => {
        await tx.insert(formSubmissions).values({
          id,
          orgId: found.orgId,
          formId: found.formId,
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
          .where(eq(forms.id, found.formId));
      });
      return { id };
    },
  );
}
