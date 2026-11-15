import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  audit,
  auditActor,
  auditReads,
  formFiles,
  formVersions,
  forms,
  memberships,
  orgSettings,
  REVIEW_DECISIONS,
  REVIEW_REASON_CODES,
  REVIEW_STATES,
  REVIEW_VISIBILITIES,
  reviewDecide,
  reviewDecisions,
  reviewGroupMembers,
  reviewGroups,
  reviewerScope,
  SUBMISSION_STATUSES,
  submissionKey,
  submissionReviews,
  submissions,
  users,
  withTenant,
  type ReadClient,
  type ReviewDecideOutcome,
  type SubmissionStatus,
  type TenantCtx,
  type Tx,
} from '@form/db';
import { visibleBlocksForReviewer } from '@form/logic';
import type { BlockId, CompiledForm, ReviewGroupId, ReviewSettings, ReviewUnitAssignment, ReviewUnitId } from '@form/schema';
import { z } from 'zod';
import { accountOf, memberOf, tenantOf } from '../../auth.ts';
import { ProblemError, type ProblemCode } from '../../errors.ts';
import { detailFieldsOf, createPlanLoader, maskedAnswersOf, MASK, type PlanLoader } from '../../submissions/plans.ts';
import { uuidv7 } from '../../uuid7.ts';
import { answersHashToken, rawHashOfToken, unmatchableHash } from './answersToken.ts';
import type { ReviewModuleDeps } from './context.ts';
import { auditClient, REVIEW_SECURITY } from './http.ts';
import { finaliseOnDecision } from './open.ts';
import { unitNames } from './queue.ts';

/*
 * A checker's side of a held response (WP-2.33):
 *
 *   GET  /v1/forms/:formId/submissions/:id/review
 *        the response as its checker may see it: each review unit and where it stands, the decisions so far, and the
 *        answers with `own_unit` redaction applied on the server. Every read is audited (`submission.viewed`).
 *   POST /v1/forms/:formId/submissions/:id/review/units/:unitId/decisions
 *        approve or reject one unit. `review_decide()` makes the decision and is the guarantee of every rule; this route
 *        runs the checks that need the session (two-factor sign-in), writes the audit records in the same transaction as
 *        the decision, releases the response when the decision made it `complete`, and turns each refusal into its problem
 *        code and a denied `review.decided` record on the audit connection.
 */

const SECURITY = REVIEW_SECURITY;
const TAGS = ['reviews'];
const MAX_UNIT_ID = 64;

const submissionParams = z.object({ formId: z.uuid(), id: z.uuid() });
const decisionParams = z.object({ formId: z.uuid(), id: z.uuid(), unitId: z.string().min(1).max(MAX_UNIT_ID) });
/** Visible ASCII, 1 to 255 characters: the `review_decisions.idempotency_key` column's own limit. The builder sends a uuid. */
const idempotencyHeaders = z.object({ 'idempotency-key': z.string().regex(/^[\x21-\x7e]{1,255}$/, 'a key of 1 to 255 visible characters, the same for every retry of one decision') });

const HASH_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * What a checker sends: the decision, the reason (from the fixed catalogue, required to reject, never given to approve) and
 * the token of the unit's answers as they read them (`units[].answersHash` of the review detail), so the decision is about
 * exactly what they saw. The token is keyed (`answersToken.ts`), not the unit's sha256: the digest of answers a caller may not
 * read would let them test guesses at them. Nothing else is accepted: not a user, an org, a time or an id.
 */
export const decisionBody = z
  .strictObject({
    decision: z.enum(REVIEW_DECISIONS),
    reasonCode: z.enum(REVIEW_REASON_CODES).optional(),
    answersHash: z.string().regex(HASH_HEX, 'the 64 hex digits of the unit’s answersHash, as the review detail gave them'),
  })
  .superRefine((body, ctx) => {
    if (body.decision === 'reject' && body.reasonCode === undefined) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'a reject needs a reason code' });
    if (body.decision === 'approve' && body.reasonCode !== undefined) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'an approve has no reason code' });
  });

const isoInstant = z.iso.datetime({ offset: true });
const decidedStatus = z.enum(SUBMISSION_STATUSES);

export const decisionResponse = z.object({
  decisionId: z.uuid(),
  unitId: z.string(),
  decision: z.enum(REVIEW_DECISIONS),
  reasonCode: z.enum(REVIEW_REASON_CODES).nullable(),
  round: z.number().int(),
  decidedAt: isoInstant,
  /** `approved` or `rejected`. */
  unitState: z.enum(REVIEW_STATES),
  /** `complete` or `rejected` when this decision settled the response, else `pending_review`. For a replay, as it stands now. */
  submissionStatus: decidedStatus,
});

const reviewUnitView = z.object({
  unitId: z.string(),
  name: z.string(),
  state: z.enum(REVIEW_STATES),
  round: z.number().int(),
  required: z.boolean(),
  order: z.number().int(),
  groupId: z.uuid(),
  groupName: z.string().nullable(),
  visibility: z.enum(REVIEW_VISIBILITIES),
  /** You are an active member of the group this unit was opened with. */
  yours: z.boolean(),
  /**
   * A hint for the buttons: you are a checker of this unit, it is open, nothing of a lower order is open and nothing
   * bars you under the four-eyes rule. The decision is checked again by `review_decide()`, which has the last word.
   */
  canDecide: z.boolean(),
  /** An earlier required unit is still open. */
  blocked: z.boolean(),
  /**
   * What a decision on this unit names (64 hex digits): a keyed token of the unit's answers as they stand, not their digest.
   * It is only good for this response, unit and round, and only until the answers change. Null when `own_unit` hides this
   * unit's answers from you.
   */
  answersHash: z.string().nullable(),
  rev: z.number().int(),
});

const reviewDecisionView = z.object({
  id: z.uuid(),
  unitId: z.string(),
  round: z.number().int(),
  decision: z.enum(REVIEW_DECISIONS),
  reasonCode: z.enum(REVIEW_REASON_CODES).nullable(),
  decidedAt: isoInstant,
  decidedBy: z.object({ userId: z.uuid(), name: z.string().nullable() }),
});

const reviewField = z.object({ id: z.string(), key: z.string(), label: z.string(), type: z.string(), value: z.string(), masked: z.boolean() });
const reviewFile = z.object({
  /** Null for a file in a masked field: it cannot be fetched from here until it can be revealed. */
  id: z.uuid().nullable(),
  blockId: z.string(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nullable(),
  purpose: z.enum(['file', 'signature']),
  masked: z.boolean(),
});

export const reviewDetailResponse = z.object({
  submission: z.object({
    id: z.uuid(),
    formId: z.uuid(),
    formTitle: z.string(),
    receivedAt: isoInstant,
    status: decidedStatus,
    versionId: z.uuid(),
    versionNumber: z.number().int().nullable(),
    locale: z.string(),
  }),
  /** True when `own_unit` hides some of the response from you: `fields`, `answers` and `files` hold your units and what no unit covers, and nothing else. */
  redacted: z.boolean(),
  units: z.array(reviewUnitView),
  decisions: z.array(reviewDecisionView),
  fields: z.array(reviewField),
  answers: z.record(z.string(), z.unknown()),
  files: z.array(reviewFile),
});
export type ReviewDetail = z.infer<typeof reviewDetailResponse>;

/* ─── the rules that do not need the database ─────────────────────────────────────────────────────────────────── */

/**
 * Whether a session used a second factor: the level of a session is its first factor, then `+` and the second one
 * (`pwd+totp`, `link+recovery`). A session of the development header has none to read, so the caller passes `null` and
 * the check is left to `review_decide()`, which looks at the user's own enrolment.
 */
export function hasSecondFactor(mfaLevel: string): boolean {
  return mfaLevel.includes('+');
}

/** How each refusal of `review_decide()` reaches the caller. `not_found` is a plain 404 and is not audited as a denial. */
const REFUSALS = {
  permission_denied: { code: 'FORBIDDEN', detail: 'Requires submissions.review.' },
  idempotency_key_reused: { code: 'IDEMPOTENCY_KEY_REUSED', detail: 'This Idempotency-Key was already used for a different decision.' },
  not_in_group: { code: 'NOT_IN_REVIEW_GROUP', detail: 'You are not an active member of the group that checks this unit.' },
  mfa_required: { code: 'MFA_REQUIRED', detail: 'Your organisation requires two-factor sign-in to check responses. Turn it on, sign in again, and retry.' },
  review_closed: { code: 'REVIEW_CLOSED', detail: 'This unit is not waiting for a decision any more.' },
  order_blocked: { code: 'REVIEW_ORDER_BLOCKED', detail: 'An earlier required unit has to be approved first.' },
  review_stale: { code: 'REVIEW_STALE', detail: 'The answers of this unit changed since you read them. Reload and read them again.' },
  four_eyes_violation: { code: 'FOUR_EYES_VIOLATION', detail: 'You cannot decide a unit you filled in or changed, or one that is about you.' },
} as const satisfies Record<Exclude<ReviewDecideOutcome, 'decided' | 'not_found'>, { code: ProblemCode; detail: string }>;

/** Every outcome of `review_decide()` but `decided` and `not_found`: the compiler checks that `REFUSALS` has an entry for each. */
export type Refusal = Exclude<ReviewDecideOutcome, 'decided' | 'not_found'>;

/**
 * The problem of a refusal. A 403 is audited by this route as a denied `review.decided` (which says which rule refused),
 * so the error handler is told not to add its own generic `request.authorize` record for it.
 */
export function refusalProblem(outcome: Refusal): ProblemError {
  const { code, detail } = REFUSALS[outcome];
  return new ProblemError(code, detail, undefined, { audited: true });
}

/** One unit of the response as `submission_reviews` holds it, with the fields the checker's view needs. */
export interface UnitRow {
  unitId: string;
  state: (typeof REVIEW_STATES)[number];
  required: boolean;
  reviewOrder: number;
  groupId: string;
  visibility: (typeof REVIEW_VISIBILITIES)[number];
  makerUserId: string | null;
  lastEditorId: string | null;
  excludedUserIds: readonly string[];
}

/** Whether a required unit of a lower order is still open, which blocks this one (the test of `review_decide()`, `order_blocked`). */
export function isBlocked(unit: Pick<UnitRow, 'reviewOrder'>, units: readonly Pick<UnitRow, 'required' | 'reviewOrder' | 'state'>[]): boolean {
  return units.some((o) => o.required && o.reviewOrder < unit.reviewOrder && o.state !== 'approved' && o.state !== 'not_applicable');
}

/**
 * The hint behind `canDecide`: the checks of `review_decide()` that can be told from rows the caller may read, in the order
 * that function makes them (group, then open, order, four-eyes). It is a hint for the buttons and nothing more.
 */
export function canDecideHint(
  o: { userId: string; submissionStatus: SubmissionStatus; yours: boolean; blocked: boolean; distinctCheckers: boolean; decidedElsewhere: boolean },
  unit: Pick<UnitRow, 'state' | 'makerUserId' | 'lastEditorId' | 'excludedUserIds'>,
): boolean {
  if (!o.yours || unit.state !== 'pending' || o.submissionStatus !== 'pending_review' || o.blocked) return false;
  if (unit.makerUserId === o.userId || unit.lastEditorId === o.userId || unit.excludedUserIds.includes(o.userId)) return false;
  return !(o.distinctCheckers && o.decidedElsewhere);
}

/**
 * Who is a checker of what, for redaction: today's assignments of the form (`ReviewSettings`) and the assignments the
 * response's own review rows were opened with. The settings are live and the rows are copies, so after a reassignment the
 * old group still decides the response it was asked about. A caller who is a checker under either one is a reviewer of the
 * response, and `own_unit` of either one redacts them: reading the settings alone would show a checker the whole response
 * as soon as their unit was given to another group.
 */
export function assignmentsOf(live: ReviewSettings | null, rows: readonly UnitRow[]): ReviewUnitAssignment[] {
  const opened = rows.map((r): ReviewUnitAssignment => ({ unitId: r.unitId as ReviewUnitId, groupId: r.groupId as ReviewGroupId, order: r.reviewOrder, required: r.required, visibility: r.visibility }));
  return [...(live?.units ?? []), ...opened];
}

/** The answers a checker may see: all of them, or only those of the blocks `visibleBlocksForReviewer` allows (a block it does not know is hidden). */
export function redactAnswers(answers: Record<string, unknown>, visible: ReadonlySet<BlockId> | null): Record<string, unknown> {
  if (visible === null) return answers;
  return Object.fromEntries(Object.entries(answers).filter(([blockId]) => visible.has(blockId as BlockId)));
}

/* ─── the review detail ───────────────────────────────────────────────────────────────────────────────────────── */

interface DetailDeps {
  db: ReviewModuleDeps['db'];
  plans: PlanLoader;
  /** Keys the `answersHash` tokens (`config.auth.secret`). */
  secret: Uint8Array;
}

/** Whether checkers of this org must have used two-factor sign-in (`org_settings.review_checkers_mfa`); on when the org has no row. */
async function checkersNeedMfa(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = await tx.select({ on: orgSettings.reviewCheckersMfa }).from(orgSettings).where(eq(orgSettings.orgId, orgId)).limit(1);
  return row?.on ?? true;
}

/**
 * The unit's raw answers hash that a decision's `answersHash` token stands for, to give to `review_decide()`.
 *
 * The token (`answersToken.ts`) is checked here, in the decision's own transaction, against the hash the unit holds now and
 * against the one the first decision with the same Idempotency-Key named (so a retry made after the unit's answers changed is
 * still a replay and not a "key reused"). A token that matches neither (forged, made for another unit, round or response, or
 * for answers that have changed) gets a hash that is nobody's: `review_decide()` then makes its other checks in its own order and
 * ends in `review_stale`, which is also what it answers for a hash that was once right and no longer is. `review_decide()` still
 * compares the hash it is given under its lock, so a change between this read and the decision is `review_stale` as before.
 */
async function rawAnswersHash(
  tx: Tx,
  secret: Uint8Array,
  o: { orgId: string; submissionId: string; receivedAt: Date; unitId: string; idempotencyKey: string; token: string },
): Promise<Uint8Array> {
  const [unit] = await tx
    .select({ round: submissionReviews.round, answersHash: submissionReviews.answersHash })
    .from(submissionReviews)
    .where(and(eq(submissionReviews.submissionId, o.submissionId), eq(submissionReviews.submissionReceivedAt, o.receivedAt), eq(submissionReviews.unitId, o.unitId)))
    .limit(1);
  const [first] = await tx
    .select({ round: reviewDecisions.round, answersHash: reviewDecisions.answersHash })
    .from(reviewDecisions)
    .where(
      and(
        eq(reviewDecisions.idempotencyKey, o.idempotencyKey),
        eq(reviewDecisions.submissionId, o.submissionId),
        eq(reviewDecisions.submissionReceivedAt, o.receivedAt),
        eq(reviewDecisions.unitId, o.unitId),
      ),
    )
    .limit(1);
  for (const known of [unit, first]) {
    if (!known) continue;
    const raw = rawHashOfToken(secret, { orgId: o.orgId, submissionId: o.submissionId, unitId: o.unitId, round: known.round }, o.token, [known.answersHash]);
    if (raw) return raw;
  }
  return unmatchableHash();
}

async function readReviewDetail(deps: DetailDeps, tenant: TenantCtx, client: ReadClient, formId: string, id: string): Promise<ReviewDetail> {
  const userId = tenant.userId;
  if (!userId) throw new ProblemError('UNAUTHENTICATED');
  // Read-write: the read is audited in the same transaction (C-M9).
  return withTenant(deps.db, tenant, async (tx) => {
    // By id and the partition key it implies, so one partition is read; RLS makes another org's response not exist.
    const [row] = await tx
      .select({
        id: submissions.id,
        receivedAt: submissions.receivedAt,
        formId: submissions.formId,
        versionId: submissions.formVersionId,
        status: submissions.status,
        answers: submissions.answers,
        meta: submissions.meta,
      })
      .from(submissions)
      .where(and(eq(submissions.formId, formId), submissionKey(id)))
      .limit(1);
    if (!row) throw new ProblemError('NOT_FOUND', 'That response is not on this form.');

    const [form] = await tx.select({ title: forms.title }).from(forms).where(eq(forms.id, formId)).limit(1);
    const unitRows = await tx
      .select()
      .from(submissionReviews)
      .where(and(eq(submissionReviews.submissionId, row.id), eq(submissionReviews.submissionReceivedAt, row.receivedAt)))
      .orderBy(asc(submissionReviews.reviewOrder), asc(submissionReviews.unitId));
    const decisionRows = await tx
      .select({
        id: reviewDecisions.id,
        unitId: reviewDecisions.unitId,
        round: reviewDecisions.round,
        decision: reviewDecisions.decision,
        reasonCode: reviewDecisions.reasonCode,
        decidedAt: reviewDecisions.decidedAt,
        decidedBy: reviewDecisions.decidedBy,
        name: users.name,
      })
      .from(reviewDecisions)
      .leftJoin(users, eq(users.id, reviewDecisions.decidedBy))
      .where(and(eq(reviewDecisions.submissionId, row.id), eq(reviewDecisions.submissionReceivedAt, row.receivedAt)))
      .orderBy(asc(reviewDecisions.decidedAt), asc(reviewDecisions.id));

    // Who the caller is, as a reviewer of this form: the settings' groups, and the groups the response's own rows name.
    const scope = await reviewerScope(tx, { formId, userId });
    const rowGroupIds = [...new Set(unitRows.map((u) => u.groupId))];
    const inRowGroups =
      rowGroupIds.length === 0
        ? []
        : await tx
            .select({ groupId: reviewGroupMembers.groupId })
            .from(reviewGroupMembers)
            .innerJoin(memberships, and(eq(memberships.orgId, reviewGroupMembers.orgId), eq(memberships.userId, reviewGroupMembers.userId)))
            .where(and(eq(reviewGroupMembers.userId, userId), inArray(reviewGroupMembers.groupId, rowGroupIds), eq(memberships.status, 'active')));
    const groups = new Set<string>([...scope.groupIds, ...inRowGroups.map((g) => g.groupId)]);
    const groupNames = new Map(
      rowGroupIds.length === 0 ? [] : (await tx.select({ id: reviewGroups.id, name: reviewGroups.name }).from(reviewGroups).where(inArray(reviewGroups.id, rowGroupIds))).map((g) => [g.id, g.name] as const),
    );

    const [version] = await tx.select({ compiled: formVersions.compiled }).from(formVersions).where(eq(formVersions.id, row.versionId)).limit(1);
    const plan = await deps.plans.ofVersion(tx, row.versionId);
    const names = (await unitNames(tx, [row.versionId])).get(row.versionId);

    // null: nothing is hidden from this caller. Otherwise the blocks they may see; any block not in the set is hidden.
    const compiled = (version?.compiled ?? {}) as unknown as CompiledForm;
    const visible = visibleBlocksForReviewer(compiled, { units: assignmentsOf(scope.settings, unitRows) }, groups as Set<ReviewGroupId>);
    const answers = redactAnswers(row.answers, visible);

    const held = await tx
      .select({ id: formFiles.id, blockId: formFiles.blockId, name: formFiles.name, mime: formFiles.mime, sizeBytes: formFiles.sizeBytes, purpose: formFiles.purpose })
      .from(formFiles)
      .where(and(eq(formFiles.formId, formId), eq(formFiles.submissionId, row.id), eq(formFiles.submissionReceivedAt, row.receivedAt)))
      .orderBy(asc(formFiles.createdAt), asc(formFiles.id));

    await auditReads.detail(tx, tenant, { formId, submissionId: row.id, client });

    const distinct = scope.settings?.distinctCheckers ?? false;
    const units = unitRows.map((u) => {
      const yours = groups.has(u.groupId);
      const blocked = isBlocked(u, unitRows);
      const decidedElsewhere = decisionRows.some((d) => d.decidedBy === userId && d.unitId !== u.unitId);
      return {
        unitId: u.unitId,
        name: names?.get(u.unitId) || u.unitId,
        state: u.state,
        round: u.round,
        required: u.required,
        order: u.reviewOrder,
        groupId: u.groupId,
        groupName: groupNames.get(u.groupId) ?? null,
        visibility: u.visibility,
        yours,
        canDecide: canDecideHint({ userId, submissionStatus: row.status, yours, blocked, distinctCheckers: distinct, decidedElsewhere }, u),
        blocked,
        // The token, never the digest: the unit's answers include ones the caller sees only masked (protected fields) or not at all
        // (a block of their own unit derived from another unit's answers), and a plain sha256 of them would let them test a guess
        // offline. It is theirs only for their own units, since a token for answers they may not read is of no use to them either.
        answersHash: visible === null || yours ? answersHashToken(deps.secret, { orgId: tenant.orgId, submissionId: row.id, unitId: u.unitId, round: u.round }, u.answersHash) : null,
        rev: u.rev,
      };
    });

    return {
      submission: {
        id: row.id,
        formId: row.formId,
        formTitle: form?.title ?? '',
        receivedAt: row.receivedAt.toISOString(),
        status: row.status,
        versionId: row.versionId,
        versionNumber: plan?.number ?? null,
        locale: typeof row.meta['locale'] === 'string' ? row.meta['locale'] : 'en-IN',
      },
      redacted: visible !== null,
      units,
      decisions: decisionRows.map((d) => ({
        id: d.id,
        unitId: d.unitId,
        round: d.round,
        decision: d.decision,
        reasonCode: d.reasonCode,
        decidedAt: d.decidedAt.toISOString(),
        decidedBy: { userId: d.decidedBy, name: d.name },
      })),
      fields: detailFieldsOf(plan, answers),
      answers: maskedAnswersOf(plan, answers),
      files: held
        // A file of a block the caller may not see is not even listed: its existence is part of that unit's answers.
        .filter((file) => visible === null || visible.has(file.blockId as BlockId))
        .map((file) => {
          // A file in a protected field is listed, but neither named nor fetchable from here (WP-1.14, WP-1.11 reveal it).
          const masked = plan?.byId.get(file.blockId)?.masked ?? true;
          return masked
            ? { id: null, blockId: file.blockId, name: MASK, mime: '', sizeBytes: null, purpose: file.purpose, masked: true }
            : { id: file.id, blockId: file.blockId, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, purpose: file.purpose, masked: false };
        }),
    };
  });
}

/* ─── routes ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The review detail and the decision of a unit (WP-2.33), described at the top of the file.
 *
 * **Decide.** Needs `submissions.review` (and RLS and `review_decide()` repeat it). `Idempotency-Key` is required: a retry
 * with the same key and the same decision returns the first decision (`Idempotent-Replayed: true`), writes nothing and
 * sends nothing; the key for any other decision is 422. The decision, its `review.decided` record and, when it settles the
 * response, `review.finalised` and the one `submission.fanout` job (`released`) are one transaction. A refusal writes
 * nothing there; it leaves a denied `review.decided` on the audit connection and answers with its problem code:
 * 403 `FOUR_EYES_VIOLATION`, `NOT_IN_REVIEW_GROUP`, `MFA_REQUIRED`; 409 `REVIEW_STALE`, `REVIEW_ORDER_BLOCKED`,
 * `REVIEW_CLOSED`; 422 `IDEMPOTENCY_KEY_REUSED`. A response or unit of another org, or one that is not on this form, is 404.
 *
 * Two-factor sign-in is checked first from the session (`mfaLevel`), where the org requires it: `review_decide()` can only
 * see whether the user has enrolled, not whether this session used it, and a session of the development header has no
 * level to read, so for it the function's check stands alone.
 *
 * **Detail.** Needs `submissions.review` or `submissions.read`. The answers a caller may not see are left out on the
 * server (`visibleBlocksForReviewer`), and so are the files, the unit hashes and everything derived from them: `own_unit`
 * applies to anyone who is a checker of a unit of this form (owners and admins too) and to nobody else. `computed`
 * (variables, fired rules) is never sent. The read is audited as `submission.viewed`.
 */
export function registerReviewDecide(app: FastifyInstance, deps: ReviewModuleDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const plans = createPlanLoader();

  r.get(
    '/v1/forms/:formId/submissions/:id/review',
    {
      // Either permission lets the caller read, which `config.perm` cannot say, so the check is below and is audited the same way.
      config: { auth: 'user' },
      schema: {
        tags: TAGS,
        summary: 'A response for review: its units, the decisions so far and the answers you may see',
        description:
          'Each review unit with its state, its group, whether it is yours and whether you may decide it now, the decision history (who, when, which reason code) and the answers. ' +
          'If you are a checker of a unit of this form, `own_unit` redaction applies to you whatever your role: only your units’ answers and the blocks no unit covers come back (`redacted: true`), with no files, hashes or computed values of the others. ' +
          'A member in no review group sees the whole response. Encrypted and sensitive answers are masked. Needs `submissions.review` or `submissions.read`; each read is audited (`submission.viewed`).',
        security: SECURITY,
        params: submissionParams,
        response: { 200: reviewDetailResponse },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const { perms } = memberOf(request);
      if (!perms.includes('submissions.review') && !perms.includes('submissions.read')) {
        throw new ProblemError('FORBIDDEN', 'Requires submissions.review or submissions.read.', {
          orgId: tenant.orgId,
          actorId: tenant.userId ?? null,
          reason: 'missing_permission:submissions.review|submissions.read',
        });
      }
      const info = auditClient(deps, request);
      reply.header('cache-control', 'no-store');
      return readReviewDetail({ db: deps.db, plans, secret: deps.secret }, tenant, { sessionId: info.sessionId, actorIpHash: info.actorIpHash, actorUa: info.actorUa }, request.params.formId, request.params.id);
    },
  );

  r.post(
    '/v1/forms/:formId/submissions/:id/review/units/:unitId/decisions',
    {
      config: { auth: 'user', perm: 'submissions.review' },
      schema: {
        tags: TAGS,
        summary: 'Approve or reject one review unit of a held response',
        description:
          '`Idempotency-Key` is required (400 without it): a retry with the same key and body returns the first decision (`Idempotent-Replayed: true`) and does nothing more; the key for another decision is 422 `IDEMPOTENCY_KEY_REUSED`. ' +
          '`answersHash` is the token of the unit’s answers you read, exactly as the review detail gave it (`units[].answersHash`; it is keyed to this response, unit and round, not a digest you could compute): if the answers changed since, or it is any other value, 409 `REVIEW_STALE`. A reject needs a `reasonCode` (`incomplete`, `incorrect`, `missing_document`, `duplicate`, `other`). ' +
          'Refusals: 403 `FOUR_EYES_VIOLATION` (you filled in or changed the unit, it is about you, or with distinct checkers you decided another unit), `NOT_IN_REVIEW_GROUP`, `MFA_REQUIRED` (the org requires two-factor sign-in); 409 `REVIEW_STALE`, `REVIEW_ORDER_BLOCKED`, `REVIEW_CLOSED`. Each is also a denied `review.decided` record. ' +
          'When the last required unit is approved the response becomes `complete` and is released to its notifications and webhooks once; a required reject makes it `rejected` and sends nothing.',
        security: SECURITY,
        params: decisionParams,
        headers: idempotencyHeaders,
        body: decisionBody,
        response: { 200: decisionResponse },
      },
    },
    async (request, reply) => {
      const { formId, id, unitId } = request.params;
      const key = request.headers['idempotency-key'];
      const { decision, reasonCode, answersHash } = request.body;
      const tenant = tenantOf(request);
      const userId = accountOf(request).userId;
      const who = auditClient(deps, request);
      const session = accountOf(request).session;
      const decisionId = uuidv7(deps.now().getTime());

      type Settled = { refused: Refusal | 'not_found' } | { saved: z.infer<typeof decisionResponse>; replayed: boolean };
      const settled = await withTenant(deps.db, tenant, async (tx): Promise<Settled> => {
        // The response by its own key, on this form (RLS: another org's is not there). Its time is the partition key the function wants.
        const [row] = await tx.select({ receivedAt: submissions.receivedAt }).from(submissions).where(and(eq(submissions.formId, formId), submissionKey(id))).limit(1);
        if (!row) return { refused: 'not_found' };

        if (session !== null && !hasSecondFactor(session.mfaLevel) && (await checkersNeedMfa(tx, tenant.orgId))) return { refused: 'mfa_required' };

        // The token the checker read, turned back into the unit's own hash (or into a hash that is nobody's, which is `review_stale`).
        const rawHash = await rawAnswersHash(tx, deps.secret, { orgId: tenant.orgId, submissionId: id, receivedAt: row.receivedAt, unitId, idempotencyKey: key, token: answersHash });
        const result = await reviewDecide(tx, {
          submissionId: id,
          receivedAt: row.receivedAt,
          unitId,
          decision,
          reasonCode: reasonCode ?? null,
          answersHash: rawHash,
          idempotencyKey: key,
          decisionId,
        });
        // Every other outcome is a refusal that wrote nothing, so this transaction commits nothing and the record of it is made below.
        if (result.outcome !== 'decided') return { refused: result.outcome };
        if (result.decisionId === null || result.unitState === null || result.submissionStatus === null) throw new Error('review_decide() decided without saying what it decided');

        const [saved] = await tx
          .select({ decision: reviewDecisions.decision, reasonCode: reviewDecisions.reasonCode, round: reviewDecisions.round, decidedAt: reviewDecisions.decidedAt })
          .from(reviewDecisions)
          .where(and(eq(reviewDecisions.id, result.decisionId), eq(reviewDecisions.submissionReceivedAt, row.receivedAt)))
          .limit(1);
        if (!saved) throw new Error('the decision that review_decide() wrote cannot be read back');

        // A replay wrote nothing, so it appends nothing and sends nothing: its first call did both.
        if (!result.replayed) {
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: who.sessionId,
            actorIpHash: who.actorIpHash,
            actorUa: who.actorUa,
            action: 'review.decided',
            resourceType: 'submission',
            resourceId: id,
            formId,
            outcome: 'success',
            metadata: { unitId, decision: saved.decision, reasonCode: saved.reasonCode, round: saved.round, decisionId: result.decisionId, unitState: result.unitState, submissionStatus: result.submissionStatus },
          });
          if (result.submissionStatus === 'complete' || result.submissionStatus === 'rejected') {
            await audit.append(tx, tenant.orgId, {
              ...auditActor(tenant),
              sessionId: who.sessionId,
              actorIpHash: who.actorIpHash,
              actorUa: who.actorUa,
              action: 'review.finalised',
              resourceType: 'submission',
              resourceId: id,
              formId,
              outcome: 'success',
              metadata: { status: result.submissionStatus, unitId, decisionId: result.decisionId },
            });
          }
          // One job, in the decision's own transaction: the response is released if and only if the decision stands.
          await finaliseOnDecision(tx, deps.queue, { outcome: result.outcome, submissionStatus: result.submissionStatus, replayed: result.replayed, orgId: tenant.orgId, formId, submissionId: id, receivedAt: row.receivedAt });
        }

        return {
          replayed: result.replayed,
          saved: {
            decisionId: result.decisionId,
            unitId,
            decision: saved.decision,
            reasonCode: saved.reasonCode,
            round: saved.round,
            decidedAt: saved.decidedAt.toISOString(),
            unitState: result.unitState,
            submissionStatus: result.submissionStatus,
          },
        };
      });

      if ('refused' in settled) {
        if (settled.refused === 'not_found') throw new ProblemError('NOT_FOUND', 'That unit is not on a response of this form.');
        // The record of the refusal is written on its own connection, so it stands although this request rolled back (ADR-0006).
        try {
          await audit.appendDetached(deps.auditDb, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: who.sessionId,
            actorIpHash: who.actorIpHash,
            actorUa: who.actorUa,
            action: 'review.decided',
            resourceType: 'submission',
            resourceId: id,
            formId,
            outcome: 'denied',
            reason: settled.refused,
            metadata: { unitId, decision },
          });
        } catch (err) {
          // The refusal stands whether or not its record could be written; the failure is logged (ids only).
          request.log.error({ err, userId }, 'audit record of a refused review decision was not written');
        }
        throw refusalProblem(settled.refused);
      }
      if (settled.replayed) reply.header('idempotent-replayed', 'true');
      reply.header('cache-control', 'no-store');
      return settled.saved;
    },
  );
}
