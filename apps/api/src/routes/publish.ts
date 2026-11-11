import { randomUUID } from 'node:crypto';
import { eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { formDrafts, forms, formVersions, guestPublishForm, withTenant, type Db, type Tx } from '@form/db';
import { compile, projectForRuntime } from '@form/logic';
import { REGISTRY } from '@form/registry';
import {
  FormDefinitionSchema,
  slugOf,
  type CompiledForm,
  type FormDefinition,
  type FormId,
  type FormVersion,
  type FormVersionId,
  type IsoInstant,
  type OrgId,
  type Sha256Hex,
  type UserId,
} from '@form/schema';
import { z } from 'zod';
import { accountOf, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import { savePublished } from './public.ts';

const published = z.object({
  slug: z.string(),
  versionId: z.uuid(),
  number: z.number().int(),
});

export type Published = z.infer<typeof published>;

function publicSlug(title: string, formId: string): string {
  const base = slugOf(title).replaceAll('_', '-').slice(0, 80) || 'form';
  return `${base}-${formId.slice(0, 8)}`;
}

function parsedDefinition(draft: unknown, formId: string): FormDefinition {
  const parsed = FormDefinitionSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ProblemError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'The draft is not a valid v2 form.');
  }
  return { ...parsed.data, formId } as FormDefinition;
}

async function freeze(tx: Tx, o: { orgId: string; formId: string; userId: string; definition: FormDefinition }): Promise<Published> {
  const compiled = compile(o.definition, REGISTRY);
  if (!compiled.ok) {
    const first = compiled.issues.find((i) => i.severity === 'error') ?? compiled.issues[0];
    throw new ProblemError('VALIDATION_FAILED', first?.message ?? 'This form cannot be published yet.');
  }
  const [form] = await tx.select().from(forms).where(eq(forms.id, o.formId)).limit(1);
  if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
  const [last] = await tx.select({ n: max(formVersions.number) }).from(formVersions).where(eq(formVersions.formId, o.formId));
  const number = (last?.n ?? 0) + 1;
  const versionId = randomUUID();
  const now = new Date();
  await tx.insert(formVersions).values({
    id: versionId,
    orgId: o.orgId,
    formId: o.formId,
    number,
    schemaVersion: o.definition.schemaVersion,
    publishedAt: now,
    publishedBy: o.userId,
    definition: o.definition as unknown as Record<string, unknown>,
    compiled: compiled.compiled as unknown as Record<string, unknown>,
    contentHash: compiled.compiled.definitionHash,
  });
  const slug = form.slug ?? publicSlug(o.definition.title || form.title, o.formId);
  await tx
    .update(forms)
    .set({ liveVersionId: versionId, slug, updatedAt: now, updatedBy: o.userId, title: o.definition.title.trim() || form.title })
    .where(eq(forms.id, o.formId));
  return { slug, versionId, number };
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
        return freeze(tx, { orgId: tenant.orgId, formId: id, userId, definition: parsedDefinition(draftRow.draft, id) });
      });
    },
  );

  r.post(
    '/v1/p/publish',
    {
      config: { auth: 'none' },
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        tags: ['runtime'],
        summary: 'Publish a draft without a session so the public fill link works on any device',
        body: z.object({
          id: z.uuid(),
          draft: z.record(z.string(), z.unknown()),
          media: z.record(z.string(), z.string()).optional(),
        }),
        response: { 200: published },
      },
    },
    async (request) => {
      const { id, draft } = request.body;
      const definition = parsedDefinition(draft, id);
      const compiled = compile(definition, REGISTRY);
      if (!compiled.ok) {
        const first = compiled.issues.find((i) => i.severity === 'error') ?? compiled.issues[0];
        throw new ProblemError('VALIDATION_FAILED', first?.message ?? 'This form cannot be published yet.');
      }
      const title = definition.title.trim() || 'Untitled form';
      const sizeBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
      if (sizeBytes > 5_242_880) throw new ProblemError('PAYLOAD_TOO_LARGE', 'The draft is larger than 5 MB.');
      const payload = {
        formId: id,
        title,
        slug: publicSlug(title, id),
        draft,
        definition: definition as unknown as Record<string, unknown>,
        compiled: compiled.compiled as unknown as Record<string, unknown>,
        contentHash: compiled.compiled.definitionHash,
        schemaVersion: definition.schemaVersion,
        sizeBytes,
        versionId: randomUUID(),
      };
      let published = { slug: payload.slug, versionId: payload.versionId, number: 1 };
      try {
        published = (await guestPublishForm(deps.db, payload)) ?? published;
      } catch {
        try {
          published = (await guestPublishForm(deps.db, payload)) ?? published;
        } catch {
          /* Remote Postgres timed out: still serve the fill link from this machine. */
        }
      }
      const now = new Date().toISOString() as IsoInstant;
      const version: FormVersion = {
        id: published.versionId as FormVersionId,
        orgId: '01970000-0000-7000-8000-000000000001' as OrgId,
        formId: id as FormId,
        number: published.number,
        schemaVersion: definition.schemaVersion,
        publishedAt: now,
        publishedBy: '01970000-0000-7000-8000-000000000002' as UserId,
        definition,
        compiled: compiled.compiled,
        contentHash: compiled.compiled.definitionHash as Sha256Hex,
        templateLineage: [],
        variablesSnapshot: { variables: {} },
      };
      await savePublished({
        slug: published.slug,
        formId: id,
        version: projectForRuntime(version, { state: 'open' }, {
          edition: 'onprem',
          upload: { presignUrl: '', maxFileBytes: 10 * 1024 * 1024 },
          branding: false,
          thirdPartyTrackingAllowed: false,
        }),
        media: request.body.media,
      });
      return published;
    },
  );
}
