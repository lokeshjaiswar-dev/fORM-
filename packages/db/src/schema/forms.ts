import { sql } from 'drizzle-orm';
import { bigint, boolean, foreignKey, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
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
    /** Public fill address (`/f/:slug`). Set on first publish. */
    slug: text('slug'),
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

/** Immutable published snapshot (PUB-01). RLS: `form_versions_tenant`. */
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
  },
  (t) => [
    foreignKey({ name: 'form_versions_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    unique('form_versions_form_number_key').on(t.orgId, t.formId, t.number),
  ],
);

/** RLS: `form_submissions_tenant`. */
export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    fields: jsonb('fields').$type<Array<{ key: string; label: string; value: string; table?: { headers: string[]; rows: string[][] } | undefined; choices?: string[] | undefined }>>().notNull(),
    locale: text('locale').notNull().default('en-IN'),
    /** Live form version the respondent answered. Null for rows written before versions were linked. */
    versionId: uuid('version_id'),
    submittedAt: ts('submitted_at'),
  },
  (t) => [
    foreignKey({ name: 'form_submissions_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    index('form_submissions_form_idx').on(t.orgId, t.formId, t.submittedAt),
  ],
);
