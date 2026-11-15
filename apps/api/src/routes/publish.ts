import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, max } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, auditActor, formAccess, formDrafts, forms, formVersions, formVersionState, withTenant, type Db, type Tx } from '@form/db';
import { slugOf, type FormDefinition } from '@form/schema';
import { z } from 'zod';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import { PROBLEM_CONTENT_TYPE, ProblemError, problemOf } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { capIssues, type PipelineIssue } from '../publish/issues.ts';
import { publishPipeline, type PublishOutcome } from '../publish/pipeline.ts';
import { NO_ORG_PROFILE, type OrgProfileSource } from '../publish/resolve.ts';
import { storableString } from '../text-safety.ts';

const published = z.object({
  slug: z.string(),
  versionId: z.uuid(),
  number: z.number().int(),
  /** The draft revision this version froze; null for a version published before revisions were recorded. */
  draftRev: z.number().int().nullable(),
});

export type Published = z.infer<typeof published>;

const issue = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  path: z.string(),
  message: z.string(),
  fixUrl: z.string().optional(),
});

/** The 422 problem+json of a refused publish: PUBLISH_BLOCKED carries the issues, PLAN_MISMATCH only a detail. */
const refusal = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string(),
  requestId: z.string(),
  issues: z.array(issue).optional(),
  /** How many issues there were before the list was cut to its first 200. */
  issueCount: z.number().int().optional(),
});

const checked = z.object({
  /** True when the saved draft has no error issue, so a publish would go through (the checks that need no client input). */
  ok: z.boolean(),
  draftRev: z.number().int(),
  /** The server's compile hash of the draft, when it compiles: what a client's own plan has to equal. */
  definitionHash: z.string().nullable(),
  issues: z.array(issue),
  /** How many issues there were before the list was cut to its first 200. */
  issueCount: z.number().int(),
});

/** The label a publisher gives a version ("Spring campaign"); shown in the version list, never in the form. */
const MAX_LABEL = 120;

function publicSlug(title: string): string {
  return slugOf(title).replaceAll('_', '-').slice(0, 80) || 'form';
}

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Raster pictures only: an SVG can carry script, and the builder shrinks every upload to a JPEG anyway. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_CHARS = 3_000_000;
const MAX_MEDIA = 64;
const PUBLISH_BODY_LIMIT = 8 * 1024 * 1024;

const publishBody = z
  .object({
    /**
     * The draft revision the author saw and is publishing (`GET .../draft` `draftRev`). A newer saved draft is a 409, so a
     * publish never freezes edits its author has not seen; a revision that is already published returns that version,
     * so a retry after a lost answer creates nothing. Left out, the current draft is published as a new version each
     * time (the builder sends it from WP-1.06 on).
     */
    expectedDraftRev: z.number().int().min(1).optional(),
    /**
     * The `definitionHash` of the plan the client compiled from that draft. The server compiles the draft itself and
     * stores only its own plan; a hash that differs is a 422 PLAN_MISMATCH and nothing is stored.
     */
    clientDefinitionHash: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    label: storableString(MAX_LABEL).optional(),
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

/**
 * The pictures one published version may carry, all together (their data URLs, about one byte a character). Every open
 * link to the version serves them and the public routes keep them in memory, so the total is bounded here, at publish,
 * not left to the 8 MiB the request may weigh. The builder shrinks every picture to a JPEG of at most 1600 px, which
 * is a few hundred kilobytes; two megabytes holds a cover, a background and a good handful of image choices.
 */
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;

function usedMedia(definition: FormDefinition, media: Record<string, string> | undefined): Record<string, string> | null {
  if (!media) return null;
  const used = assetIdsOf(definition);
  const kept = Object.entries(media).filter(([id]) => used.has(id)).slice(0, MAX_MEDIA);
  const total = kept.reduce((sum, [, dataUrl]) => sum + dataUrl.length, 0);
  if (total > MAX_MEDIA_BYTES) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    throw new ProblemError(
      'PAYLOAD_TOO_LARGE',
      `The pictures this form uses add up to ${mb(total)} MB; a published form can carry ${mb(MAX_MEDIA_BYTES)} MB of pictures. Use fewer or smaller pictures.`,
    );
  }
  return kept.length ? Object.fromEntries(kept) : null;
}

/** `unique_violation`, however the driver wrapped it (drizzle keeps the pg error as `cause`). */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
  return code === '23505';
}

/** `form_access.redirect_allowlist` of a form: null when the form has no access row or the row set no list. */
async function redirectAllowlistOf(tx: Tx, formId: string): Promise<string[] | null> {
  const [row] = await tx.select({ list: formAccess.redirectAllowlist }).from(formAccess).where(eq(formAccess.formId, formId)).limit(1);
  return row?.list ?? null;
}

/** The version a draft revision was published as, if it was (the newest, when a revision was published more than once). */
async function versionOfRev(tx: Tx, formId: string, draftRev: number) {
  const [row] = await tx
    .select({ id: formVersions.id, number: formVersions.number })
    .from(formVersions)
    .where(and(eq(formVersions.formId, formId), eq(formVersions.draftRev, draftRev)))
    .orderBy(desc(formVersions.number))
    .limit(1);
  return row ?? null;
}

type FormRow = typeof forms.$inferSelect;

/**
 * Makes `versionId` the form's live version, and gives the form its address when it has none. A first publish takes
 * `<title>-<last 8 characters of the id>`. Slugs are one namespace across orgs (`form_slugs`), so that address can belong to
 * another org's form; the form then takes the long one, which ends in its whole id. Each attempt is a savepoint, as a
 * refused statement would otherwise abort the publish.
 */
async function goLive(tx: Tx, form: FormRow, versionId: string, o: { title: string; userId: string; now: Date }): Promise<string> {
  const set = { liveVersionId: versionId, updatedAt: o.now, updatedBy: o.userId, title: o.title.trim() || form.title };
  if (form.slug) {
    await tx.update(forms).set(set).where(eq(forms.id, form.id));
    return form.slug;
  }
  const base = publicSlug(o.title || form.title);
  // The random end of the id, not its start: in a UUIDv7 (clone and import make them) the first 32 bits are a timestamp
  // that repeats for about a minute, so two forms with one title made close together would get one slug.
  const candidates = [`${base}-${form.id.slice(-8)}`, `${base}-${form.id.replaceAll('-', '')}`];
  for (const [i, slug] of candidates.entries()) {
    try {
      await tx.transaction((attempt) => attempt.update(forms).set({ ...set, slug }).where(eq(forms.id, form.id)));
      return slug;
    } catch (err) {
      if (i === candidates.length - 1 || !isUniqueViolation(err)) throw err;
    }
  }
  throw new ProblemError('INTERNAL');
}

type Attempt =
  | { kind: 'published'; published: Published }
  | { kind: 'refused'; outcome: Extract<PublishOutcome, { ok: false }> };

/** The 422 body of a blocked publish: the problem+json fields plus the whole issue list. */
function blockedBody(request: FastifyRequest, issues: readonly PipelineIssue[]) {
  const { issues: shown, issueCount } = capIssues(issues);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const detail = `${errors} ${errors === 1 ? 'problem' : 'problems'} to fix before this form can be published.`;
  return { ...problemOf(request, 'PUBLISH_BLOCKED', detail), issues: shown, issueCount };
}

export interface PublishDeps {
  db: Db;
  secret: Uint8Array;
  now: () => Date;
  /** Where the org profile comes from (WP-T1.3); none until then. */
  profiles?: OrgProfileSource;
}

export function publishRoutes(app: FastifyInstance, deps: PublishDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const profiles = deps.profiles ?? NO_ORG_PROFILE;

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
      return withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        const [row] = await tx.select({ slug: forms.slug, liveVersionId: forms.liveVersionId }).from(forms).where(eq(forms.id, id)).limit(1);
        const versionId = row?.liveVersionId;
        if (!row?.slug || !versionId) throw new ProblemError('NOT_FOUND', 'This form has not been published.');
        const [version] = await tx.select({ number: formVersions.number, draftRev: formVersions.draftRev }).from(formVersions).where(eq(formVersions.id, versionId)).limit(1);
        return { slug: row.slug, versionId, number: version?.number ?? 1, draftRev: version?.draftRev ?? null };
      });
    },
  );

  r.post(
    '/v1/forms/:id/validate',
    {
      config: { auth: 'user', perm: 'forms.edit' },
      schema: {
        tags: ['forms'],
        summary: 'The issues that would block publishing the saved draft, without publishing it',
        description:
          'Runs the publish checks on the saved draft (`validateDefinition` in publish mode, the regex checks, the form’s redirect allowlist, a compile) and writes nothing. Always 200: `ok` says whether a publish would go through, and `issues` lists every error and warning with its JSON-pointer `path`.',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        body: z.object({}).strict().nullish(),
        response: { 200: checked },
      },
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const { draftRow, allowlist } = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        const [form] = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, id)).limit(1);
        if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const [row] = await tx.select({ draft: formDrafts.draft, draftRev: formDrafts.draftRev }).from(formDrafts).where(eq(formDrafts.formId, id)).limit(1);
        if (!row) throw new ProblemError('NOT_FOUND', 'That form has no draft to check.');
        return { draftRow: row, allowlist: await redirectAllowlistOf(tx, id) };
      });
      const outcome = await publishPipeline(draftRow.draft, { orgId: tenant.orgId, formId: id, redirectAllowlist: allowlist, profiles });
      if (outcome.ok) return { ok: true, draftRev: draftRow.draftRev, definitionHash: outcome.contentHash, ...capIssues(outcome.issues) };
      // No client hash was sent, so a mismatch cannot happen here; the type still has to be narrowed.
      const issues = outcome.reason === 'blocked' ? outcome.issues : [];
      return { ok: false, draftRev: draftRow.draftRev, definitionHash: null, ...capIssues(issues) };
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
          'The only way to publish: a session, a membership of the active org and `forms.publish`. The saved draft is parsed strictly, checked and compiled on the server (422 PUBLISH_BLOCKED with `issues`, or 422 PLAN_MISMATCH when `clientDefinitionHash` differs from the server’s compile); a stale `expectedDraftRev` is a 409 DRAFT_REV_CONFLICT, and a revision that is already published returns its version. The body may carry the pictures the form uses (`media`, at most 2 MB together, else 413).',
        security: [{ session: [], org: [] }, { devUser: [], org: [] }],
        params: z.object({ id: z.uuid() }),
        body: publishBody,
        response: { 200: published, 422: refusal },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const input = request.body ?? {};
      const label = input.label?.trim() || null;
      const cl = clientInfo(request, deps.secret, deps.now());

      const attempt = await withTenant(deps.db, tenant, async (tx): Promise<Attempt> => {
        // 1. Read, with no lock, what the pipeline needs: it is CPU work, and a submit to this form must not wait for it.
        const [seen] = await tx.select({ lifecycle: forms.lifecycle, slug: forms.slug }).from(forms).where(eq(forms.id, id)).limit(1);
        if (!seen || seen.lifecycle === 'trashed') throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
        const [draftRow] = await tx.select().from(formDrafts).where(eq(formDrafts.formId, id)).limit(1);
        if (!draftRow) throw new ProblemError('NOT_FOUND', 'That form has no draft to publish.');
        const allowlist = await redirectAllowlistOf(tx, id);

        const replay = async (slug: string | null): Promise<Attempt | null> => {
          if (input.expectedDraftRev === undefined) return null;
          const version = await versionOfRev(tx, id, input.expectedDraftRev);
          if (!version) return null;
          // A version only exists once its form has an address (they are set in one transaction).
          if (!slug) throw new ProblemError('INTERNAL', `form ${id} has version ${version.id} and no slug`);
          return { kind: 'published', published: { slug, versionId: version.id, number: version.number, draftRev: input.expectedDraftRev } };
        };
        // A revision that has been published is answered with its version whatever the draft is now (an autosave may have moved it on).
        const early = await replay(seen.slug);
        if (early) return early;
        if (input.expectedDraftRev !== undefined && draftRow.draftRev !== input.expectedDraftRev) {
          throw new ProblemError('DRAFT_REV_CONFLICT', `The draft is at revision ${draftRow.draftRev}, not ${input.expectedDraftRev}. Reload it and publish again.`);
        }

        // 2. strict parse → resolve → checks → compile + client-hash compare → hash.
        const outcome = await publishPipeline(draftRow.draft, {
          orgId: tenant.orgId,
          formId: id,
          redirectAllowlist: allowlist,
          profiles,
          clientDefinitionHash: input.clientDefinitionHash,
        });
        if (!outcome.ok) return { kind: 'refused', outcome };
        // Checked before anything is written: a form that cannot be published for its pictures touches nothing.
        const media = usedMedia(outcome.definition, input.media);

        // 3. Write. The form row is locked now, so two publishes of one form run one after the other, and what changed
        // while the pipeline ran (a concurrent publish of this revision, an autosave) is seen and handled.
        const form = await lockedForm(tx, id);
        const concurrent = await replay(form.slug);
        if (concurrent) return concurrent;
        const [current] = await tx.select({ draftRev: formDrafts.draftRev }).from(formDrafts).where(eq(formDrafts.formId, id)).limit(1);
        if (current?.draftRev !== draftRow.draftRev) {
          throw new ProblemError('DRAFT_REV_CONFLICT', 'The draft was saved again while it was being checked. Reload it and publish again.');
        }

        const [last] = await tx.select({ n: max(formVersions.number) }).from(formVersions).where(eq(formVersions.formId, id));
        const number = (last?.n ?? 0) + 1;
        const versionId = randomUUID();
        const now = new Date();
        const { definition } = outcome;
        await tx.insert(formVersions).values({
          id: versionId,
          orgId: tenant.orgId,
          formId: id,
          number,
          schemaVersion: definition.schemaVersion,
          publishedAt: now,
          publishedBy: userId,
          definition: definition as unknown as Record<string, unknown>,
          compiled: outcome.compiled as unknown as Record<string, unknown>,
          contentHash: outcome.contentHash,
          media,
          label,
          engine: outcome.engine,
          draftRev: draftRow.draftRev,
          templateLineage: outcome.templateLineage,
          variablesSnapshot: outcome.variablesSnapshot,
        });
        // The version that was live is superseded as the new one goes live (accepting it for a while is decided at submit time).
        if (form.liveVersionId) {
          await tx
            .update(formVersionState)
            .set({ supersededAt: now })
            .where(and(eq(formVersionState.versionId, form.liveVersionId), isNull(formVersionState.supersededAt)));
        }
        const slug = await goLive(tx, form, versionId, { title: definition.title, userId, now });
        // In the same transaction as the version: a live form with no record of who published it is what the retired
        // anonymous route left behind (tools/audit/guest-published-versions.sql looks for versions without this event).
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: accountOf(request).session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'form.published',
          resourceType: 'form_version',
          resourceId: versionId,
          formId: id,
          outcome: 'success',
          metadata: { number, slug, draftRev: draftRow.draftRev, contentHash: outcome.contentHash, label },
        });
        return { kind: 'published', published: { slug, versionId, number, draftRev: draftRow.draftRev } };
      });

      if (attempt.kind === 'published') return attempt.published;
      const { outcome } = attempt;
      if (outcome.reason === 'plan_mismatch') {
        const detail = `The plan the client compiled (${outcome.clientHash}) is not the one the server compiles from the saved draft (${outcome.serverHash}). Nothing was published; reload the draft and publish again.`;
        return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(problemOf(request, 'PLAN_MISMATCH', detail));
      }
      return reply.code(422).type(PROBLEM_CONTENT_TYPE).send(blockedBody(request, outcome.issues));
    },
  );
}

/** The form row, locked against another publish (`FOR NO KEY UPDATE` does not stop a submit's foreign-key check on it). */
async function lockedForm(tx: Tx, id: string): Promise<FormRow> {
  const [form] = await tx.select().from(forms).where(eq(forms.id, id)).for('no key update').limit(1);
  if (!form || form.lifecycle === 'trashed') throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
  return form;
}
