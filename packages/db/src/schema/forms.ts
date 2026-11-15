import { sql } from 'drizzle-orm';
import { bigint, boolean, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts, tsNull } from './columns.ts';
import { orgs } from './identity.ts';

export const FORM_LIFECYCLES = ['active', 'archived', 'trashed'] as const;
export type FormLifecycle = (typeof FORM_LIFECYCLES)[number];

/** RLS: `forms_tenant`. */
export const forms = pgTable(
  'forms',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    teamId: uuid('team_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    title: text('title').notNull(),
    lifecycle: text('lifecycle', { enum: FORM_LIFECYCLES }).notNull().default('active'),
    trashedAt: tsNull('trashed_at'),
    liveVersionId: uuid('live_version_id'),
    hasSensitive: boolean('has_sensitive').notNull().default(false),
    noticeApprovedHash: bytea('notice_approved_hash'),
    /** `TemplateOriginStamp` (schema v2) once @form/schema lands. */
    templateOrigin: jsonb('template_origin').$type<Record<string, unknown>>(),
    brandKitId: uuid('brand_kit_id'),
    labels: uuid('label_ids').array().notNull().default(sql`'{}'`),
    submissionCount: bigint('submission_count', { mode: 'number' }).notNull().default(0),
    lastSubmissionAt: tsNull('last_submission_at'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
    updatedBy: uuid('updated_by'),
    /** Public fill address (`/f/:slug`). Set on first publish. Last, as 0013 added it (the migrations test compares column order). */
    slug: text('slug'),
  },
  (t) => [unique('forms_org_id_id_key').on(t.orgId, t.id)],
);

/** 1:1 with forms (BLD-07). RLS: `form_drafts_tenant`. */
export const formDrafts = pgTable(
  'form_drafts',
  {
    formId: uuid('form_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    /** `FormDefinition` (schema v2) once @form/schema lands. */
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    draftRev: integer('draft_rev').notNull().default(1),
    schemaVersion: integer('schema_version').notNull(),
    baseVersionId: uuid('base_version_id'),
    sizeBytes: integer('size_bytes').notNull(),
    updatedAt: ts('updated_at'),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [foreignKey({ name: 'form_drafts_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] })],
);

/**
 * Immutable published snapshot (PUB-01). RLS: `form_versions_tenant`. fr_app can insert and read, never update or delete,
 * and a trigger refuses both for every role (migration 0020); a version's life after publish (superseded, retired) is
 * in `form_version_state`. `label` and the columns after it were added by 0020, hence last.
 */
export const formVersions = pgTable(
  'form_versions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    number: integer('number').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    compiled: jsonb('compiled').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    /** Pictures the version uses, by asset id (data URLs), stored with the version at publish. */
    media: jsonb('media').$type<Record<string, string>>(),
    /** What the publisher called this version; null when never named. */
    label: text('label'),
    /** The evaluation engine and major version the compiled plan was made for. */
    engine: text('engine').notNull().default('logic@2'),
    /** The `form_drafts.draft_rev` this version froze (publishing one revision twice returns it); null before 0020. */
    draftRev: integer('draft_rev'),
    /** Where the form came from (templates spec §5.1, BL-241). */
    templateLineage: jsonb('template_lineage').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** The org-profile values resolved at publish (templates spec §5.1, BL-241). */
    variablesSnapshot: jsonb('variables_snapshot').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    foreignKey({ name: 'form_versions_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    unique('form_versions_form_number_key').on(t.orgId, t.formId, t.number),
    unique('form_versions_org_form_id_key').on(t.orgId, t.formId, t.id),
  ],
);

/**
 * One row per version, made with it (a trigger): when a newer version went live (`supersededAt`) and when it stopped
 * taking submissions for good (`retiredAt`, written by no job yet; acceptance of an old version is worked out at submit
 * time). RLS: `form_version_state_tenant`; a respondent context reads and never writes. Only the two dates update.
 */
export const formVersionState = pgTable(
  'form_version_state',
  {
    versionId: uuid('version_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    supersededAt: tsNull('superseded_at'),
    retiredAt: tsNull('retired_at'),
  },
  (t) => [
    foreignKey({
      name: 'form_version_state_version_fkey',
      columns: [t.orgId, t.formId, t.versionId],
      foreignColumns: [formVersions.orgId, formVersions.formId, formVersions.id],
    }),
    index('form_version_state_form_idx').on(t.orgId, t.formId),
  ],
);

/**
 * Access rules of a form (ACC-01..05, ACC-08). A form without a row is open with the defaults. RLS: `form_access_tenant`;
 * respondent contexts read and never write. fr_app has no SELECT on `password_hash` (column grants): a query must name
 * its columns (`formAccessPublicColumns`), and `select *` or `returning *` fails with "permission denied". The hash is
 * read by `form_access_password_hash()` for the unlock route only.
 */
export const formAccess = pgTable(
  'form_access',
  {
    formId: uuid('form_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    /** Compare-and-swap revision of PUT .../access (If-Match). */
    rev: integer('rev').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    openAt: tsNull('open_at'),
    closeAt: tsNull('close_at'),
    /** `{ timeZone, windows: [{ weekdays, from, to }] }` (ACC-06); null means always. */
    availability: jsonb('availability').$type<Record<string, unknown>>(),
    /** Null means no limit. */
    submissionLimit: integer('submission_limit'),
    /** argon2id hash. Write-only for fr_app. */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: tsNull('password_updated_at'),
    /** Origins allowed to frame the form; empty means any. Stored, not enforced until WP-1.09. */
    embedAllowlist: text('embed_allowlist').array().notNull().default(sql`'{}'`),
    /** Hosts the after-submit redirect may go to: null when no list was set, empty when no redirect is allowed. */
    redirectAllowlist: text('redirect_allowlist').array(),
    /** Custom text of the status screens, by screen role. */
    screens: jsonb('screens').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    acceptPreviousVersionsHours: integer('accept_previous_versions_hours').notNull().default(72),
  },
  (t) => [foreignKey({ name: 'form_access_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] })],
);

/** Every column of `form_access` fr_app may read: all but `password_hash`. */
export const formAccessPublicColumns = {
  formId: formAccess.formId,
  orgId: formAccess.orgId,
  rev: formAccess.rev,
  enabled: formAccess.enabled,
  openAt: formAccess.openAt,
  closeAt: formAccess.closeAt,
  availability: formAccess.availability,
  submissionLimit: formAccess.submissionLimit,
  passwordUpdatedAt: formAccess.passwordUpdatedAt,
  embedAllowlist: formAccess.embedAllowlist,
  redirectAllowlist: formAccess.redirectAllowlist,
  screens: formAccess.screens,
  acceptPreviousVersionsHours: formAccess.acceptPreviousVersionsHours,
};

/**
 * Every address a form has had. A slug belongs to its form for good (no delete: a released slug could be claimed by
 * another org); the primary one is where old links redirect. `forms.slug` follows the primary one: a trigger adds a
 * slug set there (migration 0020). RLS: `form_slugs_tenant`; respondents read and never write. Only `isPrimary` updates.
 */
export const formSlugs = pgTable(
  'form_slugs',
  {
    slug: text('slug').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: ts('created_at'),
  },
  (t) => [
    foreignKey({ name: 'form_slugs_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    index('form_slugs_form_idx').on(t.orgId, t.formId),
  ],
);

/**
 * The submission limit's counter (ACC-04), one row per form (a trigger makes it with the form). The submit transaction's
 * last statement is a guarded UPDATE of `submittedTotal`. RLS: `form_counters_tenant`; only respondent and system
 * contexts update, and only that column; no delete.
 */
export const formCounters = pgTable(
  'form_counters',
  {
    formId: uuid('form_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    submittedTotal: bigint('submitted_total', { mode: 'number' }).notNull().default(0),
  },
  (t) => [foreignKey({ name: 'form_counters_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] })],
);

/**
 * A member's starred forms. RLS: `form_favourites_tenant`, and the restrictive `form_favourites_own`: a user context sees
 * and changes its own rows only, no other actor kind sees any. Rows go when the account is deleted.
 */
export const formFavourites = pgTable(
  'form_favourites',
  {
    formId: uuid('form_id').notNull(),
    userId: uuid('user_id').notNull(),
    orgId: uuid('org_id').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.formId, t.userId] }),
    foreignKey({ name: 'form_favourites_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    index('form_favourites_user_idx').on(t.orgId, t.userId, t.formId),
  ],
);

/** `file`: whatever the upload field accepts; `signature`: the PNG a signature pad drew. */
export const FILE_PURPOSES = ['file', 'signature'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * What a respondent uploaded to a published form; the bytes are in the file store. RLS: `form_files_tenant`, and
 * `form_files_data_access` (reads need `submissions.read` or a system job). Respondent routes look files up through
 * `form_files_check()`, never the table. `purpose` and `submissionId` were added by 0019 and `submissionReceivedAt` by
 * 0021, hence last.
 */
export const formFiles = pgTable(
  'form_files',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    blockId: text('block_id').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: ts('created_at'),
    purpose: text('purpose', { enum: FILE_PURPOSES }).notNull().default('file'),
    /** The submission whose answers name the file; null until one does (the orphan sweep removes files that stay null). */
    submissionId: uuid('submission_id'),
    /** The held submission's `received_at`: with `submissionId` the key of a row in the partitioned table (0021); both or neither. */
    submissionReceivedAt: tsNull('submission_received_at'),
  },
  (t) => [
    foreignKey({ name: 'form_files_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    index('form_files_form_idx').on(t.orgId, t.formId, t.createdAt),
  ],
);
