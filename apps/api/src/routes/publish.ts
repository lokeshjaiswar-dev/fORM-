import { randomUUID } from 'node:crypto';
import { eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { formDrafts, forms, formVersions, withTenant, type Db, type Tx } from '@form/db';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { FormDefinitionSchema, slugOf, type FormDefinition } from '@form/schema';
import { z } from 'zod';
import { accountOf, tenantOf } from '../auth.ts';
import { ProblemError } from '../errors.ts';
import { forgetPublished } from './public.ts';

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

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Raster pictures only: an SVG can carry script, and the builder shrinks every upload to a JPEG anyway. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_CHARS = 3_000_000;
const MAX_MEDIA = 64;
const PUBLISH_BODY_LIMIT = 8 * 1024 * 1024;

const publishBody = z
  .object({
    /** Pictures the form uses, by the asset id the definition names (kept only when the definition uses that id). */
    media: z.record(z.string().regex(ASSET_ID), z.string().max(MAX_IMAGE_CHARS).regex(DATA_IMAGE)).optional(),
  })
  .strict()
  .nullish();

/** Every `assetId` the definition names: the pictures that may travel with the version. */
function assetIdsOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) assetIdsOf(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'assetId' && typeof nested === 'string') into.add(nested);
      else assetIdsOf(nested, into);
    }
  }
  return into;
}

function usedMedia(definition: FormDefinition, media: Record<string, string> | undefined): Record<string, string> | null {
  if (!media) return null;
  const used = assetIdsOf(definition);
  const kept = Object.entries(media).filter(([id]) => used.has(id)).slice(0, MAX_MEDIA);
  return kept.length ? Object.fromEntries(kept) : null;
}

function parsedDefinition(draft: unknown, formId: string): FormDefinition {
  const parsed = FormDefinitionSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ProblemError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'The draft is not a valid v2 form.');
  }
  return { ...parsed.data, formId } as FormDefinition;
}

async function freeze(
  tx: Tx,
  o: { orgId: string; formId: string; userId: string; definition: FormDefinition; media?: Record<string, string> | undefined },
): Promise<Published> {
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
    media: usedMedia(o.definition, o.media),
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
      bodyLimit: PUBLISH_BODY_LIMIT,
      schema: {
        tags: ['forms'],
        summary: 'Freeze the saved draft as the live version and assign a public slug',
        description:
          'The only way to publish: a session, a membership of the active org and `forms.publish`. The body may carry the pictures the form uses (`media`).',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        body: publishBody,
        response: { 200: published },
      },
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const live = await withTenant(deps.db, tenant, async (tx) => {
        const [form] = await tx.select().from(forms).where(eq(forms.id, id)).limit(1);
        if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const [draftRow] = await tx.select().from(formDrafts).where(eq(formDrafts.formId, id)).limit(1);
        if (!draftRow) throw new ProblemError('NOT_FOUND', 'That form has no draft to publish.');
        return freeze(tx, { orgId: tenant.orgId, formId: id, userId, definition: parsedDefinition(draftRow.draft, id), media: request.body?.media });
      });
      forgetPublished(live.slug);
      return live;
    },
  );
}
