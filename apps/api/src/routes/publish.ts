import { randomUUID } from 'node:crypto';
import { eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { formDrafts, forms, formVersions, withTenant, type Db } from '@form/db';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { FormDefinitionSchema, slugOf, type FormDefinition } from '@form/schema';
import { z } from 'zod';
import { accountOf, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';

const published = z.object({
  slug: z.string(),
  versionId: z.uuid(),
  number: z.number().int(),
});

function publicSlug(title: string, formId: string): string {
  const base = slugOf(title).replaceAll('_', '-').slice(0, 80) || 'form';
  return `${base}-${formId.slice(0, 8)}`;
}

export function publishRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/forms/:id/live',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['forms'],
        summary: 'The public slug and live version, if this form has been published',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        response: { 200: published },
      },
    },
    async (request) => {
      const { id } = request.params;
      const rows = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx.select({ slug: forms.slug, liveVersionId: forms.liveVersionId }).from(forms).where(eq(forms.id, id)).limit(1),
      );
      const row = rows[0];
      const versionId = row?.liveVersionId;
      if (!row?.slug || !versionId) throw new ProblemError('NOT_FOUND', 'This form has not been published.');
      const versions = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx.select({ number: formVersions.number }).from(formVersions).where(eq(formVersions.id, versionId)).limit(1),
      );
      return { slug: row.slug, versionId, number: versions[0]?.number ?? 1 };
    },
  );

  r.post(
    '/v1/forms/:id/publish',
    {
      config: { auth: 'user', perm: 'forms.publish' },
      schema: {
        tags: ['forms'],
        summary: 'Freeze the current draft as the live version and assign a public slug',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        body: z.object({}).strict(),
        response: { 200: published },
      },
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      return withTenant(deps.db, tenant, async (tx) => {
        const [form] = await tx.select().from(forms).where(eq(forms.id, id)).limit(1);
        if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const [draftRow] = await tx.select().from(formDrafts).where(eq(formDrafts.formId, id)).limit(1);
        if (!draftRow) throw new ProblemError('NOT_FOUND', 'That form has no draft to publish.');
        const parsed = FormDefinitionSchema.safeParse(draftRow.draft);
        if (!parsed.success) {
          throw new ProblemError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'The draft is not a valid v2 form.');
        }
        const definition = { ...parsed.data, formId: id } as FormDefinition;
        const compiled = compile(definition, REGISTRY);
        if (!compiled.ok) {
          const first = compiled.issues.find((i) => i.severity === 'error') ?? compiled.issues[0];
          throw new ProblemError('VALIDATION_FAILED', first?.message ?? 'This form cannot be published yet.');
        }
        const [last] = await tx
          .select({ n: max(formVersions.number) })
          .from(formVersions)
          .where(eq(formVersions.formId, id));
        const number = (last?.n ?? 0) + 1;
        const versionId = randomUUID();
        const now = new Date();
        await tx.insert(formVersions).values({
          id: versionId,
          orgId: tenant.orgId,
          formId: id,
          number,
          schemaVersion: definition.schemaVersion,
          publishedAt: now,
          publishedBy: userId,
          definition: definition as unknown as Record<string, unknown>,
          compiled: compiled.compiled as unknown as Record<string, unknown>,
          contentHash: compiled.compiled.definitionHash,
        });
        const slug = form.slug ?? publicSlug(definition.title || form.title, id);
        await tx
          .update(forms)
          .set({ liveVersionId: versionId, slug, updatedAt: now, updatedBy: userId, title: definition.title.trim() || form.title })
          .where(eq(forms.id, id));
        return { slug, versionId, number };
      });
    },
  );
}
