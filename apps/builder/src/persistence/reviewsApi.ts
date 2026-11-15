import { z } from 'zod';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * The builder's side of the checker's API (WP-2.33, apps/api/src/modules/reviews/queue.ts and decide.ts): the queue of
 * units that wait for the signed-in member, one held response as its checker may read it, and the decision on one unit.
 * Every call names its org (`X-FR-Org`) and needs `submissions.review` (the detail also lets `submissions.read` in, and
 * redacts what a checker of another unit must not read, on the server).
 *
 * The schemas read only what the screens show. A state or a decision the API adds later is a plain string here, so it
 * does not make every held response unreadable; the screens say it as the API named it.
 */

/** The permission that shows the Reviews entry; the API checks it again on every call. */
export const REVIEW_PERMISSION = 'submissions.review';

/** The fixed catalogue of reasons for a reject (`REVIEW_REASON_CODES` of the API). There are no free-text notes in this slice. */
export const REASON_CODES = ['incomplete', 'incorrect', 'missing_document', 'duplicate', 'other'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** How long a unit must have waited (since its response arrived) to pass the queue's age filter. */
export const QUEUE_AGES = ['1d', '3d', '7d', '30d'] as const;
export type QueueAge = (typeof QUEUE_AGES)[number];

/** Rows asked for in one page of the queue (the API's default; its limit is 200). */
export const QUEUE_PAGE = 50;

const queueItemSchema = z.object({
  submissionId: z.string(),
  formId: z.string(),
  formTitle: z.string(),
  unitId: z.string(),
  /** The unit's name in the response's own version of the form. */
  unitName: z.string(),
  round: z.number(),
  /** Units of one order are checked in parallel; a higher order waits for the lower ones. */
  order: z.number(),
  required: z.boolean(),
  receivedAt: z.string(),
  /** Whole seconds since the response arrived, by the server's clock. */
  ageSeconds: z.number(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

const queueSchema = z.object({ items: z.array(queueItemSchema), nextCursor: z.string().nullable() });
export type QueuePage = z.infer<typeof queueSchema>;

/** What narrows the queue; unset filters are left out of the request. */
export interface QueueFilters {
  formId?: string | undefined;
  unitId?: string | undefined;
  age?: QueueAge | undefined;
}

const unitSchema = z.object({
  unitId: z.string(),
  name: z.string(),
  /** `pending`, `approved`, `rejected`, `not_applicable` or `closed` (another required unit was rejected). */
  state: z.string(),
  round: z.number(),
  required: z.boolean(),
  order: z.number(),
  groupName: z.string().nullable(),
  /** You are a checker of this unit. */
  yours: z.boolean(),
  /** A hint for the buttons; the decision is checked again by the server, which has the last word. */
  canDecide: z.boolean(),
  /** An earlier required unit is still open. */
  blocked: z.boolean(),
  /** What a decision names: a keyed token of the unit's answers as read, never their digest. Null when the unit's answers are hidden from you. */
  answersHash: z.string().nullable(),
});
export type ReviewUnit = z.infer<typeof unitSchema>;

const decisionSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  round: z.number(),
  decision: z.string(),
  reasonCode: z.string().nullable(),
  decidedAt: z.string(),
  decidedBy: z.object({ userId: z.string(), name: z.string().nullable() }),
});
export type ReviewDecisionRow = z.infer<typeof decisionSchema>;

const fieldSchema = z.object({ id: z.string(), key: z.string(), label: z.string(), type: z.string(), value: z.string(), masked: z.boolean() });
const fileSchema = z.object({
  /** Null for a file in a protected field: it cannot be fetched from here. */
  id: z.string().nullable(),
  blockId: z.string(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().nullable(),
  purpose: z.string(),
  masked: z.boolean(),
});

const detailSchema = z.object({
  submission: z.object({ id: z.string(), formId: z.string(), formTitle: z.string(), receivedAt: z.string(), status: z.string(), versionNumber: z.number().nullable(), locale: z.string() }),
  /** True when `own_unit` hides some of the response from you: `fields` and `files` hold your units' and what no unit covers. */
  redacted: z.boolean(),
  units: z.array(unitSchema),
  decisions: z.array(decisionSchema),
  fields: z.array(fieldSchema),
  files: z.array(fileSchema),
});
/** A held response as its checker may read it: the units and where they stand, the history, and the answers the server let through. */
export type ReviewDetail = z.infer<typeof detailSchema>;

const decidedSchema = z.object({
  decisionId: z.string(),
  unitId: z.string(),
  decision: z.string(),
  reasonCode: z.string().nullable(),
  round: z.number(),
  decidedAt: z.string(),
  /** `approved` or `rejected`. */
  unitState: z.string(),
  /** `complete` or `rejected` when this decision settled the response, else `pending_review`. */
  submissionStatus: z.string(),
});
/** What a decision did. */
export type Decided = z.infer<typeof decidedSchema>;

const orgSchema = z.object({ permissions: z.array(z.string()) });

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

/** The path of the queue with its filters; empty filters and the first page's missing cursor are left out. */
export function queuePath(filters: QueueFilters, cursor?: string | null): string {
  const params = new URLSearchParams({ limit: String(QUEUE_PAGE) });
  if (filters.formId) params.set('formId', filters.formId);
  if (filters.unitId) params.set('unitId', filters.unitId);
  if (filters.age) params.set('age', filters.age);
  if (cursor) params.set('cursor', cursor);
  return `/v1/reviews/queue?${params.toString()}`;
}

/**
 * One page of the units that wait for the member (newest response first). `cursor` is the API's signed `nextCursor`, passed
 * back unchanged with the same filters: the API refuses it for any other caller, org or filter.
 */
export async function getReviewQueue(org: string, filters: QueueFilters, cursor?: string | null): Promise<QueuePage> {
  return read(await orgCall(org, 'GET', queuePath(filters, cursor)), queueSchema);
}

const submissionUrl = (formId: string, submissionId: string) => `/v1/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}`;

/** One held response for review. Every read is audited by the server (`submission.viewed`), so the screens ask for it when the member opens a response and after a decision, not on a timer. */
export async function getReviewDetail(org: string, formId: string, submissionId: string): Promise<ReviewDetail> {
  return read(await orgCall(org, 'GET', `${submissionUrl(formId, submissionId)}/review`), detailSchema);
}

/** Whether the member's role in `org` carries `submissions.review` (`GET /v1/org` lists what it grants). */
export async function canReviewIn(org: string): Promise<boolean> {
  return read(await orgCall(org, 'GET', '/v1/org'), orgSchema).permissions.includes(REVIEW_PERMISSION);
}

/** What one click decides: which unit of which response, and what the member read. */
export interface DecisionRequest {
  org: string;
  formId: string;
  submissionId: string;
  unitId: string;
  decision: 'approve' | 'reject';
  /** The reason of a reject (required); an approve has none, and the API refuses one. */
  reasonCode?: ReasonCode | undefined;
  /** `units[].answersHash` of the review detail the member read. */
  answersHash: string;
}

/** The body the API takes: no user, org, time or id of ours, and a reason only for a reject. */
function bodyOf(request: DecisionRequest): Record<string, unknown> {
  return { decision: request.decision, ...(request.decision === 'reject' && request.reasonCode ? { reasonCode: request.reasonCode } : {}), answersHash: request.answersHash };
}

/** A key for one click, which the retries of that click send again. */
export function newDecisionKey(): string {
  return crypto.randomUUID();
}

/**
 * Whether the API may have stored a decision that got no answer: it was unreachable, or it (or a gateway in front of it)
 * failed with a 5xx after the work may have been done. The click is then not finished, and its retry must send the same
 * `Idempotency-Key` so the API returns the decision it made instead of a second one. Every other outcome (a decision, a
 * refusal) is final.
 */
export const isIndeterminate = (err: unknown): boolean => err instanceof ApiUnreachable || (err instanceof ApiProblem && err.status >= 500);

export interface Decider {
  /** Sends the decision. A retry of the same decision after an unanswered call reuses its key; anything else gets a fresh one. */
  decide(request: DecisionRequest): Promise<Decided>;
}

/**
 * The decisions one screen makes. A click that got no answer is kept with its key: pressing the same button again (the same
 * unit, decision, reason and answers) is the same action and sends the same `Idempotency-Key`, so a decision the server
 * did store is not made twice. A decision that was answered, whether it was made or refused, spends the key: the next click
 * is a new action and gets a new one. Other answers (a different reason, answers that were read again) are another request,
 * and a key is bound to its first body by the API (`IDEMPOTENCY_KEY_REUSED`), so they never reuse one.
 */
export function createDecider(send: typeof sendDecision = sendDecision, makeKey: () => string = newDecisionKey): Decider {
  let unanswered: { fingerprint: string; key: string } | null = null;
  return {
    async decide(request) {
      const fingerprint = JSON.stringify([request.org, request.formId, request.submissionId, request.unitId, bodyOf(request)]);
      const key = unanswered?.fingerprint === fingerprint ? unanswered.key : makeKey();
      unanswered = { fingerprint, key };
      try {
        const decided = await send(request, key);
        unanswered = null;
        return decided;
      } catch (err) {
        if (!isIndeterminate(err)) unanswered = null;
        throw err;
      }
    },
  };
}

/** Sends one decision with the key of its click. A refusal is an `ApiProblem` (`code`: `FOUR_EYES_VIOLATION`, `REVIEW_STALE`, …). */
export async function sendDecision(request: DecisionRequest, key: string): Promise<Decided> {
  const path = `${submissionUrl(request.formId, request.submissionId)}/review/units/${encodeURIComponent(request.unitId)}/decisions`;
  return read(await orgCall(request.org, 'POST', path, bodyOf(request), { 'idempotency-key': key }), decidedSchema);
}
