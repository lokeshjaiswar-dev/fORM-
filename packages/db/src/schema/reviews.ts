import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts, tsNull } from './columns.ts';
import { forms, formVersions } from './forms.ts';
import { memberships, orgs, users } from './identity.ts';
import { submissions } from './submissions.ts';

/**
 * Section-level maker-checker review (WP-2.33, migration 0022). Storage only: a review is opened and decided through the
 * SECURITY DEFINER functions of migration 0024, which `fr_app` calls and which are the only way to write
 * `submission_reviews` and `review_decisions`.
 */

/** Where one review unit of one submission stands. `closed`: another required unit was rejected, so this one is no longer asked. */
export const REVIEW_STATES = ['pending', 'approved', 'rejected', 'not_applicable', 'closed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** What a checker may decide in this slice. Returning a unit to the respondent (`return`) comes with WP-2.18. */
export const REVIEW_DECISIONS = ['approve', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** The fixed catalogue of reasons for a decision (no free text in this slice; a note must be encrypted with the submission's key, WP-1.11). */
export const REVIEW_REASON_CODES = ['incomplete', 'incorrect', 'missing_document', 'duplicate', 'other'] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

/** How much of the submission a checker of a unit sees: only that unit's answers, or all of them. */
export const REVIEW_VISIBILITIES = ['own_unit', 'whole_submission'] as const;
export type ReviewVisibility = (typeof REVIEW_VISIBILITIES)[number];

/**
 * A named set of checkers that review units are assigned to. Archived, never deleted: a review row and a decision name the
 * group that was asked. RLS: `review_groups_tenant`; a respondent context reads none; writes need `members.manage` or a
 * system job. fr_app can rename and archive (`name`, `archivedAt`) and nothing else after insert.
 */
export const reviewGroups = pgTable(
  'review_groups',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: ts('created_at'),
    archivedAt: tsNull('archived_at'),
  },
  (t) => [unique('review_groups_org_id_id_key').on(t.orgId, t.id)],
);

/**
 * The checkers of a group. Tied to `memberships` and removed with it, so a checker is always a member of the org. RLS:
 * `review_group_members_tenant`; a respondent context reads none; insert and delete need `members.manage` or a system job; rows are never updated.
 */
export const reviewGroupMembers = pgTable(
  'review_group_members',
  {
    orgId: uuid('org_id').notNull(),
    groupId: uuid('group_id').notNull(),
    userId: uuid('user_id').notNull(),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id),
    addedAt: ts('added_at'),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    foreignKey({ name: 'review_group_members_group_fkey', columns: [t.orgId, t.groupId], foreignColumns: [reviewGroups.orgId, reviewGroups.id] }),
    foreignKey({ name: 'review_group_members_member_fkey', columns: [t.orgId, t.userId], foreignColumns: [memberships.orgId, memberships.userId] }).onDelete('cascade'),
    index('review_group_members_user_idx').on(t.orgId, t.userId, t.groupId),
  ],
);

/**
 * Which units of a form are reviewed, by which group, in which order: `settings` is the server-stored assignment
 * (`ReviewSettings` in @form/schema), `enabled` switches review on for new responses. One row per form that was ever set up;
 * `rev` is the compare-and-swap revision of PUT /v1/forms/:id/review. RLS: `form_review_settings_tenant` (every context of the
 * org reads it, a respondent's too: the submit transaction asks whether the form is reviewed); insert and update need
 * `ops.manage` or a system job; no delete.
 */
export const formReviewSettings = pgTable(
  'form_review_settings',
  {
    formId: uuid('form_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    rev: integer('rev').notNull().default(1),
    enabled: boolean('enabled').notNull().default(false),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at'),
  },
  (t) => [foreignKey({ name: 'form_review_settings_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] })],
);

/**
 * The current state of each review unit of a submission (one row per unit), a copy taken when the review was opened.
 * Partitioned by month on `submissionReceivedAt` (the submission's own `received_at`) like `submissions`; the foreign key
 * cascades, so deleting a submission deletes its reviews. RLS: `submission_reviews_tenant`, and the restrictive
 * `submission_reviews_data_access` (read with `submissions.read`, `submissions.review`, or a system job). fr_app has SELECT only: the rows are
 * written by `review_open()` and `review_decide()` (migration 0024).
 */
export const submissionReviews = pgTable(
  'submission_reviews',
  {
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    submissionReceivedAt: timestamp('submission_received_at', { withTimezone: true }).notNull(),
    unitId: text('unit_id').notNull(),
    /** 1, and one more each time the unit is sent back and corrected (WP-2.18). */
    round: integer('round').notNull().default(1),
    state: text('state', { enum: REVIEW_STATES }).notNull().default('pending'),
    required: boolean('required').notNull(),
    /** Units with the same order are reviewed in parallel; a higher order waits for the lower ones. */
    reviewOrder: integer('review_order').notNull(),
    groupId: uuid('group_id').notNull(),
    visibility: text('visibility', { enum: REVIEW_VISIBILITIES }).notNull(),
    /** The signed-in user who filled the unit in; null for a public respondent. May not check the unit. */
    makerUserId: uuid('maker_user_id'),
    /** Active members whose verified email matched an email the respondent gave, when the review was opened. May not check the unit. */
    excludedUserIds: uuid('excluded_user_ids').array().notNull().default(sql`'{}'`),
    /** The last member who edited the unit's answers (SUB-09). May not check the unit. */
    lastEditorId: uuid('last_editor_id'),
    /** sha256 of the unit's stored answers; a decision names it, so a later change makes the decision stale. */
    answersHash: bytea('answers_hash').notNull(),
    rev: integer('rev').notNull().default(1),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.submissionReceivedAt, t.unitId] }),
    foreignKey({
      name: 'submission_reviews_submission_fkey',
      columns: [t.submissionId, t.submissionReceivedAt],
      foreignColumns: [submissions.id, submissions.receivedAt],
    }).onDelete('cascade'),
    foreignKey({ name: 'submission_reviews_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    foreignKey({ name: 'submission_reviews_group_fkey', columns: [t.orgId, t.groupId], foreignColumns: [reviewGroups.orgId, reviewGroups.id] }),
    index('submission_reviews_queue').on(t.orgId, t.groupId, t.submissionReceivedAt.desc()).where(sql`${t.state} = 'pending'`),
  ],
);

/**
 * Every approve and reject ever made, never changed: a trigger refuses UPDATE and DELETE to every role but the table's
 * owner (the definer functions of 0024 and the cascade of the foreign key to `submissions`), and fr_app has neither
 * privilege. A decision names the unit, the round, the hash of the answers the checker saw and the form version they were
 * validated against. `idempotencyKey` makes a retried request return the first decision. Partitioned like
 * `submissionReviews`; RLS: `review_decisions_tenant` and the restrictive `review_decisions_data_access`; fr_app has SELECT only.
 */
export const reviewDecisions = pgTable(
  'review_decisions',
  {
    id: uuid('id').notNull(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    submissionReceivedAt: timestamp('submission_received_at', { withTimezone: true }).notNull(),
    unitId: text('unit_id').notNull(),
    round: integer('round').notNull(),
    decision: text('decision', { enum: REVIEW_DECISIONS }).notNull(),
    /** From the fixed catalogue; required for a reject. */
    reasonCode: text('reason_code', { enum: REVIEW_REASON_CODES }),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id),
    decidedAt: ts('decided_at'),
    answersHash: bytea('answers_hash').notNull(),
    formVersionId: uuid('form_version_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.submissionReceivedAt] }),
    unique('review_decisions_idempotency_key').on(t.orgId, t.idempotencyKey, t.submissionReceivedAt),
    check('review_decisions_reject_reason', sql`${t.decision} <> 'reject' or ${t.reasonCode} is not null`),
    foreignKey({
      name: 'review_decisions_submission_fkey',
      columns: [t.submissionId, t.submissionReceivedAt],
      foreignColumns: [submissions.id, submissions.receivedAt],
    }).onDelete('cascade'),
    // The version names its org and form (0020), so a row cannot point at another form's version.
    foreignKey({
      name: 'review_decisions_version_fkey',
      columns: [t.orgId, t.formId, t.formVersionId],
      foreignColumns: [formVersions.orgId, formVersions.formId, formVersions.id],
    }),
    index('review_decisions_submission_idx').on(t.submissionId, t.submissionReceivedAt, t.unitId, t.round),
  ],
);
