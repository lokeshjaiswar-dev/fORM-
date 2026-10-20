import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createTestDatabase } from '@form/testkit';
import { createDb, provision, type DbHandle, type RoleName } from '../src/index.ts';
import { TEST_PASSWORDS } from './passwords.ts';

export interface TestDb {
  database: string;
  urls: Record<RoleName, string>;
  /** Pool as fr_app (NOBYPASSRLS), the role request traffic uses. */
  app: DbHandle;
  /** Pool as fr_migrator (schema owner, BYPASSRLS), for seeding and inspection. */
  owner: pg.Pool;
  close(): Promise<void>;
}

/** A fresh database with every migration applied. */
export async function setupTestDb(): Promise<TestDb> {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl);
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  const app = createDb(urls.fr_app, { max: 4, applicationName: 'fr-test' });
  const owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  return {
    database,
    urls,
    app,
    owner,
    close: async () => {
      await app.close();
      await owner.end();
    },
  };
}

/** An org's template rows (templates spec §5.1): each scope, a draft, a fork of the system template, and what hangs off them. */
export interface OrgTemplates {
  orgTemplateId: string;
  /** Published v1 of the org template (its current version). */
  orgV1Id: string;
  /** v2 draft of the org template, created by the owner. */
  orgDraftId: string;
  teamTemplateId: string;
  teamV1Id: string;
  /** The editor's personal template. */
  personalTemplateId: string;
  personalV1Id: string;
  forkTemplateId: string;
  forkV1Id: string;
  categoryId: string;
  kitId: string;
  /** Form 1 bound to the org template's v1. */
  bindingId: string;
  /** Form 2 bound to the system template. */
  systemBindingId: string;
  forkBindingId: string;
  keyId: string;
}

export interface OrgSeed {
  orgId: string;
  ownerId: string;
  editorId: string;
  viewerId: string;
  teamId: string;
  formIds: [string, string];
  tpl: OrgTemplates;
}

/** System rows (org_id null), as the seeder would write them. */
export interface SystemSeed {
  packId: string;
  templateId: string;
  versionId: string;
  categoryId: string;
  keyId: string;
  slug: string;
}

export interface Seed {
  a: OrgSeed;
  b: OrgSeed;
  system: SystemSeed;
}

export const HASH = Buffer.alloc(32);

/** A word every seeded title shares, so a search finds the rows of every org unless RLS hides them. */
export const SEED_SEARCH_WORD = 'onboarding';

interface TemplateRow {
  id: string;
  orgId: string | null;
  scope: 'system' | 'org' | 'team' | 'personal';
  slug: string;
  teamId?: string;
  ownerUserId?: string;
  source?: string;
  createdBy: string | null;
  forkedFrom?: string;
}

export async function insertTemplate(owner: pg.Pool, t: TemplateRow): Promise<void> {
  await owner.query(
    `insert into templates (id, org_id, team_id, owner_user_id, scope, kind, publisher, slug, source, forked_from_version_id, created_by)
     values ($1, $2, $3, $4, $5, 'form', $6, $7, $8, $9, $10)`,
    [
      t.id,
      t.orgId,
      t.teamId ?? null,
      t.ownerUserId ?? null,
      t.scope,
      t.orgId ? 'org' : 'fORM-',
      t.slug,
      t.source ?? (t.orgId ? 'user' : 'system_pack'),
      t.forkedFrom ?? null,
      t.createdBy,
    ],
  );
}

interface VersionRow {
  id: string;
  templateId: string;
  version: number;
  state: 'draft' | 'in_review' | 'published' | 'rejected' | 'superseded';
  createdBy: string | null;
  title: string;
}

/** A version with its en-IN localization; a published one becomes the template's current version. */
export async function insertVersion(owner: pg.Pool, v: VersionRow): Promise<void> {
  await owner.query(
    `insert into template_versions (id, template_id, version, state, schema_version, payload, payload_hash, created_by, published_at)
     values ($1, $2, $3, $4::text::template_version_state, 1, $5, $6, $7, case when $4::text = 'published' then now() end)`,
    [v.id, v.templateId, v.version, v.state, JSON.stringify({ kind: 'form', schemaVersion: 1, title: v.title }), HASH, v.createdBy],
  );
  await owner.query(`insert into template_localizations (template_version_id, locale, title, summary, field_labels) values ($1, 'en-IN', $2, $3, 'Name Email')`, [
    v.id,
    v.title,
    `Summary of ${v.title}`,
  ]);
  if (v.state === 'published') await owner.query('update templates set current_version_id = $1 where id = $2', [v.id, v.templateId]);
}

async function seedSystem(owner: pg.Pool, tag: string): Promise<SystemSeed> {
  const s: SystemSeed = {
    packId: randomUUID(),
    templateId: randomUUID(),
    versionId: randomUUID(),
    categoryId: randomUUID(),
    keyId: `fORM-release-${tag}`,
    slug: `core/vendor-${tag}`,
  };
  await owner.query(
    `insert into template_packs (id, publisher, name, version, manifest, manifest_hash, signature_key_id, verification)
     values ($1, 'fORM-', $2, '1.0.0', '{}', $3, $4, 'verified')`,
    [s.packId, `system-core-${tag}`, HASH, s.keyId],
  );
  await owner.query(`insert into template_signing_keys (id, key_id, public_key, alg, label) values ($1, $2, $3, 'ed25519', 'release')`, [randomUUID(), s.keyId, Buffer.alloc(32, 1)]);
  await insertTemplate(owner, { id: s.templateId, orgId: null, scope: 'system', slug: s.slug, createdBy: null });
  await owner.query('update templates set pack_id = $1 where id = $2', [s.packId, s.templateId]);
  await insertVersion(owner, { id: s.versionId, templateId: s.templateId, version: 1, state: 'published', createdBy: null, title: `System vendor ${SEED_SEARCH_WORD}` });
  await owner.query(`insert into template_categories (id, facet, slug, names) values ($1, 'use_case', $2, '{"en-IN":"Onboarding"}')`, [s.categoryId, `onboarding-${tag}`]);
  await owner.query('insert into template_category_links (template_id, category_id) values ($1, $2)', [s.templateId, s.categoryId]);
  await owner.query(`insert into template_search_synonyms (term, expands_to) values ($1, '{kyc,verification}')`, [`kyc-${tag}`]);
  // Cross-tenant aggregates: shown from 5 distinct orgs on, hidden below.
  await owner.query(
    `insert into template_stats_daily (template_id, day, previews, uses, distinct_orgs) values ($1, current_date, 40, 9, 7), ($1, current_date - 1, 4, 1, 2)`,
    [s.templateId],
  );
  return s;
}

async function seedOrgTemplates(owner: pg.Pool, s: Omit<OrgSeed, 'tpl'>, slug: string, system: SystemSeed): Promise<OrgTemplates> {
  const tpl: OrgTemplates = {
    orgTemplateId: randomUUID(),
    orgV1Id: randomUUID(),
    orgDraftId: randomUUID(),
    teamTemplateId: randomUUID(),
    teamV1Id: randomUUID(),
    personalTemplateId: randomUUID(),
    personalV1Id: randomUUID(),
    forkTemplateId: randomUUID(),
    forkV1Id: randomUUID(),
    categoryId: randomUUID(),
    kitId: randomUUID(),
    bindingId: randomUUID(),
    systemBindingId: randomUUID(),
    forkBindingId: randomUUID(),
    keyId: `org-${slug}`,
  };
  const word = SEED_SEARCH_WORD;
  await insertTemplate(owner, { id: tpl.orgTemplateId, orgId: s.orgId, scope: 'org', slug: 'vendor', createdBy: s.ownerId });
  await insertVersion(owner, { id: tpl.orgV1Id, templateId: tpl.orgTemplateId, version: 1, state: 'published', createdBy: s.ownerId, title: `${slug} vendor ${word}` });
  await insertVersion(owner, { id: tpl.orgDraftId, templateId: tpl.orgTemplateId, version: 2, state: 'draft', createdBy: s.ownerId, title: `${slug} draft ${word}` });
  await insertTemplate(owner, { id: tpl.teamTemplateId, orgId: s.orgId, scope: 'team', slug: 'team-intake', teamId: s.teamId, createdBy: s.ownerId });
  await insertVersion(owner, { id: tpl.teamV1Id, templateId: tpl.teamTemplateId, version: 1, state: 'published', createdBy: s.ownerId, title: `${slug} team ${word}` });
  await insertTemplate(owner, { id: tpl.personalTemplateId, orgId: s.orgId, scope: 'personal', slug: 'my-intake', ownerUserId: s.editorId, createdBy: s.editorId });
  await insertVersion(owner, {
    id: tpl.personalV1Id,
    templateId: tpl.personalTemplateId,
    version: 1,
    state: 'published',
    createdBy: s.editorId,
    title: `${slug} personal ${word}`,
  });
  await insertTemplate(owner, {
    id: tpl.forkTemplateId,
    orgId: s.orgId,
    scope: 'org',
    slug: 'vendor-fork',
    source: 'fork',
    createdBy: s.ownerId,
    forkedFrom: system.versionId,
  });
  await insertVersion(owner, { id: tpl.forkV1Id, templateId: tpl.forkTemplateId, version: 1, state: 'published', createdBy: s.ownerId, title: `${slug} fork ${word}` });
  await owner.query(
    `insert into template_fork_bindings (id, org_id, template_id, upstream_template_id, upstream_version_id, id_map) values ($1, $2, $3, $4, $5, '{}')`,
    [tpl.forkBindingId, s.orgId, tpl.forkTemplateId, system.templateId, system.versionId],
  );
  await owner.query(`insert into template_categories (id, org_id, facet, slug, names) values ($1, $2, 'industry', 'bfsi', '{"en-IN":"BFSI"}')`, [tpl.categoryId, s.orgId]);
  await owner.query('insert into template_category_links (template_id, category_id) values ($1, $2), ($1, $3), ($4, $2)', [
    tpl.orgTemplateId,
    tpl.categoryId,
    system.categoryId,
    tpl.personalTemplateId,
  ]);
  await owner.query(`insert into brand_kits (id, org_id, name, is_default, tokens, updated_by) values ($1, $2, 'Default', true, '{}', $3)`, [tpl.kitId, s.orgId, s.ownerId]);
  await owner.query(
    `insert into form_template_bindings (id, org_id, form_id, template_id, template_version_id, kind, id_map, applied_by)
     values ($1, $2, $3, $4, $5, 'form', '{}', $6), ($7, $2, $8, $9, $10, 'form', '{}', $6)`,
    [tpl.bindingId, s.orgId, s.formIds[0], tpl.orgTemplateId, tpl.orgV1Id, s.ownerId, tpl.systemBindingId, s.formIds[1], system.templateId, system.versionId],
  );
  await owner.query(`insert into template_usages (org_id, user_id, template_id, template_version_id, action, form_id) values ($1, $2, $3, $4, 'use', $5)`, [
    s.orgId,
    s.ownerId,
    tpl.orgTemplateId,
    tpl.orgV1Id,
    s.formIds[0],
  ]);
  await owner.query(`insert into template_stats_daily (template_id, day, org_id, previews, uses) values ($1, current_date, $2, 3, 1)`, [tpl.orgTemplateId, s.orgId]);
  await owner.query(`insert into template_signing_keys (id, key_id, org_id, public_key, alg, label) values ($1, $2, $3, $4, 'es256', 'org key')`, [
    randomUUID(),
    tpl.keyId,
    s.orgId,
    Buffer.alloc(65, 4),
  ]);
  await owner.query(`insert into template_search_synonyms (org_id, term, expands_to) values ($1, 'vendor', '{supplier}')`, [s.orgId]);
  await owner.query(`insert into template_search_misses (org_id, q_norm, locale) values ($1, 'gst invoice', 'en-IN')`, [s.orgId]);
  await owner.query(
    `insert into template_packs (id, org_id, publisher, name, version, manifest, manifest_hash, verification, imported_by)
     values ($1, $2, 'acme', 'acme-pack', '1.0.0', '{}', $3, 'unsigned', $4)`,
    [randomUUID(), s.orgId, HASH, s.ownerId],
  );
  return tpl;
}

async function seedOrg(owner: pg.Pool, slug: string, system: SystemSeed): Promise<OrgSeed> {
  const s: Omit<OrgSeed, 'tpl'> = {
    orgId: randomUUID(),
    ownerId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    teamId: randomUUID(),
    formIds: [randomUUID(), randomUUID()],
  };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [s.orgId, slug, `Org ${slug}`]);
  await owner.query('insert into org_settings (org_id) values ($1)', [s.orgId]);
  for (const [id, who] of [
    [s.ownerId, 'owner'],
    [s.editorId, 'editor'],
    [s.viewerId, 'viewer'],
  ] as const) {
    await owner.query('insert into users (id, email, email_norm, password_hash) values ($1, $2, $2, $3)', [id, `${who}@${slug}.test`, 'argon2id$secret']);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [s.orgId, id, who]);
  }
  for (const [i, formId] of s.formIds.entries()) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [
      formId,
      s.orgId,
      s.teamId,
      s.ownerId,
      `${slug} form ${i + 1}`,
    ]);
    await owner.query(
      `insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by) values ($1, $2, '{"blocks":[]}', 2, 13, $3)`,
      [formId, s.orgId, s.ownerId],
    );
  }
  await owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, 'pwd', now() + interval '1 hour', now() + interval '1 day')`,
    [randomUUID(), randomBytes(32), s.editorId],
  );
  await owner.query(`insert into user_identities (id, user_id, provider, subject) values ($1, $2, 'google', $3)`, [randomUUID(), s.editorId, `sub-${s.editorId}`]);
  await owner.query(`insert into auth_tokens (id, token_hash, purpose, user_id, expires_at) values ($1, $2, 'magic_link', $3, now() + interval '15 minutes')`, [
    randomUUID(),
    randomBytes(32),
    s.editorId,
  ]);
  await owner.query(
    `insert into user_notice_acks (id, user_id, notice_version, notice_hash, locale, context) values ($1, $2, '2026-10-19', $3, 'en-IN', 'signup')`,
    [randomUUID(), s.editorId, randomBytes(32)],
  );
  await owner.query(
    `insert into user_grievances (id, user_id, reference, category, message, due_at) values ($1, $2, $3, 'information', 'What do you hold?', now() + interval '90 days')`,
    [randomUUID(), s.editorId, `GRV-${randomBytes(5).toString('hex').slice(0, 8).toUpperCase().replace(/[01890]/g, 'A')}`],
  );
  await owner.query(
    `insert into invites (id, org_id, email, email_norm, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $3, 'viewer', $4, $5, now() + interval '7 days')`,
    [randomUUID(), s.orgId, `invitee@${slug}.test`, randomBytes(32), s.ownerId],
  );
  await owner.query(
    `insert into audit_log (org_id, seq, occurred_at, actor_kind, actor_id, action, resource_type, resource_id, outcome, prev_hash, hash)
     values ($1, 1, now(), 'user', $2, 'form.created', 'form', $3, 'success', $4, $4)`,
    [s.orgId, s.ownerId, s.formIds[0], HASH],
  );
  await owner.query(
    `insert into audit_checkpoints (org_key, seq, hash, signed_at, key_id, alg, signature) values ($1, 1, $2, now(), 'test', 'ed25519', $3)`,
    [s.orgId, HASH, Buffer.alloc(64)],
  );
  await owner.query(
    `insert into audit_archives (org_key, month, object_key, row_count, min_seq, max_seq, sha256) values ($1, '2020-01', 'archive/x', 1, 1, 1, $2)`,
    [s.orgId, HASH],
  );
  return { ...s, tpl: await seedOrgTemplates(owner, s, slug, system) };
}

export async function seedTwoOrgs(owner: pg.Pool): Promise<Seed> {
  const tag = randomUUID().slice(0, 8);
  const system = await seedSystem(owner, tag);
  return { a: await seedOrg(owner, `a-${tag}`, system), b: await seedOrg(owner, `b-${tag}`, system), system };
}

/** The SQLSTATE of a pg error, also when drizzle wraps it. */
export function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected the statement to fail');
    },
    (err: unknown) => err,
  );
}
