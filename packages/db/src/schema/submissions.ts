import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './columns.ts';
import { formVersions } from './forms.ts';

/** What a submission is doing: taken, held for something, or set aside. A held one triggers no side effects until released. */
export const SUBMISSION_STATUSES = [
  'complete',
  'pending_payment',
  'payment_failed',
  'pending_scan',
  'pending_guardian_consent',
  'spam',
  'archived',
  'trashed',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** `answer_codec_version` of answers stored as plain jsonb. The encrypted codec (WP-1.11) writes a later number. */
export const ANSWER_CODEC_PLAIN = 0;

/**
 * Responses (architecture §2.4, ADR-0004, migration 0021). Partitioned by month on `received_at`, which a CHECK ties to
 * the timestamp inside the UUIDv7 `id`; partitions live in schema `parts`, which fr_app cannot reach, and there is no
 * default partition, so a row outside the existing months fails loudly. Look one up with `submissionKey(id)`, never by
 * `id` alone, so the planner touches one partition.
 *
 * RLS: `submissions_tenant`, and the restrictive `submissions_data_access` (reads need `submissions.read`, a system job,
 * or a respondent whose verified token named the row), `submissions_data_update` and `submissions_data_delete`. fr_app has
 * column grants: it inserts the identity and answer columns, updates the inbox and edit columns, and can never set the
 * retention columns (`deleteAfter`, `statutoryHoldUntil`, `legalHold`, until WP-1.22), `seq`, or move a row to another
 * form, version or month. `deleteAfter` is filled by a trigger (received_at + 10 years) for an insert that names none.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    formVersionId: uuid('form_version_id').notNull(),
    /** sha256 of the version's definition (its `content_hash`), as bytes. */
    definitionHash: bytea('definition_hash').notNull(),
    answerCodecVersion: smallint('answer_codec_version').notNull(),
    /** One identity for the whole table; orders and numbers responses. Gaps happen (a rolled-back insert burns one). */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    status: text('status', { enum: SUBMISSION_STATUSES }).notNull(),
    /** `StoredAnswer` per block, plain jsonb while `answerCodecVersion` is 0. */
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    /** Variables, path, ending and fired rule ids; `{}` until the pipeline records them. */
    computed: jsonb('computed').$type<Record<string, unknown>>().notNull(),
    /** `{ locale }` for now; later source, durations, signal hashes (TTL), device, country, utm. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull(),
    /** Blind indexes of the principal-identifier fields, for DSR lookup (WP-1.11); null until then. */
    principalBidx: bytea('principal_bidx').array(),
    deleteAfter: timestamp('delete_after', { withTimezone: true }).notNull(),
    statutoryHoldUntil: timestamp('statutory_hold_until', { withTimezone: true }),
    legalHold: boolean('legal_hold').notNull().default(false),
    read: boolean('read').notNull().default(false),
    starred: boolean('starred').notNull().default(false),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    assigneeId: uuid('assignee_id'),
    workflowState: text('workflow_state'),
    statusLabel: text('status_label'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.receivedAt] }),
    // The version names its org and form (0020), so a row cannot point at another form's version.
    foreignKey({
      name: 'submissions_version_fkey',
      columns: [t.orgId, t.formId, t.formVersionId],
      foreignColumns: [formVersions.orgId, formVersions.formId, formVersions.id],
    }),
    check('submissions_id_ts', sql`${t.receivedAt} = uuid_v7_ts(${t.id})`),
    index('submissions_grid').on(t.orgId, t.formId, t.receivedAt.desc()).where(sql`${t.trashedAt} is null`),
    index('submissions_unread').on(t.orgId, t.formId).where(sql`${t.read} = false and ${t.trashedAt} is null`),
    index('submissions_due').on(t.deleteAfter).where(sql`${t.legalHold} = false`),
    index('submissions_principal').using('gin', t.principalBidx),
    index('submissions_status').on(t.orgId, t.formId, t.status).where(sql`${t.status} <> 'complete'`),
  ],
);

/**
 * The first write of a submit transaction: one row per (org, form, Idempotency-Key), so a replay returns the stored result
 * before anything is stored or counted twice. `requestHash` tells a replay from a reused key; `response` holds ids only.
 * 24 hours (`expiresAt`), then a sweep deletes it. RLS: `submission_idempotency_tenant`, and the restrictive
 * `submission_idempotency_actor` (respondent and system contexts only) and `submission_idempotency_delete` (system only).
 */
export const submissionIdempotency = pgTable(
  'submission_idempotency',
  {
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    key: text('key').notNull(),
    submissionId: uuid('submission_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    requestHash: bytea('request_hash').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.formId, t.key] }), index('submission_idempotency_expires_idx').on(t.orgId, t.expiresAt)],
);

/**
 * Gap-free numbers for a unique-ID field: one row per form, block and period (`''` when the number never restarts). The
 * submit transaction takes `nextSeq` in its last statements, so a rolled-back submission gives its number back. RLS:
 * `form_id_counters_tenant`; only respondent and system contexts insert and advance (`nextSeq` is the one updatable
 * column); no delete.
 */
export const formIdCounters = pgTable(
  'form_id_counters',
  {
    formId: uuid('form_id').notNull(),
    blockId: text('block_id').notNull(),
    period: text('period').notNull().default(''),
    orgId: uuid('org_id').notNull(),
    nextSeq: bigint('next_seq', { mode: 'number' }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.formId, t.blockId, t.period] })],
);
