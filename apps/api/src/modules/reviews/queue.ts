import { and, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { forms, formVersions, isUuid, memberships, reviewGroupMembers, submissionReviews, submissions, withTenant, type Tx } from '@form/db';
import { plainLabelText } from '@form/schema';
import { z } from 'zod';
import { MAX_CURSOR_LENGTH, readCursor, signCursor } from '../../cursor.ts';
import { ProblemError } from '../../errors.ts';
import { storableText } from '../../text-safety.ts';
import { tenantOf } from '../../auth.ts';
import type { ReviewModuleDeps } from './context.ts';
import { REVIEW_SECURITY } from './http.ts';

/*
 * The review queue (WP-2.33): what a checker may decide now, across every form of the org. It lists a unit and never an
 * answer: the form's title, the unit's name, the response's id and age, and the round. Opening a response is the review
 * detail route, which redacts and audits the read.
 *
 * A unit is in the caller's queue when, all at once:
 *   - it is `pending` and its response is still `pending_review` and not in the trash;
 *   - the caller is an active member of the group the unit was opened with (the copy on the review row, not today's
 *     settings: a response under review keeps the group it was opened with); groups are resolved first, so the query
 *     uses the queue index (org, group, newest first);
 *   - no required unit of a lower order is still open (the same test `review_decide()` makes for `order_blocked`);
 *   - the caller is not barred by the four-eyes rule: not the unit's maker or last editor, not a member whose verified
 *     address the respondent gave, and, with `distinctCheckers`, has not decided another unit of the response.
 * The last two are the checks of `review_decide()` too, and the function stays the guarantee: the queue only leaves out what
 * would be refused, so a checker is not shown work they cannot do.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_NAME = 200;
const HOUR_MS = 60 * 60 * 1000;

/** How long a unit must have been waiting (since the response arrived) to pass the `age` filter. */
export const QUEUE_AGES = { '1d': 24, '3d': 72, '7d': 168, '30d': 720 } as const satisfies Record<string, number>;
export type QueueAge = keyof typeof QUEUE_AGES;

const querySchema = z.object({
  formId: z.uuid().optional(),
  unitId: z.string().min(1).max(64).optional(),
  age: z.enum(Object.keys(QUEUE_AGES) as [QueueAge, ...QueueAge[]]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
});

const isoInstant = z.iso.datetime({ offset: true });

const queueItem = z.object({
  submissionId: z.uuid(),
  formId: z.uuid(),
  formTitle: z.string(),
  unitId: z.string(),
  /** The unit's name in the response's own version of the form; the unit id when that version has no such unit. */
  unitName: z.string(),
  round: z.number().int(),
  /** The position of the unit in the form's review (units of one order are checked in parallel). */
  order: z.number().int(),
  required: z.boolean(),
  receivedAt: isoInstant,
  /** Whole seconds since the response arrived, by the server's clock. */
  ageSeconds: z.number().int().min(0),
});

export const queueResponse = z.object({ items: z.array(queueItem), nextCursor: z.string().nullable() });
export type QueueItem = z.infer<typeof queueItem>;

/**
 * Everything that changes which rows come, in which order and for whom, so a cursor cannot be carried to another caller,
 * another org or another filter (the page size is not in it: a client may change `limit` between pages).
 */
export function queueScope(orgId: string, userId: string, f: { formId?: string | undefined; unitId?: string | undefined; age?: QueueAge | undefined }): string {
  return JSON.stringify(['review-queue', orgId, userId, f.formId ?? null, f.unitId ?? null, f.age ?? null]);
}

/** Where the next page starts: after one unit of one response, in the order of the list (newest response first, then unit id). */
export interface QueuePosition {
  receivedAt: string;
  submissionId: string;
  unitId: string;
}

/** The position a cursor holds, or `INVALID_CURSOR` for one this API did not sign for this exact query (never the first page instead). */
export function positionOf(secret: Uint8Array, scope: string, token: string): QueuePosition {
  const bad = () => new ProblemError('INVALID_CURSOR');
  const values = readCursor(secret, scope, token);
  if (!values || values.length !== 3) throw bad();
  const [receivedAt, submissionId, unitId] = values;
  // The time must be exactly what `toISOString()` writes, so a cursor cannot name a moment two ways.
  if (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt)) || new Date(receivedAt).toISOString() !== receivedAt) throw bad();
  if (!isUuid(submissionId) || typeof unitId !== 'string' || unitId.length === 0 || unitId.length > 64) throw bad();
  return { receivedAt, submissionId, unitId };
}

/** The name of each unit, from the `review.units` of the versions the rows were received on: one query for the page (the review detail route reads its one version the same way). */
export async function unitNames(tx: Tx, versionIds: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (versionIds.length === 0) return out;
  const rows = await tx
    .select({ id: formVersions.id, units: sql<unknown>`${formVersions.definition} -> 'review' -> 'units'` })
    .from(formVersions)
    .where(inArray(formVersions.id, [...versionIds]));
  for (const row of rows) {
    const names = new Map<string, string>();
    if (Array.isArray(row.units)) {
      for (const unit of row.units as Array<{ id?: unknown; name?: unknown } | null>) {
        if (typeof unit?.id === 'string') names.set(unit.id, storableText(plainLabelText(unit.name as never)).slice(0, MAX_NAME));
      }
    }
    out.set(row.id, names);
  }
  return out;
}

/**
 * The conditions that make a unit the caller's to decide, besides their group (which the caller resolves first, so the
 * queue index, whose columns are the org and the group, can be used). RLS limits every table to the caller's org already.
 */
function decidableBy(userId: string): SQL {
  const r = submissionReviews;
  return sql`
    ${r.makerUserId} is distinct from ${userId}::uuid
    and ${r.lastEditorId} is distinct from ${userId}::uuid
    and not (${userId}::uuid = any (${r.excludedUserIds}))
    and not exists (select 1 from submission_reviews o
                    where o.submission_id = ${r.submissionId} and o.submission_received_at = ${r.submissionReceivedAt}
                      and o.required and o.review_order < ${r.reviewOrder} and o.state not in ('approved', 'not_applicable'))
    and not (
      exists (select 1 from form_review_settings fs where fs.form_id = ${r.formId} and fs.org_id = ${r.orgId} and fs.settings -> 'distinctCheckers' = 'true'::jsonb)
      and exists (select 1 from review_decisions x
                  where x.submission_id = ${r.submissionId} and x.submission_received_at = ${r.submissionReceivedAt}
                    and x.decided_by = ${userId}::uuid and x.unit_id <> ${r.unitId}))`;
}

/** The groups the caller is an active member of: the units of any other group are not theirs. */
async function groupsOf(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ groupId: reviewGroupMembers.groupId })
    .from(reviewGroupMembers)
    .innerJoin(memberships, and(eq(memberships.orgId, reviewGroupMembers.orgId), eq(memberships.userId, reviewGroupMembers.userId)))
    .where(and(eq(reviewGroupMembers.userId, userId), eq(memberships.status, 'active')));
  return rows.map((row) => row.groupId);
}

/**
 * `GET /v1/reviews/queue` (WP-2.33): the units the caller may decide now, newest response first.
 *
 * Needs `submissions.review`. The list reads the response's own row for its version and status, which row-level security
 * lets through with `submissions.read` (every role that holds `submissions.review` holds it too, in this slice); a caller
 * who somehow had review without read would see an empty queue, never someone else's data. Filters: `formId`, `unitId`
 * and `age` (units whose response is at least that old). Pages by a signed cursor bound to the caller and the filters.
 */
export function registerReviewQueue(app: FastifyInstance, deps: ReviewModuleDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/reviews/queue',
    {
      config: { auth: 'user', perm: 'submissions.review' },
      schema: {
        tags: ['reviews'],
        summary: 'The review units waiting for you',
        description:
          'Open units whose group you are an active member of, whose order is unblocked (no lower-order required unit is still open) and that the four-eyes rule leaves to you, newest response first. ' +
          'Each item holds the form title, the unit name, the response id, its age and the round, never an answer: open the response with `GET /v1/forms/{formId}/submissions/{id}/review`. ' +
          'Filters `formId`, `unitId` and `age` (`1d`, `3d`, `7d`, `30d`: responses at least that old). `nextCursor` is signed and bound to you and the filters: pass it back unchanged, stop when it is null.',
        security: REVIEW_SECURITY,
        querystring: querySchema,
        response: { 200: queueResponse },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const userId = tenant.userId;
      if (!userId) throw new ProblemError('UNAUTHENTICATED');
      const { formId, unitId, age, limit, cursor } = request.query;
      const now = deps.now();
      const scope = queueScope(tenant.orgId, userId, { formId, unitId, age });
      const after = cursor === undefined ? undefined : positionOf(deps.secret, scope, cursor);

      const rv = submissionReviews;
      const conditions: SQL[] = [eq(rv.orgId, tenant.orgId), eq(rv.state, 'pending'), eq(submissions.status, 'pending_review'), isNull(submissions.trashedAt), decidableBy(userId)];
      if (formId) conditions.push(eq(rv.formId, formId));
      if (unitId) conditions.push(eq(rv.unitId, unitId));
      if (age) conditions.push(lte(rv.submissionReceivedAt, new Date(now.getTime() - QUEUE_AGES[age] * HOUR_MS)));
      if (after) {
        // Newest response first, then the larger response id, then the unit id upwards: the three together are unique.
        conditions.push(sql`(
          ${rv.submissionReceivedAt} < ${after.receivedAt}::timestamptz
          or (${rv.submissionReceivedAt} = ${after.receivedAt}::timestamptz and (
            ${rv.submissionId} < ${after.submissionId}::uuid
            or (${rv.submissionId} = ${after.submissionId}::uuid and ${rv.unitId} > ${after.unitId})))
        )`);
      }

      const { rows, names } = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
        const groups = await groupsOf(tx, userId);
        // A member of no group has no unit; there is nothing to look for.
        if (groups.length === 0) return { rows: [], names: new Map<string, Map<string, string>>() };
        const found = await tx
          .select({
            submissionId: rv.submissionId,
            receivedAt: rv.submissionReceivedAt,
            formId: rv.formId,
            formTitle: forms.title,
            versionId: submissions.formVersionId,
            unitId: rv.unitId,
            round: rv.round,
            order: rv.reviewOrder,
            required: rv.required,
          })
          .from(rv)
          .innerJoin(submissions, and(eq(submissions.id, rv.submissionId), eq(submissions.receivedAt, rv.submissionReceivedAt)))
          .innerJoin(forms, and(eq(forms.orgId, rv.orgId), eq(forms.id, rv.formId)))
          .where(and(inArray(rv.groupId, groups), ...conditions))
          .orderBy(desc(rv.submissionReceivedAt), desc(rv.submissionId), rv.unitId)
          .limit(limit + 1);
        return { rows: found, names: await unitNames(tx, [...new Set(found.map((row) => row.versionId))]) };
      });

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      reply.header('cache-control', 'no-store');
      return {
        items: page.map((row) => ({
          submissionId: row.submissionId,
          formId: row.formId,
          formTitle: storableText(row.formTitle),
          unitId: row.unitId,
          unitName: names.get(row.versionId)?.get(row.unitId) || row.unitId,
          round: row.round,
          order: row.order,
          required: row.required,
          receivedAt: row.receivedAt.toISOString(),
          ageSeconds: Math.max(0, Math.floor((now.getTime() - row.receivedAt.getTime()) / 1000)),
        })),
        nextCursor: rows.length > limit && last ? signCursor(deps.secret, scope, [last.receivedAt.toISOString(), last.submissionId, last.unitId]) : null,
      };
    },
  );
}
