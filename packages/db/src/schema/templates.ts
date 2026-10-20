import { TEMPLATE_KINDS, TEMPLATE_SCOPES, TEMPLATE_VERSION_STATES } from '@form/schema';
import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, date, foreignKey, integer, jsonb, pgEnum, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts, tsNull } from './columns.ts';
import { forms } from './forms.ts';
import { orgs, users } from './identity.ts';

/** Template storage (templates spec §5.1, migration 0009). System rows have `orgId` null and are written only by `fr_template_seeder`. */

export const TEMPLATE_LIFECYCLES = ['active', 'deprecated', 'archived'] as const;
export const TEMPLATE_SOURCES = ['system_pack', 'pack_import', 'user', 'clone', 'fork', 'jotform_import', 'ai'] as const;
export const TEMPLATE_PACK_VERIFICATIONS = ['verified', 'unsigned', 'failed'] as const;
export const TEMPLATE_CATEGORY_FACETS = ['use_case', 'industry', 'compliance'] as const;
export const TEMPLATE_USAGE_ACTIONS = [
  'preview',
  'use',
  'insert',
  'apply_theme',
  'publish_from',
  'update_applied',
  'update_dismissed',
  'detach',
  'fork',
  'export',
] as const;
export const TEMPLATE_SIGNING_ALGS = ['ed25519', 'es256'] as const;
export type TemplateUsageAction = (typeof TEMPLATE_USAGE_ACTIONS)[number];
export type TemplateSigningAlg = (typeof TEMPLATE_SIGNING_ALGS)[number];

export const templateKind = pgEnum('template_kind', TEMPLATE_KINDS);
export const templateScope = pgEnum('template_scope', TEMPLATE_SCOPES);
export const templateLifecycle = pgEnum('template_lifecycle', TEMPLATE_LIFECYCLES);
export const templateVersionState = pgEnum('template_version_state', TEMPLATE_VERSION_STATES);

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
/** `numeric(5,2)` read as a number (drizzle's numeric renders the type as `numeric(5, 2)`). */
const percent = customType<{ data: number; driverData: string }>({
  dataType: () => 'numeric(5,2)',
  toDriver: (v) => String(v),
  fromDriver: (v) => Number(v),
});

/** RLS: `template_packs_tenant` (org rows), `template_packs_seed`. */
export const templatePacks = pgTable('template_packs', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').references(() => orgs.id),
  publisher: text('publisher').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  manifestHash: bytea('manifest_hash').notNull(),
  signatureKeyId: text('signature_key_id'),
  verification: text('verification', { enum: TEMPLATE_PACK_VERIFICATIONS }).notNull(),
  importedBy: uuid('imported_by'),
  importedAt: ts('imported_at'),
});

/**
 * RLS: `templates_tenant` (system rows, and the org's by scope: team ids, the personal owner, `templates.govern`),
 * `templates_insert`, `templates_update`, `templates_seed`. Soft deletion goes through `template_delete()`.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').references(() => orgs.id),
    teamId: uuid('team_id'),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    scope: templateScope('scope').notNull(),
    kind: templateKind('kind').notNull(),
    publisher: text('publisher').notNull().default('org'),
    slug: text('slug').notNull(),
    lifecycle: templateLifecycle('lifecycle').notNull().default('active'),
    source: text('source', { enum: TEMPLATE_SOURCES }).notNull(),
    packId: uuid('pack_id').references(() => templatePacks.id),
    forkedFromVersionId: uuid('forked_from_version_id'),
    currentVersionId: uuid('current_version_id'),
    defaultLocale: text('default_locale').notNull().default('en-IN'),
    industries: text('industries').array().notNull().default(sql`'{}'`),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    layout: text('layout', { enum: ['classic', 'cards'] }),
    featured: boolean('featured').notNull().default(false),
    sortWeight: integer('sort_weight').notNull().default(0),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
    deletedAt: tsNull('deleted_at'),
  },
  (t) => [unique('templates_org_id_id_key').on(t.orgId, t.id)],
);

/**
 * `orgId` is kept equal to the template's by trigger. RLS: `template_versions_tenant` (the template's visibility, and
 * drafts only for their author and `templates.approve`). Content is immutable once the state leaves `draft`.
 */
export const templateVersions = pgTable(
  'template_versions',
  {
    id: uuid('id').primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id),
    orgId: uuid('org_id'),
    version: integer('version').notNull(),
    state: templateVersionState('state').notNull().default('draft'),
    schemaVersion: integer('schema_version').notNull(),
    /** `TemplateVersionPayload` (schema v2). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: bytea('payload_hash').notNull(),
    lockFingerprints: jsonb('lock_fingerprints').$type<Record<string, string>>().notNull().default({}),
    requiredFeatures: text('required_features').array().notNull().default(sql`'{}'`),
    locales: text('locales').array().notNull().default(sql`'{en-IN}'`),
    changeLevel: text('change_level', { enum: ['patch', 'minor', 'major'] }),
    changelog: text('changelog'),
    mandatory: boolean('mandatory').notNull().default(false),
    mandatoryDeadline: tsNull('mandatory_deadline'),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    previewAssets: jsonb('preview_assets').$type<Record<string, unknown>>().notNull().default({}),
    statsFields: integer('stats_fields'),
    statsPages: integer('stats_pages'),
    estMinutes: integer('est_minutes'),
    hasSensitive: boolean('has_sensitive'),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at'),
    submittedAt: tsNull('submitted_at'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: tsNull('reviewed_at'),
    reviewComment: text('review_comment'),
    publishedAt: tsNull('published_at'),
    packSignature: jsonb('pack_signature').$type<{ keyId: string; alg: TemplateSigningAlg; sig: string }>(),
  },
  (t) => [
    unique('template_versions_template_version_key').on(t.templateId, t.version),
    unique('template_versions_id_template_key').on(t.id, t.templateId),
  ],
);

/** `orgId` and `search` are set by triggers. RLS: `template_localizations_tenant` (the version's visibility). */
export const templateLocalizations = pgTable(
  'template_localizations',
  {
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => templateVersions.id),
    orgId: uuid('org_id'),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    description: jsonb('description').$type<Record<string, unknown>>(),
    fieldLabels: text('field_labels').notNull().default(''),
    search: tsvector('search').notNull().default(sql`''::tsvector`),
    completeness: percent('completeness').notNull().default(100),
  },
  (t) => [primaryKey({ columns: [t.templateVersionId, t.locale] })],
);

/** RLS: `template_categories_tenant` (system and own org), writes on org rows only. */
export const templateCategories = pgTable('template_categories', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').references(() => orgs.id),
  facet: text('facet', { enum: TEMPLATE_CATEGORY_FACETS }).notNull(),
  parentId: uuid('parent_id'),
  slug: text('slug').notNull(),
  names: jsonb('names').$type<Record<string, string>>().notNull(),
  icon: text('icon'),
  kinds: templateKind('kinds').array().notNull().default(sql`'{form}'`),
  sort: integer('sort').notNull().default(0),
});

/** `orgId` is the template's (trigger). RLS: `template_category_links_tenant` (the template's visibility). */
export const templateCategoryLinks = pgTable(
  'template_category_links',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => templateCategories.id),
    orgId: uuid('org_id'),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.categoryId] })],
);

/** RLS: `brand_kits_tenant`. */
export const brandKits = pgTable(
  'brand_kits',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    teamId: uuid('team_id'),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    /** `BrandKitTokens` (schema v2). */
    tokens: jsonb('tokens').$type<Record<string, unknown>>().notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at'),
    deletedAt: tsNull('deleted_at'),
  },
  (t) => [unique('brand_kits_org_id_id_key').on(t.orgId, t.id)],
);

/** One row per applied template (templates spec §4.1). RLS: `form_template_bindings_tenant`; `template_for_binding()` for diffs. */
export const formTemplateBindings = pgTable(
  'form_template_bindings',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    formId: uuid('form_id').notNull(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id),
    templateVersionId: uuid('template_version_id').notNull(),
    kind: templateKind('kind').notNull(),
    instanceRootId: text('instance_root_id'),
    idMap: jsonb('id_map').$type<Record<string, string>>().notNull(),
    keyMap: jsonb('key_map').$type<Record<string, string>>(),
    /** `current | available | required | dismissed@<version>`. */
    updateState: text('update_state').notNull().default('current'),
    governance: text('governance', { enum: ['bound', 'detached'] }).notNull().default('bound'),
    appliedBy: uuid('applied_by'),
    appliedAt: ts('applied_at'),
  },
  (t) => [
    foreignKey({ name: 'form_template_bindings_form_fkey', columns: [t.orgId, t.formId], foreignColumns: [forms.orgId, forms.id] }),
    foreignKey({
      name: 'form_template_bindings_version_fkey',
      columns: [t.templateVersionId, t.templateId],
      foreignColumns: [templateVersions.id, templateVersions.templateId],
    }),
  ],
);

/** TPL-32. RLS: `template_fork_bindings_tenant`. */
export const templateForkBindings = pgTable('template_fork_bindings', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  templateId: uuid('template_id').notNull(),
  upstreamTemplateId: uuid('upstream_template_id')
    .notNull()
    .references(() => templates.id),
  upstreamVersionId: uuid('upstream_version_id').notNull(),
  idMap: jsonb('id_map').$type<Record<string, string>>().notNull(),
  updateState: text('update_state').notNull().default('current'),
});

/** Append-only (SELECT and INSERT for fr_app). RLS: `template_usages_tenant`. */
export const templateUsages = pgTable('template_usages', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id').notNull(),
  userId: uuid('user_id'),
  templateId: uuid('template_id').notNull(),
  templateVersionId: uuid('template_version_id').notNull(),
  action: text('action', { enum: TEMPLATE_USAGE_ACTIONS }).notNull(),
  formId: uuid('form_id'),
  locale: text('locale'),
  occurredAt: ts('occurred_at'),
});

/** Written by `fr_system_agg`. RLS: `template_stats_daily_tenant` (own org, and system aggregates over at least 5 orgs). */
export const templateStatsDaily = pgTable('template_stats_daily', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  templateId: uuid('template_id').notNull(),
  day: date('day').notNull(),
  orgId: uuid('org_id'),
  previews: integer('previews'),
  uses: integer('uses'),
  publishes: integer('publishes'),
  submissions: integer('submissions'),
  updatesApplied: integer('updates_applied'),
  distinctOrgs: integer('distinct_orgs'),
});

/**
 * Trust store. RLS: `template_signing_keys_tenant` (platform and own org keys), writes on org rows only. `keyId` is unique
 * per owner (`template_signing_keys_uq`); platform key ids start with `fORM-` and org key ids never do.
 */
export const templateSigningKeys = pgTable('template_signing_keys', {
  id: uuid('id').primaryKey(),
  keyId: text('key_id').notNull(),
  orgId: uuid('org_id').references(() => orgs.id),
  publicKey: bytea('public_key').notNull(),
  alg: text('alg', { enum: TEMPLATE_SIGNING_ALGS }).notNull(),
  label: text('label'),
  addedBy: uuid('added_by'),
  revokedAt: tsNull('revoked_at'),
});

/** RLS: `template_search_synonyms_tenant` (system and own org), writes on org rows only. */
export const templateSearchSynonyms = pgTable('template_search_synonyms', {
  orgId: uuid('org_id'),
  term: text('term').notNull(),
  expandsTo: text('expands_to').array().notNull(),
});

/** RLS: `template_search_misses_tenant`. */
export const templateSearchMisses = pgTable(
  'template_search_misses',
  {
    orgId: uuid('org_id').notNull(),
    qNorm: text('q_norm').notNull(),
    locale: text('locale').notNull(),
    count: integer('count').notNull().default(1),
    lastAt: ts('last_at'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.qNorm, t.locale] })],
);
