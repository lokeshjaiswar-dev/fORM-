import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, auditActor, formDrafts, formReviewSettings, formVersions, forms, reviewGroups, withTenant, type Tx } from '@form/db';
import { ReviewSettingsSchema, type ReviewSettings } from '@form/schema';
import { z } from 'zod';
import { accountOf, tenantOf } from '../../auth.ts';
import { ProblemError, sendProblem, type FieldIssue } from '../../errors.ts';
import type { ReviewModuleDeps } from './context.ts';
import { auditClient, REVIEW_SECURITY } from './http.ts';

const idParam = z.object({ id: z.uuid() });

/** A form's review settings as the API sends them: the stored `ReviewSettings` and the revision to send back in `If-Match`. */
const settingsView = z.object({ rev: z.number().int().min(0), ...ReviewSettingsSchema.shape });
export type ReviewSettingsView = z.infer<typeof settingsView>;

/** A form nobody set up for review: off, no units, revision 0 (the first save names it in `If-Match`). */
export const REVIEW_DEFAULTS: ReviewSettingsView = { rev: 0, enabled: false, distinctCheckers: false, units: [] };

const etag = (rev: number): string => `"${rev}"`;

/** The revision a save read, from `If-Match` (`3`, `"3"` or `W/"3"`). */
export function expectedRev(header: unknown): number {
  const m = typeof header === 'string' ? /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header) : null;
  if (!m) throw new ProblemError('REVIEW_SETTINGS_REV_REQUIRED', 'Send the revision you read (the rev of GET .../review) in If-Match.');
  return Number(m[1]);
}

/**
 * The ids of the review units in a definition's `review` (the draft's or a published version's). Read leniently, not with
 * the strict twin: a draft that is half edited (a unit name that pipes an answer, say) still names the units it has, and
 * the assignments of those units can be saved. Anything that is not a unit with a string id is ignored.
 */
export function reviewUnitIdsOf(review: unknown): string[] {
  const units = (review as { units?: unknown } | null | undefined)?.units;
  if (!Array.isArray(units)) return [];
  return units.flatMap((u) => {
    const id = (u as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * What is wrong with a set of assignments, as field issues (`body/units/2/unitId`, like the ones request validation
 * reports). `known` holds the unit ids of the form's draft and of its live version; `groups` the ids of the unarchived
 * review groups of the org. A unit is assigned once. A group of another org looks exactly like one that does not exist:
 * the caller learns nothing about other orgs.
 */
export function assignmentIssues(units: ReviewSettings['units'], o: { known: ReadonlySet<string>; groups: ReadonlySet<string> }): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  units.forEach((u, i) => {
    if (!o.known.has(u.unitId)) issues.push({ path: `body/units/${i}/unitId`, message: 'this form has no review unit with this id, in its draft or its live version' });
    else if (seen.has(u.unitId)) issues.push({ path: `body/units/${i}/unitId`, message: 'this unit is assigned more than once' });
    seen.add(u.unitId);
    if (!o.groups.has(u.groupId)) issues.push({ path: `body/units/${i}/groupId`, message: 'no such review group in this org, or it is archived' });
  });
  return issues;
}

/** The top-level keys of the settings that differ, in a fixed order; units compare by unit id, so reordering the list is no change. */
export function changedKeys(before: ReviewSettings, next: ReviewSettings): string[] {
  const byUnit = (s: ReviewSettings) => JSON.stringify([...s.units].sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)).map((u) => [u.unitId, u.groupId, u.order, u.required, u.visibility]));
  const keys: string[] = [];
  if (before.enabled !== next.enabled) keys.push('enabled');
  if (before.distinctCheckers !== next.distinctCheckers) keys.push('distinctCheckers');
  if (byUnit(before) !== byUnit(next)) keys.push('units');
  return keys;
}

interface StoredRow {
  rev: number;
  enabled: boolean;
  settings: Record<string, unknown>;
}

/**
 * The row as the view. `settings` holds the whole `ReviewSettings` (this route writes it that way) and `enabled` repeats
 * its flag as a column, so the submit transaction can ask "is this form reviewed" without parsing JSON; the column wins.
 * A row that no longer parses (someone edited it by hand) is a server fault, not an empty setup: the form would otherwise
 * silently stop being reviewed.
 */
export function viewOf(row: StoredRow): ReviewSettingsView {
  const parsed = ReviewSettingsSchema.safeParse({ ...row.settings, enabled: row.enabled });
  if (!parsed.success) throw new Error('form_review_settings.settings is not a valid ReviewSettings');
  return { rev: row.rev, ...parsed.data };
}

/** RLS limits the read to the caller's org, so a form of another org is as absent as one that never existed. */
async function requireForm(tx: Tx, formId: string): Promise<{ liveVersionId: string | null }> {
  const [form] = await tx.select({ liveVersionId: forms.liveVersionId }).from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
  return form;
}

async function loadSettings(tx: Tx, formId: string, o: { forUpdate?: boolean } = {}): Promise<ReviewSettingsView | null> {
  const query = tx
    .select({ rev: formReviewSettings.rev, enabled: formReviewSettings.enabled, settings: formReviewSettings.settings })
    .from(formReviewSettings)
    .where(eq(formReviewSettings.formId, formId))
    .limit(1);
  const [row] = await (o.forUpdate ? query.for('update') : query);
  return row ? viewOf(row) : null;
}

/** The unit ids of the form's draft and of its live version: only the `review` key of each is read, not the whole definition. */
async function knownUnitIds(tx: Tx, formId: string, liveVersionId: string | null): Promise<Set<string>> {
  const [draft] = await tx.select({ review: sql<unknown>`${formDrafts.draft} -> 'review'` }).from(formDrafts).where(eq(formDrafts.formId, formId)).limit(1);
  const [live] = liveVersionId
    ? await tx.select({ review: sql<unknown>`${formVersions.definition} -> 'review'` }).from(formVersions).where(and(eq(formVersions.id, liveVersionId), eq(formVersions.formId, formId))).limit(1)
    : [];
  return new Set([...reviewUnitIdsOf(draft?.review), ...reviewUnitIdsOf(live?.review)]);
}

const uuidShape = z.uuid();

/**
 * Which of `ids` are unarchived review groups of the caller's org (RLS makes another org's groups invisible).
 *
 * `ReviewSettingsSchema` accepts any opaque id as a `groupId` ("abc", "grp_1"), but `review_groups.id` is a uuid column and
 * Postgres answers a non-uuid in `id in (...)` with 22P02, which aborts the transaction and reaches the caller as a 500.
 * An id that is not a uuid cannot be a group, so it is never sent to the database: it is simply not in the found set, and
 * the caller gets the same 400 as for a group that does not exist.
 */
async function liveGroupIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter((id) => uuidShape.safeParse(id).success);
  if (unique.length === 0) return new Set();
  const rows = await tx.select({ id: reviewGroups.id }).from(reviewGroups).where(and(inArray(reviewGroups.id, unique), isNull(reviewGroups.archivedAt)));
  return new Set(rows.map((r) => r.id));
}

/**
 * A form's review settings: `GET` and `PUT /v1/forms/:id/review` (WP-2.33). They say which of the form's review units are
 * checked, by which group, in which order, whether the unit is required, and what its checker sees. The units themselves
 * (what is reviewed) are in the form definition and are versioned with it; this is the live half (who reviews), stored in
 * `form_review_settings` with a revision, like the access settings. Changing it changes who reviews the responses that
 * arrive afterwards: a response already under review keeps the group and order it was opened with.
 *
 * Reading needs `forms.read`, saving `ops.manage` (and RLS repeats it: `form_review_settings_ops_*`). A save names the
 * revision it read in `If-Match` (428 without, 409 when it is stale), is parsed with the strict `ReviewSettings` twin, and
 * is refused (400) when a unit is not in the draft's or the live version's review units, is assigned twice, or names a
 * group that is not an unarchived group of this org. Every form lookup runs under RLS, so a form of another org is a 404.
 */
export function registerReviewSettings(app: FastifyInstance, deps: ReviewModuleDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/forms/:id/review',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags: ['reviews'],
        summary: "Read a form's review settings",
        description:
          'The stored settings, or the defaults (review off, no units, `rev` 0) for a form that was never set up. The `ETag` is the revision to send back in `If-Match`.',
        security: REVIEW_SECURITY,
        params: idParam,
        response: { 200: settingsView },
      },
    },
    async (request, reply) => {
      const view = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        await requireForm(tx, request.params.id);
        return (await loadSettings(tx, request.params.id)) ?? REVIEW_DEFAULTS;
      });
      reply.header('etag', etag(view.rev));
      reply.header('cache-control', 'no-store');
      return view;
    },
  );

  r.put(
    '/v1/forms/:id/review',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['reviews'],
        summary: "Save a form's review settings",
        description:
          'Replaces the settings if `If-Match` names the revision that was read, else 409 `REVIEW_SETTINGS_CONFLICT`; without it, 428. Each unit named must be in the form’s draft or live version, once, with an unarchived group of this org (400 otherwise). Each save bumps the revision and writes `review.settings_updated` with the keys that changed.',
        security: REVIEW_SECURITY,
        params: idParam,
        body: ReviewSettingsSchema,
        response: { 200: settingsView },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const expected = expectedRev(request.headers['if-match']);
      const next = request.body;
      const who = auditClient(deps, request);
      const outcome = await withTenant(deps.db, tenant, async (tx): Promise<{ saved: ReviewSettingsView } | { issues: FieldIssue[] }> => {
        const form = await requireForm(tx, id);
        // Locked, so two saves of one form take turns and the second sees the first's revision.
        const before = await loadSettings(tx, id, { forUpdate: true });
        const current = before ?? REVIEW_DEFAULTS;
        const stale = () => new ProblemError('REVIEW_SETTINGS_CONFLICT', 'The review settings changed since you read them. Reload and apply your change again.');
        if (current.rev !== expected) throw stale();

        const issues = assignmentIssues(next.units, { known: await knownUnitIds(tx, id, form.liveVersionId), groups: await liveGroupIds(tx, next.units.map((u) => u.groupId)) });
        if (issues.length > 0) return { issues };

        const stored = { enabled: next.enabled, distinctCheckers: next.distinctCheckers, units: next.units };
        const by = accountOf(request).userId;
        let rev: number;
        if (before === null) {
          // The org comes from the caller's membership, never from the request.
          const [row] = await tx
            .insert(formReviewSettings)
            .values({ formId: id, orgId: tenant.orgId, enabled: next.enabled, settings: stored, updatedBy: by, updatedAt: deps.now() })
            .onConflictDoNothing()
            .returning({ rev: formReviewSettings.rev });
          if (!row) throw stale();
          rev = row.rev;
        } else {
          const [row] = await tx
            .update(formReviewSettings)
            .set({ rev: sql`${formReviewSettings.rev} + 1`, enabled: next.enabled, settings: stored, updatedBy: by, updatedAt: deps.now() })
            .where(and(eq(formReviewSettings.formId, id), eq(formReviewSettings.rev, before.rev)))
            .returning({ rev: formReviewSettings.rev });
          if (!row) throw stale();
          rev = row.rev;
        }
        // The keys and counts only: never an answer (there is none here), and not the group ids either.
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'review.settings_updated',
          resourceType: 'form',
          resourceId: id,
          formId: id,
          outcome: 'success',
          metadata: { changedKeys: changedKeys(current, next), rev, units: next.units.length },
        });
        return { saved: { rev, ...stored } };
      });
      if ('issues' in outcome) return sendProblem(reply, 'VALIDATION_FAILED', 'The review settings name a unit or a group that does not exist.', outcome.issues);
      reply.header('etag', etag(outcome.saved.rev));
      return outcome.saved;
    },
  );
}
