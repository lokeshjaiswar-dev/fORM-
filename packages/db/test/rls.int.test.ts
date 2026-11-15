import { randomBytes, randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountDelete,
  assertTenantCtx,
  formAccessPasswordHash,
  formAccess,
  formAccessPublicColumns,
  forms,
  orgs,
  userPublicColumns,
  users,
  withTenant,
  withUser,
  type TenantCtx,
  type Tx,
} from '../src/index.ts';
import { failure, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';
import { isolationSuite, publicTables, type TableSpec } from './isolation.ts';

let t: TestDb;
let seed: Seed;

/** The password hash seeded for each org's first form (form_access), by org id. */
const PASSWORD_HASHES: Record<string, string> = {};

/**
 * Rows of the FormOps tables (migration 0020) for both orgs, so the isolation suite has own rows to see and foreign rows
 * to be refused. Counters and version states come with the seeded forms and versions (triggers); the slug is set on the
 * form, which registers it as the primary one (trigger), and an old slug is added beside it.
 */
async function seedFormOps(s: Seed): Promise<void> {
  for (const o of [s.a, s.b]) {
    const tag = o.orgId.slice(0, 8);
    PASSWORD_HASHES[o.orgId] = `argon2id$hash-${tag}`;
    await t.owner.query(
      `insert into form_access (form_id, org_id, submission_limit, password_hash, password_updated_at) values ($1, $2, 50, $3, now()), ($4, $2, null, null, null)`,
      [o.formIds[0], o.orgId, PASSWORD_HASHES[o.orgId], o.formIds[1]],
    );
    await t.owner.query('update forms set slug = $1 where id = $2', [`form-${tag}`, o.formIds[0]]);
    await t.owner.query('insert into form_slugs (slug, org_id, form_id) values ($1, $2, $3)', [`old-${tag}`, o.orgId, o.formIds[0]]);
    await t.owner.query('insert into form_favourites (form_id, user_id, org_id) values ($1, $2, $3), ($1, $4, $3)', [o.formIds[0], o.editorId, o.orgId, o.ownerId]);
  }
}

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
  await seedFormOps(seed);
});
afterAll(() => t?.close());

const env = () => ({ t, seed });

/** Actor kinds `app_reads_templates()` admits: respondents read no template content. */
const TEMPLATE_READERS = ['user', 'api_key', 'system', 'platform'] as const;

/**
 * Every table in public, with what org B's actors may do to org A's rows (CMP-01). The suite is generated per table
 * and actor kind; a new table fails `covers every table` until it is listed here.
 */
const TABLES: Record<string, TableSpec> = {
  orgs: { scope: { by: 'org', column: 'id' }, select: 0, touch: 'name', update: 0, delete: 'denied' },
  org_settings: { scope: { by: 'org' }, select: 0, touch: 'invite_days', update: 0, delete: 'denied' },
  users: { scope: { by: 'user', column: 'id' }, select: 0, touch: 'name', update: 0, delete: 'denied' },
  memberships: { scope: { by: 'org' }, select: 0, touch: 'role', update: 0, delete: 0 },
  invites: { scope: { by: 'org' }, select: 0, touch: 'revoked_at', update: 0, delete: 'denied', visibleTo: ['system'] },
  sessions: { scope: { by: 'user' }, select: 0, touch: 'revoked_at', update: 0, delete: 'denied', visibleTo: ['user'] },
  user_identities: { scope: { by: 'user' }, select: 0, touch: 'last_used_at', update: 0, delete: 0, visibleTo: ['user'] },
  auth_tokens: { scope: { by: 'user' }, select: 0, touch: 'consumed_at', update: 0, delete: 'denied', visibleTo: ['user'] },
  user_notice_acks: {
    scope: { by: 'user' },
    select: 0,
    touch: 'locale',
    update: 'denied',
    delete: 'denied',
    visibleTo: ['user'],
    insertForeign: (s) =>
      sql`insert into user_notice_acks (id, user_id, notice_version, notice_hash, locale, context)
          values (${randomUUID()}, ${s.a.editorId}, '2026-10-19', ${Buffer.alloc(32, 3)}, 'en-IN', 'settings')`,
  },
  user_grievances: {
    scope: { by: 'user' },
    select: 0,
    touch: 'status',
    update: 'denied',
    delete: 'denied',
    visibleTo: ['user'],
    insertForeign: (s) =>
      sql`insert into user_grievances (id, user_id, reference, category, message, due_at)
          values (${randomUUID()}, ${s.a.editorId}, 'GRV-AAAAAAAA', 'other', 'x', now() + interval '1 day')`,
  },
  auth_throttle: {
    scope: { by: 'custom', foreign: () => sql`true` },
    select: 'denied',
    touch: 'hits',
    update: 'denied',
    delete: 'denied',
    insertForeign: () => sql`insert into auth_throttle (bucket, key, window_start, hits) values ('auth_any', ${Buffer.alloc(1)}, now(), 1)`,
  },
  forms: { scope: { by: 'org' }, select: 0, touch: 'title', update: 0, delete: 0 },
  form_drafts: { scope: { by: 'org' }, select: 0, touch: 'draft_rev', update: 0, delete: 0 },
  // Published versions never change (PUB-01, migration 0020): fr_app has no UPDATE or DELETE privilege at all.
  form_versions: {
    scope: { by: 'org' },
    select: 0,
    touch: 'content_hash',
    update: 'denied',
    delete: 'denied',
    insertForeign: (s) =>
      sql`insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash)
          values (${randomUUID()}, ${s.a.orgId}, ${s.a.formIds[0]}, 9, 2, ${s.a.ownerId}, '{}', '{}', '0')`,
  },
  // FormOps (WP-1.07, migration 0020). Respondent contexts read these rows (the access rules, the counter) and write
  // only what the submit transaction must; the dedicated describes below check that part.
  form_version_state: { scope: { by: 'org' }, select: 0, touch: 'superseded_at', update: 0, delete: 'denied' },
  form_access: { scope: { by: 'org' }, select: 0, touch: 'rev', update: 0, delete: 'denied' },
  form_slugs: { scope: { by: 'org' }, select: 0, touch: 'is_primary', update: 0, delete: 'denied' },
  form_counters: { scope: { by: 'org' }, select: 0, touch: 'submitted_total', update: 0, delete: 'denied' },
  // A star is personal: only a user context sees any rows, and only its own (see the favourites describe).
  form_favourites: { scope: { by: 'org' }, select: 0, update: 'denied', delete: 0, visibleTo: ['user'] },
  form_submissions: {
    scope: { by: 'org' },
    select: 0,
    touch: 'locale',
    update: 0,
    delete: 0,
    visibleTo: ['system'],
    insertForeign: (s) =>
      sql`insert into form_submissions (id, org_id, form_id, answers, fields)
          values (${randomUUID()}, ${s.a.orgId}, ${s.a.formIds[0]}, '{}', '[]')`,
  },
  form_files: {
    scope: { by: 'org' },
    select: 0,
    touch: 'name',
    update: 'denied',
    delete: 0,
    visibleTo: ['system'],
    insertForeign: (s) =>
      sql`insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256)
          values (${randomUUID()}, ${s.a.orgId}, ${s.a.formIds[0]}, 'upload', 'cv.pdf', 'application/pdf', 4, ${'0'.repeat(64)})`,
  },
  audit_log: { scope: { by: 'org' }, select: 0, touch: 'reason', update: 'denied', delete: 'denied' },
  audit_pending: { scope: { by: 'org', column: 'org_key' }, select: 'denied', touch: 'event', update: 'denied', delete: 'denied' },
  audit_heads: { scope: { by: 'org', column: 'org_key' }, select: 0, touch: 'seq', update: 'denied', delete: 'denied' },
  audit_checkpoints: {
    scope: { by: 'org', column: 'org_key' },
    select: 0,
    touch: 'key_id',
    update: 'denied',
    delete: 'denied',
    // seq 1 with the zero hash is a real link of org A, so only RLS stands in the way.
    insertForeign: (s) =>
      sql`insert into audit_checkpoints (org_key, seq, hash, signed_at, key_id, alg, signature)
          values (${s.a.orgId}, 1, ${Buffer.alloc(32)}, now(), 'k2', 'ed25519', ${Buffer.alloc(64)})`,
  },
  audit_archives: { scope: { by: 'org', column: 'org_key' }, select: 0, touch: 'object_key', update: 'denied', delete: 'denied' },
  // Templates (WP-T1.1). Template content is for builder-side actors only; the system rows show in the counts of every
  // other actor kind. Children get their org from the parent (trigger), so their foreign inserts name a parent of org A.
  template_packs: { scope: { by: 'org' }, select: 0, touch: 'version', update: 'denied', delete: 'denied' },
  templates: { scope: { by: 'org' }, select: 0, touch: 'tags', update: 0, delete: 'denied', visibleTo: TEMPLATE_READERS },
  template_versions: {
    scope: { by: 'org' },
    select: 0,
    touch: 'changelog',
    update: 0,
    delete: 0,
    visibleTo: TEMPLATE_READERS,
    insertForeign: (s) =>
      sql`insert into template_versions (id, template_id, version, schema_version, payload, payload_hash)
          values (${randomUUID()}, ${s.a.tpl.orgTemplateId}, 9, 1, '{}', ${Buffer.alloc(32)})`,
  },
  template_localizations: {
    scope: { by: 'org' },
    select: 0,
    touch: 'title',
    update: 0,
    delete: 0,
    visibleTo: TEMPLATE_READERS,
    insertForeign: (s) => sql`insert into template_localizations (template_version_id, locale, title, summary) values (${s.a.tpl.orgV1Id}, 'hi-IN', 'x', 'x')`,
  },
  template_categories: { scope: { by: 'org' }, select: 0, touch: 'sort', update: 0, delete: 0, visibleTo: TEMPLATE_READERS },
  template_category_links: {
    scope: { by: 'org' },
    select: 0,
    touch: 'category_id',
    update: 'denied',
    delete: 0,
    visibleTo: TEMPLATE_READERS,
    insertForeign: (s) => sql`insert into template_category_links (template_id, category_id) values (${s.a.tpl.teamTemplateId}, ${s.system.categoryId})`,
  },
  brand_kits: { scope: { by: 'org' }, select: 0, touch: 'name', update: 0, delete: 'denied' },
  form_template_bindings: {
    scope: { by: 'org' },
    select: 0,
    touch: 'update_state',
    update: 0,
    delete: 0,
    insertForeign: (s) =>
      sql`insert into form_template_bindings (id, org_id, form_id, template_id, template_version_id, kind, id_map)
          values (${randomUUID()}, ${s.a.orgId}, ${s.a.formIds[1]}, ${s.system.templateId}, ${s.system.versionId}, 'form', '{}')`,
  },
  template_fork_bindings: {
    scope: { by: 'org' },
    select: 0,
    touch: 'update_state',
    update: 0,
    delete: 0,
    insertForeign: (s) =>
      sql`insert into template_fork_bindings (id, org_id, template_id, upstream_template_id, upstream_version_id, id_map)
          values (${randomUUID()}, ${s.a.orgId}, ${s.a.tpl.forkTemplateId}, ${s.system.templateId}, ${s.system.versionId}, '{}')`,
  },
  template_usages: {
    scope: { by: 'org' },
    select: 0,
    touch: 'locale',
    update: 'denied',
    delete: 'denied',
    insertForeign: (s) =>
      sql`insert into template_usages (org_id, template_id, template_version_id, action) values (${s.a.orgId}, ${s.system.templateId}, ${s.system.versionId}, 'preview')`,
  },
  template_stats_daily: { scope: { by: 'org' }, select: 0, touch: 'uses', update: 'denied', delete: 'denied', visibleTo: TEMPLATE_READERS },
  template_signing_keys: { scope: { by: 'org' }, select: 0, touch: 'label', update: 0, delete: 'denied', visibleTo: TEMPLATE_READERS },
  template_search_synonyms: { scope: { by: 'org' }, select: 0, touch: 'term', update: 0, delete: 0, visibleTo: TEMPLATE_READERS },
  template_search_misses: { scope: { by: 'org' }, select: 0, touch: 'count', update: 0, delete: 0 },
  captcha_redemptions: {
    scope: { by: 'org' },
    select: 0,
    touch: 'expires_at',
    update: 'denied',
    delete: 0,
    insertForeign: (s) =>
      sql`insert into captcha_redemptions (org_id, challenge_hash, expires_at) values (${s.a.orgId}, ${randomBytes(32)}, now())`,
  },
  submission_search: {
    scope: { by: 'org' },
    select: 0,
    touch: 'locale',
    update: 0,
    delete: 0,
    visibleTo: ['system'],
    insertForeign: (s) =>
      sql`insert into submission_search (submission_id, received_at, org_id, form_id, locale, doc)
          values (${randomUUID()}, now(), ${s.a.orgId}, ${s.a.formIds[0]}, 'en-IN', to_tsvector('simple', 'x'))`,
  },
};

isolationSuite(TABLES, env);

describe('isolation suite', () => {
  it('covers every table in public', async () => {
    expect(Object.keys(TABLES).sort()).toEqual(await publicTables(t));
  });
});

const userCtx = (): TenantCtx => ({ orgId: seed.b.orgId, actor: 'user', userId: seed.b.editorId, perms: ['forms.read'], requestId: 'r1' });

describe('tenant context', () => {
  it('sees zero rows outside withTenant, without raising', async () => {
    for (const table of Object.keys(TABLES).filter((n) => TABLES[n]!.select === 0)) {
      const { rows } = await t.app.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(rows[0]!.n, table).toBe(0);
    }
  });

  it('keeps settings transaction-local, so a pooled connection does not leak the tenant', async () => {
    await withTenant(t.app.db, userCtx(), async (tx) => {
      expect((await tx.select({ id: forms.id }).from(forms)).length).toBe(2);
    });
    const clients = await Promise.all([t.app.pool.connect(), t.app.pool.connect()]);
    try {
      for (const c of clients) {
        const { rows } = await c.query<{ org: string | null; n: number }>(`select app_org() as org, (select count(*)::int from forms) as n`);
        expect(rows[0]).toEqual({ org: null, n: 0 });
      }
    } finally {
      for (const c of clients) c.release();
    }
  });

  it('runs drizzle queries under the tenant and returns only its rows', async () => {
    const rows = await withTenant(t.app.db, { ...userCtx(), readOnly: true }, (tx) =>
      tx.select({ id: forms.id, orgId: forms.orgId }).from(forms).orderBy(desc(forms.updatedAt)),
    );
    expect(rows.map((r) => r.orgId)).toEqual([seed.b.orgId, seed.b.orgId]);
    const [org] = await withTenant(t.app.db, userCtx(), (tx) => tx.select().from(orgs));
    expect(org?.id).toBe(seed.b.orgId);
  });

  it('refuses writes in read-only mode', async () => {
    const err = await failure(withTenant(t.app.db, { ...userCtx(), readOnly: true }, (tx) => tx.update(forms).set({ title: 'x' }).where(eq(forms.id, seed.b.formIds[0]))));
    expect(pgCode(err)).toBe('25006');
  });

  it('writes in read-write mode within the tenant', async () => {
    const changed = await withTenant(t.app.db, userCtx(), (tx) =>
      tx.update(forms).set({ title: 'renamed' }).where(eq(forms.id, seed.b.formIds[1])).returning({ id: forms.id }),
    );
    expect(changed).toEqual([{ id: seed.b.formIds[1] }]);
  });

  it('cannot point a draft at another org’s form', async () => {
    const formWithoutDraft = randomUUID();
    await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [
      formWithoutDraft,
      seed.a.orgId,
      seed.a.teamId,
      seed.a.ownerId,
      'no draft yet',
    ]);
    const err = await failure(
      withTenant(t.app.db, { ...userCtx(), perms: ['forms.read', 'forms.edit'] }, (tx) =>
        tx.execute(sql`insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by)
                       values (${formWithoutDraft}, ${seed.b.orgId}, '{}', 2, 2, ${seed.b.editorId})`),
      ),
    );
    expect(pgCode(err)).toBe('23503');
  });

  it('never exposes credential columns to fr_app', async () => {
    const err = await failure(withTenant(t.app.db, userCtx(), (tx) => tx.select().from(users)));
    expect(pgCode(err)).toBe('42501');
    const visible = await withTenant(t.app.db, userCtx(), (tx) => tx.select(userPublicColumns).from(users));
    expect(visible.map((u) => u.id).sort()).toEqual([seed.b.ownerId, seed.b.editorId, seed.b.viewerId].sort());
  });

  it('lets api-key, system and respondent actors (no user id) query users without raising', async () => {
    for (const actor of ['api_key', 'system', 'respondent'] as const) {
      const rows = await withTenant(t.app.db, { orgId: seed.b.orgId, actor, requestId: 'r' }, (tx) => tx.select({ id: users.id }).from(users));
      expect(rows.length, actor).toBe(3);
    }
  });

  it('denies a direct SELECT on a partition', async () => {
    const { rows } = await t.owner.query<{ name: string }>(
      `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.audit_log'::regclass and c.relkind = 'r' limit 1`,
    );
    const partition = rows[0]!.name;
    const err = await failure(withTenant(t.app.db, userCtx(), (tx) => tx.execute(sql.raw(`select * from parts.${partition}`))));
    expect(pgCode(err)).toBe('42501');
    expect(String((err as { cause?: { message?: string } }).cause?.message ?? err)).toMatch(/permission denied/);
  });

  it('rejects malformed contexts before any SQL runs', () => {
    const base = userCtx();
    expect(() => assertTenantCtx(base)).not.toThrow();
    expect(() => assertTenantCtx({ ...base, orgId: 'acme' })).toThrow(/orgId/);
    expect(() => assertTenantCtx({ ...base, userId: null })).toThrow(/userId/);
    expect(() => assertTenantCtx({ ...base, userId: 'x' })).toThrow(/userId/);
    expect(() => assertTenantCtx({ ...base, actor: 'root' as TenantCtx['actor'] })).toThrow(/actor/);
    expect(() => assertTenantCtx({ ...base, perms: ['forms.read", "x'] })).toThrow(/perms/);
    expect(() => assertTenantCtx({ ...base, teamIds: ['x'] })).toThrow(/teamIds/);
    expect(() => assertTenantCtx({ ...base, subjectIds: [randomUUID()] })).toThrow(/respondent/);
    expect(() => assertTenantCtx({ ...base, actor: 'respondent', subjectIds: ['x'] })).toThrow(/subjectIds/);
    expect(() => assertTenantCtx({ ...base, requestId: '' })).toThrow(/requestId/);
  });
});

describe('submission_search data access (architecture §2.2, C-M8)', () => {
  const doc = (submissionId: string, text: string) =>
    sql`insert into submission_search (submission_id, received_at, org_id, form_id, locale, doc)
        values (${submissionId}, now(), ${seed.b.orgId}, ${seed.b.formIds[0]}, 'en-IN', to_tsvector('simple', ${text}))`;
  const as = <T>(ctx: Omit<TenantCtx, 'requestId' | 'orgId'>, fn: (tx: Tx) => Promise<T>) =>
    withTenant(t.app.db, { orgId: seed.b.orgId, requestId: 'search-access', ...ctx }, fn);
  const visible = async (ctx: Omit<TenantCtx, 'requestId' | 'orgId'>) =>
    as(ctx, async (tx) => (await tx.execute<{ id: string }>(sql`select submission_id::text as id from submission_search`)).rows.map((r) => r.id));
  const ownCount = async () =>
    (await t.owner.query<{ n: number }>('select count(*)::int as n from submission_search where org_id = $1', [seed.b.orgId])).rows[0]!.n;

  it('lets the respondent submit transaction insert a document it then cannot read, change or delete', async () => {
    const id = randomUUID();
    const before = await ownCount();
    // As the SearchIndex adapter inserts. An arbiter (`on conflict (cols)`) needs read access, so it would be refused.
    await as({ actor: 'respondent', subjectIds: [randomUUID()] }, (tx) => tx.execute(sql`${doc(id, 'my answers')} on conflict do nothing`));
    const arbiter = as({ actor: 'respondent', subjectIds: [randomUUID()] }, (tx) =>
      tx.execute(sql`${doc(randomUUID(), 'x')} on conflict (submission_id, received_at) do nothing`),
    );
    expect(pgCode(await failure(arbiter))).toBe('42501');
    expect(await ownCount()).toBe(before + 1);
    const respondent = { actor: 'respondent', subjectIds: [randomUUID()] } as const;
    expect(await visible(respondent)).toEqual([]);
    const changed = await as(respondent, (tx) => tx.execute(sql`update submission_search set locale = 'hi-IN' returning 1`));
    expect(changed.rows).toEqual([]);
    const removed = await as(respondent, (tx) => tx.execute(sql`delete from submission_search returning 1`));
    expect(removed.rows).toEqual([]);
    expect(await ownCount()).toBe(before + 1);
  });

  it('shows a respondent only the documents of submissions whose token was verified', async () => {
    const id = randomUUID();
    await as({ actor: 'system' }, (tx) => tx.execute(doc(id, 'edited later')));
    expect(await visible({ actor: 'respondent', subjectIds: [id] })).toEqual([id]);
  });

  it('hides the documents from users and API keys without submissions.read', async () => {
    expect(await visible({ actor: 'user', userId: seed.b.editorId, perms: ['forms.read', 'forms.edit', 'submissions.export'] })).toEqual([]);
    expect(await visible({ actor: 'api_key', perms: ['forms.read'] })).toEqual([]);
    const before = await ownCount();
    const removed = await as({ actor: 'user', userId: seed.b.editorId, perms: ['forms.edit'] }, (tx) => tx.execute(sql`delete from submission_search returning 1`));
    expect(removed.rows).toEqual([]);
    expect(await ownCount()).toBe(before);
  });

  it('shows them to system jobs and to readers with submissions.read', async () => {
    const all = await visible({ actor: 'system' });
    expect(all.length).toBe(await ownCount());
    expect((await visible({ actor: 'user', userId: seed.b.viewerId, perms: ['submissions.read'] })).sort()).toEqual(all.sort());
    expect((await visible({ actor: 'api_key', perms: ['submissions.read'] })).sort()).toEqual(all.sort());
  });
});

describe('form_submissions and form_files data access (architecture §2.2, SR-5)', () => {
  type Ctx = Omit<TenantCtx, 'requestId' | 'orgId'>;
  const as = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>) => withTenant(t.app.db, { orgId: seed.b.orgId, requestId: 'data-access', ...ctx }, fn);
  const respondent: Ctx = { actor: 'respondent' };
  const noRead = (): Ctx => ({ actor: 'user', userId: seed.b.editorId, perms: ['forms.read', 'forms.edit', 'forms.publish', 'submissions.export'] });
  const readerCtx = (): Ctx => ({ actor: 'user', userId: seed.b.viewerId, perms: ['forms.read', 'submissions.read'] });
  const rows = async (table: 'form_submissions' | 'form_files', ctx: Ctx) =>
    as(ctx, async (tx) => Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.identifier(table)}`)).rows[0]!.n));
  const ownRows = async (table: 'form_submissions' | 'form_files') =>
    Number((await t.owner.query<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [seed.b.orgId])).rows[0]!.n);
  const insertFile = (id: string, formId = seed.b.formIds[0], blockId = 'cv') =>
    t.owner.query(`insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256) values ($1, $2, $3, $4, 'cv.pdf', 'application/pdf', 4, $5)`, [
      id,
      seed.b.orgId,
      formId,
      blockId,
      'a'.repeat(64),
    ]);

  it('lets a respondent transaction insert a submission and a file row, and nothing more: no read, change or delete', async () => {
    const submissionId = randomUUID();
    const fileId = randomUUID();
    await as(respondent, async (tx) => {
      await tx.execute(sql`insert into form_submissions (id, org_id, form_id, answers, fields) values (${submissionId}, ${seed.b.orgId}, ${seed.b.formIds[0]}, '{"q":{"type":"short_text","value":"private"}}', '[]')`);
      await tx.execute(
        sql`insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256) values (${fileId}, ${seed.b.orgId}, ${seed.b.formIds[0]}, 'cv', 'cv.pdf', 'application/pdf', 4, ${'b'.repeat(64)})`,
      );
    });
    const submissions = await ownRows('form_submissions');
    const files = await ownRows('form_files');
    expect(submissions).toBeGreaterThan(0);
    expect(files).toBeGreaterThan(0);
    expect(await rows('form_submissions', respondent)).toBe(0);
    expect(await rows('form_files', respondent)).toBe(0);
    const changed = await as(respondent, (tx) => tx.execute(sql`update form_submissions set locale = 'hi-IN' returning 1`));
    expect(changed.rows).toEqual([]);
    for (const table of ['form_submissions', 'form_files'] as const) {
      const removed = await as(respondent, (tx) => tx.execute(sql`delete from ${sql.identifier(table)} returning 1`));
      expect(removed.rows, table).toEqual([]);
    }
    expect(await ownRows('form_submissions')).toBe(submissions);
    expect(await ownRows('form_files')).toBe(files);
    // The file row can neither be read back as the insert's RETURNING, nor by id.
    const returning = await failure(as(respondent, (tx) => tx.execute(sql`insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256) values (${randomUUID()}, ${seed.b.orgId}, ${seed.b.formIds[0]}, 'cv', 'x', 'x', 1, 'x') returning id`)));
    expect(pgCode(returning)).toBe('42501');
  });

  it('shows a respondent the submissions whose verified token it holds, and still no file rows', async () => {
    const mine = randomUUID();
    await t.owner.query(`insert into form_submissions (id, org_id, form_id, answers, fields) values ($1, $2, $3, '{}', '[]')`, [mine, seed.b.orgId, seed.b.formIds[0]]);
    const seen = await as({ actor: 'respondent', subjectIds: [mine] }, async (tx) => (await tx.execute<{ id: string }>(sql`select id from form_submissions`)).rows.map((r) => r.id));
    expect(seen).toEqual([mine]);
    expect(await rows('form_files', { actor: 'respondent', subjectIds: [mine] })).toBe(0);
  });

  it('hides both tables from members and API keys without submissions.read, and lets them change nothing', async () => {
    for (const ctx of [noRead(), { actor: 'api_key', perms: ['forms.read', 'forms.edit'] } as Ctx]) {
      expect(await rows('form_submissions', ctx)).toBe(0);
      expect(await rows('form_files', ctx)).toBe(0);
      const submissions = await ownRows('form_submissions');
      const files = await ownRows('form_files');
      expect((await as(ctx, (tx) => tx.execute(sql`update form_submissions set locale = 'hi-IN' returning 1`))).rows).toEqual([]);
      expect((await as(ctx, (tx) => tx.execute(sql`delete from form_submissions returning 1`))).rows).toEqual([]);
      expect((await as(ctx, (tx) => tx.execute(sql`delete from form_files returning 1`))).rows).toEqual([]);
      expect([await ownRows('form_submissions'), await ownRows('form_files')]).toEqual([submissions, files]);
    }
  });

  it('shows them to readers and system jobs; deleting needs submissions.delete or a system job', async () => {
    const all = await ownRows('form_submissions');
    const files = await ownRows('form_files');
    expect(await rows('form_submissions', readerCtx())).toBe(all);
    expect(await rows('form_files', readerCtx())).toBe(files);
    expect(await rows('form_submissions', { actor: 'system' })).toBe(all);
    // A reader may read, not delete or edit.
    expect((await as(readerCtx(), (tx) => tx.execute(sql`delete from form_files returning 1`))).rows).toEqual([]);
    expect((await as(readerCtx(), (tx) => tx.execute(sql`update form_submissions set locale = 'hi-IN' returning 1`))).rows).toEqual([]);
    const id = randomUUID();
    await insertFile(id);
    const deleter: Ctx = { actor: 'user', userId: seed.b.ownerId, perms: ['submissions.read', 'submissions.delete'] };
    expect((await as(deleter, (tx) => tx.execute(sql`delete from form_files where id = ${id} returning 1`))).rows).toHaveLength(1);
    const again = randomUUID();
    await insertFile(again);
    expect((await as({ actor: 'system' }, (tx) => tx.execute(sql`delete from form_files where id = ${again} returning 1`))).rows).toHaveLength(1);
  });

  it('never lets a respondent context write forms: no update, no insert, no delete', async () => {
    const before = (await t.owner.query<{ title: string }>('select title from forms where id = $1', [seed.b.formIds[0]])).rows[0]!.title;
    const update = await as(respondent, (tx) => tx.execute(sql`update forms set title = 'hijacked', submission_count = 999 where id = ${seed.b.formIds[0]}`));
    expect(update.rowCount).toBe(0);
    const del = await as(respondent, (tx) => tx.execute(sql`delete from forms where id = ${seed.b.formIds[1]}`));
    expect(del.rowCount).toBe(0);
    const insert = await failure(
      as(respondent, (tx) => tx.execute(sql`insert into forms (id, org_id, team_id, owner_user_id, title) values (${randomUUID()}, ${seed.b.orgId}, ${seed.b.teamId}, ${seed.b.ownerId}, 'planted')`)),
    );
    expect(pgCode(insert)).toBe('42501');
    expect((await t.owner.query<{ title: string }>('select title from forms where id = $1', [seed.b.formIds[0]])).rows[0]!.title).toBe(before);
    // Members still edit their forms.
    const renamed = await as({ actor: 'user', userId: seed.b.editorId, perms: ['forms.read', 'forms.edit'] }, (tx) =>
      tx.execute(sql`update forms set title = ${before} where id = ${seed.b.formIds[0]}`),
    );
    expect(renamed.rowCount).toBe(1);
  });

  it('form_files_check tells a respondent only what the upload route recorded, for ids of this form of its own org', async () => {
    const mine = randomUUID();
    const otherForm = randomUUID();
    const foreign = randomUUID();
    await insertFile(mine, seed.b.formIds[0], 'cv');
    await insertFile(otherForm, seed.b.formIds[1], 'cv');
    await t.owner.query(`insert into form_files (id, org_id, form_id, block_id, name, mime, size_bytes, sha256) values ($1, $2, $3, 'cv', 'a.pdf', 'application/pdf', 4, $4)`, [
      foreign,
      seed.a.orgId,
      seed.a.formIds[0],
      'c'.repeat(64),
    ]);
    const check = (formId: string, ids: string[], orgId = seed.b.orgId) =>
      withTenant(t.app.db, { orgId, actor: 'respondent', requestId: 'check', readOnly: true }, (tx) =>
        tx.execute<{ id: string; block_id: string; purpose: string; name: string; size_bytes: number }>(
          sql`select * from form_files_check(${formId}::uuid, ${`{${ids.join(',')}}`}::uuid[])`,
        ),
      );
    const found = await check(seed.b.formIds[0], [mine, otherForm, foreign, randomUUID()]);
    expect(found.rows).toEqual([{ id: mine, block_id: 'cv', purpose: 'file', name: 'cv.pdf', mime: 'application/pdf', size_bytes: 4, sha256: 'a'.repeat(64) }]);
    // Org A's file is invisible from org B's context, even under org A's own form id.
    expect((await check(seed.a.formIds[0], [foreign])).rows).toEqual([]);
    expect((await check(seed.a.formIds[0], [foreign], seed.a.orgId)).rows).toHaveLength(1);
    // No tenant context, no rows. And a long list is refused outright.
    const bare = await t.app.db.execute<{ id: string }>(sql`select id from form_files_check(${seed.b.formIds[0]}::uuid, ${`{${mine}}`}::uuid[])`);
    expect(bare.rows).toEqual([]);
    const many = Array.from({ length: 101 }, () => randomUUID());
    many[0] = mine;
    expect((await check(seed.b.formIds[0], many)).rows).toEqual([]);
  });

  it('counts a stored submission and holds the files its answers name, whoever inserts it', async () => {
    const held = randomUUID();
    const strayFile = randomUUID();
    const otherForms = randomUUID();
    await insertFile(held, seed.b.formIds[0]);
    await insertFile(strayFile, seed.b.formIds[0]);
    await insertFile(otherForms, seed.b.formIds[1]);
    const before = (await t.owner.query<{ n: string }>('select submission_count::text as n from forms where id = $1', [seed.b.formIds[0]])).rows[0]!.n;
    const submissionId = randomUUID();
    await as(respondent, (tx) =>
      tx.execute(sql`insert into form_submissions (id, org_id, form_id, answers, fields) values (
        ${submissionId}, ${seed.b.orgId}, ${seed.b.formIds[0]},
        ${JSON.stringify({ cv: { type: 'file_upload', value: [{ fileId: held, name: 'cv.pdf' }, { fileId: otherForms, name: 'x.pdf' }] } })}::jsonb, '[]')`),
    );
    const { rows } = await t.owner.query<{ id: string; submission_id: string | null }>('select id, submission_id from form_files where id = any ($1)', [[held, strayFile, otherForms]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.submission_id]));
    expect(by).toEqual({ [held]: submissionId, [strayFile]: null, [otherForms]: null });
    const after = (await t.owner.query<{ n: string; at: Date | null }>('select submission_count::text as n, last_submission_at as at from forms where id = $1', [seed.b.formIds[0]])).rows[0]!;
    expect(Number(after.n)).toBe(Number(before) + 1);
    expect(after.at).toBeInstanceOf(Date);
    // Deleting the submission un-holds the file (the orphan sweep then removes it).
    await t.owner.query('delete from form_submissions where id = $1', [submissionId]);
    expect((await t.owner.query('select submission_id from form_files where id = $1', [held])).rows).toEqual([{ submission_id: null }]);
  });
});

// FormOps (WP-1.07, migration 0020). Org B's contexts; the isolation suite above covers the cross-org half.
type FormOpsCtx = Omit<TenantCtx, 'requestId' | 'orgId'>;
const formOpsAs = <T>(ctx: FormOpsCtx, fn: (tx: Tx) => Promise<T>, orgId: string = seed.b.orgId) =>
  withTenant(t.app.db, { orgId, requestId: 'form-ops', ...ctx }, fn);
const ownerOf = (): FormOpsCtx => ({ actor: 'user', userId: seed.b.ownerId, perms: ['forms.read', 'forms.publish', 'ops.manage'] });
const editorOf = (): FormOpsCtx => ({ actor: 'user', userId: seed.b.editorId, perms: ['forms.read', 'forms.edit', 'forms.publish', 'ops.manage'] });
const viewerOf = (): FormOpsCtx => ({ actor: 'user', userId: seed.b.viewerId, perms: ['forms.read'] });
const respondentCtx: FormOpsCtx = { actor: 'respondent' };
const systemCtx: FormOpsCtx = { actor: 'system' };
const apiKeyCtx: FormOpsCtx = { actor: 'api_key', perms: ['forms.read', 'ops.manage'] };

describe('form_versions are immutable (PUB-01)', () => {
  const versionOf = async (formId: string, number = 1) =>
    (await t.owner.query<{ id: string }>('select id from form_versions where form_id = $1 and number = $2', [formId, number])).rows[0]!.id;
  const hashOf = async (id: string) => (await t.owner.query<{ content_hash: string }>('select content_hash from form_versions where id = $1', [id])).rows[0]!.content_hash;

  it('refuses UPDATE and DELETE to fr_app (no privilege) and to the owner (trigger)', async () => {
    const id = await versionOf(seed.b.formIds[0]);
    for (const ctx of [editorOf(), systemCtx]) {
      const update = await failure(formOpsAs(ctx, (tx) => tx.execute(sql`update form_versions set content_hash = 'tampered' where id = ${id}`)));
      expect(pgCode(update), ctx.actor).toBe('42501');
      expect(String((update as { cause?: { message?: string } }).cause?.message ?? update)).toMatch(/permission denied/);
      const del = await failure(formOpsAs(ctx, (tx) => tx.execute(sql`delete from form_versions where id = ${id}`)));
      expect(pgCode(del), ctx.actor).toBe('42501');
    }
    // The owner has every privilege and bypasses RLS: the trigger is what stops it.
    const update = await failure(t.owner.query(`update form_versions set content_hash = 'tampered' where id = $1`, [id]));
    expect(pgCode(update)).toBe('55000');
    expect(String(update)).toMatch(/a published version is immutable \(UPDATE refused\)/);
    const del = await failure(t.owner.query('delete from form_versions where id = $1', [id]));
    expect(pgCode(del)).toBe('55000');
    expect(String(del)).toMatch(/a published version is immutable \(DELETE refused\)/);
    // Not even a statement that would change no row of the version gets past the privilege check.
    expect(pgCode(await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_versions set content_hash = content_hash where false`))))).toBe('42501');
    expect(await hashOf(id)).toBe('0');
  });

  it('still lets a publisher insert a version: with the BL-241 defaults, and a state row of its own', async () => {
    const id = randomUUID();
    await formOpsAs(editorOf(), (tx) =>
      tx.execute(sql`insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash)
                     values (${id}, ${seed.b.orgId}, ${seed.b.formIds[1]}, 2, 2, ${seed.b.editorId}, '{}', '{}', 'h2')`),
    );
    const { rows } = await t.owner.query('select label, engine, draft_rev, template_lineage, variables_snapshot from form_versions where id = $1', [id]);
    expect(rows).toEqual([{ label: null, engine: 'logic@2', draft_rev: null, template_lineage: [], variables_snapshot: {} }]);
    expect((await t.owner.query('select superseded_at, retired_at from form_version_state where version_id = $1', [id])).rows).toEqual([
      { superseded_at: null, retired_at: null },
    ]);
  });

  it('takes the BL-241 columns as given, and refuses a draft_rev below 1', async () => {
    const id = randomUUID();
    await formOpsAs(editorOf(), (tx) =>
      tx.execute(sql`insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash, label, engine, draft_rev, template_lineage, variables_snapshot)
                     values (${id}, ${seed.b.orgId}, ${seed.b.formIds[1]}, 3, 2, ${seed.b.editorId}, '{}', '{}', 'h3', 'Before the GST change', 'logic@2', 7, '[{"templateId":"t1"}]', '{"org.name":"Acme"}')`),
    );
    const { rows } = await t.owner.query('select label, draft_rev, template_lineage, variables_snapshot from form_versions where id = $1', [id]);
    expect(rows).toEqual([{ label: 'Before the GST change', draft_rev: 7, template_lineage: [{ templateId: 't1' }], variables_snapshot: { 'org.name': 'Acme' } }]);
    const zero = await failure(
      t.owner.query(
        `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash, draft_rev) values ($1, $2, $3, 4, 2, $4, '{}', '{}', 'h4', 0)`,
        [randomUUID(), seed.b.orgId, seed.b.formIds[1], seed.b.editorId],
      ),
    );
    expect(pgCode(zero)).toBe('23514');
  });
});

describe('form_version_state', () => {
  const stateOf = async (versionId: string) =>
    (await t.owner.query<{ superseded_at: Date | null; retired_at: Date | null }>('select superseded_at, retired_at from form_version_state where version_id = $1', [versionId])).rows[0]!;
  const version1 = async () => (await t.owner.query<{ id: string }>('select id from form_versions where form_id = $1 and number = 1', [seed.b.formIds[0]])).rows[0]!.id;

  it('has a row for every version, and each version is in the org and form its state names', async () => {
    const missing = await t.owner.query('select v.id from form_versions v left join form_version_state s on s.version_id = v.id where s.version_id is null');
    expect(missing.rows).toEqual([]);
    const mismatched = await t.owner.query('select s.version_id from form_version_state s join form_versions v on v.id = s.version_id where (v.org_id, v.form_id) <> (s.org_id, s.form_id)');
    expect(mismatched.rows).toEqual([]);
  });

  it('lets a publisher date a version as superseded or retired, and change nothing else', async () => {
    const id = await version1();
    const marked = await formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_version_state set superseded_at = now() where version_id = ${id} returning version_id`));
    expect(marked.rows).toHaveLength(1);
    expect((await stateOf(id)).superseded_at).toBeInstanceOf(Date);
    for (const column of ['version_id', 'org_id', 'form_id']) {
      const err = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_version_state set ${sql.identifier(column)} = ${sql.identifier(column)} where version_id = ${id}`)));
      expect(pgCode(err), column).toBe('42501');
    }
    expect(pgCode(await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`delete from form_version_state where version_id = ${id}`))))).toBe('42501');
  });

  it('is read by a respondent context and never written by it', async () => {
    const id = await version1();
    const seen = await formOpsAs(respondentCtx, async (tx) => (await tx.execute<{ version_id: string }>(sql`select version_id from form_version_state where version_id = ${id}`)).rows);
    expect(seen).toEqual([{ version_id: id }]);
    const changed = await formOpsAs(respondentCtx, (tx) => tx.execute(sql`update form_version_state set retired_at = now() where version_id = ${id} returning 1`));
    expect(changed.rows).toEqual([]);
    expect((await stateOf(id)).retired_at).toBeNull();
    // Without its own row (the trigger made one, so the owner removes it first) a respondent cannot add one either.
    const bare = randomUUID();
    await t.owner.query(
      `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 20, 2, $4, '{}', '{}', 'h20')`,
      [bare, seed.b.orgId, seed.b.formIds[1], seed.b.editorId],
    );
    await t.owner.query('delete from form_version_state where version_id = $1', [bare]);
    const insert = sql`insert into form_version_state (version_id, org_id, form_id) values (${bare}, ${seed.b.orgId}, ${seed.b.formIds[1]})`;
    expect(pgCode(await failure(formOpsAs(respondentCtx, (tx) => tx.execute(insert))))).toBe('42501');
    // A publisher can, but only for the form the version belongs to: the key names org, form and version together.
    const wrongForm = sql`insert into form_version_state (version_id, org_id, form_id) values (${bare}, ${seed.b.orgId}, ${seed.b.formIds[0]})`;
    expect(pgCode(await failure(formOpsAs(editorOf(), (tx) => tx.execute(wrongForm))))).toBe('23503');
    await formOpsAs(editorOf(), (tx) => tx.execute(insert));
    expect(await stateOf(bare)).toEqual({ superseded_at: null, retired_at: null });
  });
});

describe('form_access: the password hash is write-only for fr_app (ACC-05)', () => {
  const asking: Array<[string, ReturnType<typeof sql>]> = [
    ['by name', sql`select password_hash from form_access`],
    ['through *', sql`select * from form_access`],
    ['in a predicate', sql`select form_id from form_access where password_hash is not null`],
    ['in a grouping', sql`select count(*) from form_access group by password_hash`],
    ['in a RETURNING', sql`update form_access set rev = rev returning password_hash`],
    ['as a whole row', sql`select f from form_access f`],
    ['as JSON of the whole row', sql`select to_jsonb(f) from form_access f`],
    ['copied into another column', sql`update form_access set password_updated_at = null, rev = length(password_hash)`],
    ['through a conflict update', sql`insert into form_access (form_id, org_id) select form_id, org_id from form_access where false on conflict (form_id) do update set password_hash = form_access.password_hash`],
  ];

  it('raises insufficient_privilege when password_hash is selected, however it is asked for, as any actor kind', async () => {
    for (const ctx of [editorOf(), ownerOf(), respondentCtx, systemCtx, apiKeyCtx]) {
      for (const [how, query] of asking) {
        const err = await failure(formOpsAs(ctx, (tx) => tx.execute(query)));
        expect(pgCode(err), `${ctx.actor} ${how}`).toBe('42501');
        expect(String((err as { cause?: { message?: string } }).cause?.message ?? err), `${ctx.actor} ${how}`).toMatch(/permission denied/);
      }
    }
    // The same through Drizzle: the table object selects every column, so it fails; the public column list does not.
    const err = await failure(formOpsAs(editorOf(), (tx) => tx.select().from(formAccess)));
    expect(pgCode(err)).toBe('42501');
  });

  it('lets a query that names its columns read the rest, and shows whether a password is set without showing it', async () => {
    const rows = await formOpsAs(editorOf(), (tx) => tx.select(formAccessPublicColumns).from(formAccess));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orgId === seed.b.orgId)).toBe(true);
    expect(rows.find((r) => r.formId === seed.b.formIds[0])).toEqual({
      formId: seed.b.formIds[0],
      orgId: seed.b.orgId,
      rev: 1,
      enabled: true,
      openAt: null,
      closeAt: null,
      availability: null,
      submissionLimit: 50,
      passwordUpdatedAt: expect.any(Date),
      embedAllowlist: [],
      redirectAllowlist: null,
      screens: {},
      acceptPreviousVersionsHours: 72,
    });
    expect(rows.find((r) => r.formId === seed.b.formIds[1])).toMatchObject({ submissionLimit: null, passwordUpdatedAt: null });
  });

  it('lets a member set, replace and clear a password, and reports the new rev, without reading the hash back', async () => {
    const created = randomUUID();
    await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [created, seed.b.orgId, seed.b.teamId, seed.b.ownerId, 'fresh form']);
    const hashOf = async () => (await t.owner.query<{ h: string | null }>('select password_hash as h from form_access where form_id = $1', [created])).rows[0]?.h;
    const inserted = await formOpsAs(editorOf(), (tx) =>
      tx.execute<{ rev: number }>(sql`insert into form_access (form_id, org_id, password_hash, password_updated_at) values (${created}, ${seed.b.orgId}, 'argon2id$one', now()) returning rev`),
    );
    expect(inserted.rows).toEqual([{ rev: 1 }]);
    expect(await hashOf()).toBe('argon2id$one');
    const replaced = await formOpsAs(editorOf(), (tx) =>
      tx.execute<{ rev: number }>(sql`update form_access set password_hash = 'argon2id$two', password_updated_at = now(), rev = rev + 1 where form_id = ${created} and rev = 1 returning rev`),
    );
    expect(replaced.rows).toEqual([{ rev: 2 }]);
    expect(await hashOf()).toBe('argon2id$two');
    // A stale rev changes nothing (the compare-and-swap of PUT .../access).
    const stale = await formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_access set rev = rev + 1 where form_id = ${created} and rev = 1 returning rev`));
    expect(stale.rows).toEqual([]);
    await formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_access set password_hash = null, password_updated_at = null where form_id = ${created}`));
    expect(await hashOf()).toBeNull();
  });

  it('keeps the form and org of a row fixed, and refuses a window that closes before it opens or a limit below 1', async () => {
    const [row] = await formOpsAs(editorOf(), (tx) => tx.select({ formId: formAccess.formId }).from(formAccess).limit(1));
    for (const column of ['form_id', 'org_id']) {
      const err = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_access set ${sql.identifier(column)} = ${sql.identifier(column)} where form_id = ${row!.formId}`)));
      expect(pgCode(err), column).toBe('42501');
    }
    const window = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_access set open_at = now(), close_at = now() - interval '1 hour' where form_id = ${row!.formId}`)));
    expect(pgCode(window)).toBe('23514');
    const limit = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_access set submission_limit = 0 where form_id = ${row!.formId}`)));
    expect(pgCode(limit)).toBe('23514');
    const hours = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_access set accept_previous_versions_hours = 721 where form_id = ${row!.formId}`)));
    expect(pgCode(hours)).toBe('23514');
    // The row of another org's form cannot be created from this one either (the key names org and form together).
    const orgAForm = randomUUID();
    await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [orgAForm, seed.a.orgId, seed.a.teamId, seed.a.ownerId, 'org A form without access rules']);
    const foreignForm = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`insert into form_access (form_id, org_id) values (${orgAForm}, ${seed.b.orgId})`)));
    expect(pgCode(foreignForm)).toBe('23503');
  });

  it('lets a respondent context read the rules and write none, and nobody delete a row', async () => {
    const seen = await formOpsAs(respondentCtx, async (tx) => (await tx.execute<{ n: number }>(sql`select count(form_id)::int as n from form_access`)).rows[0]!.n);
    expect(seen).toBe((await t.owner.query<{ n: number }>('select count(*)::int as n from form_access where org_id = $1', [seed.b.orgId])).rows[0]!.n);
    expect(seen).toBeGreaterThanOrEqual(2);
    const changed = await formOpsAs(respondentCtx, (tx) => tx.execute(sql`update form_access set enabled = false returning 1`));
    expect(changed.rows).toEqual([]);
    const created = randomUUID();
    await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [created, seed.b.orgId, seed.b.teamId, seed.b.ownerId, 'another form']);
    const insert = await failure(formOpsAs(respondentCtx, (tx) => tx.execute(sql`insert into form_access (form_id, org_id, enabled) values (${created}, ${seed.b.orgId}, false)`)));
    expect(pgCode(insert)).toBe('42501');
    for (const ctx of [respondentCtx, editorOf(), ownerOf(), systemCtx]) {
      expect(pgCode(await failure(formOpsAs(ctx, (tx) => tx.execute(sql`delete from form_access`)))), ctx.actor).toBe('42501');
    }
    expect((await t.owner.query('select count(*)::int as n from form_access where enabled = false and org_id = $1', [seed.b.orgId])).rows[0]!.n).toBe(0);
  });

  it('form_access_password_hash() returns the hash only for a form of app_org(), to a respondent or system context', async () => {
    const [withPassword, without] = seed.b.formIds;
    const hashAs = (ctx: FormOpsCtx, formId: string, orgId = seed.b.orgId) => formOpsAs({ ...ctx, readOnly: true }, (tx) => formAccessPasswordHash(tx, formId), orgId);
    expect(await hashAs(respondentCtx, withPassword)).toBe(PASSWORD_HASHES[seed.b.orgId]);
    expect(await hashAs(systemCtx, withPassword)).toBe(PASSWORD_HASHES[seed.b.orgId]);
    // No password set, an unknown form, and org A's form from org B's context: all null, indistinguishable.
    expect(await hashAs(respondentCtx, without)).toBeNull();
    expect(await hashAs(respondentCtx, randomUUID())).toBeNull();
    expect(await hashAs(respondentCtx, seed.a.formIds[0])).toBeNull();
    expect(await hashAs(respondentCtx, withPassword, seed.a.orgId)).toBeNull();
    expect(await hashAs(respondentCtx, seed.a.formIds[0], seed.a.orgId)).toBe(PASSWORD_HASHES[seed.a.orgId]);
    // A member's or an API key's context has no reason to read it; outside any tenant nothing answers.
    for (const ctx of [editorOf(), ownerOf(), apiKeyCtx, { actor: 'platform' } as FormOpsCtx]) expect(await hashAs(ctx, withPassword), ctx.actor).toBeNull();
    expect(await formAccessPasswordHash(t.app.db, withPassword)).toBeNull();
  });
});

describe('form_slugs', () => {
  it('has no delete for anyone, and only is_primary changes: a slug is never released', async () => {
    for (const ctx of [editorOf(), ownerOf(), systemCtx, respondentCtx]) {
      expect(pgCode(await failure(formOpsAs(ctx, (tx) => tx.execute(sql`delete from form_slugs`)))), ctx.actor).toBe('42501');
    }
    for (const column of ['slug', 'org_id', 'form_id', 'created_at']) {
      const err = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`update form_slugs set ${sql.identifier(column)} = ${sql.identifier(column)}`)));
      expect(pgCode(err), column).toBe('42501');
    }
  });

  it('is read by a respondent context and never written by it', async () => {
    const seen = await formOpsAs(respondentCtx, async (tx) => (await tx.execute<{ slug: string }>(sql`select slug from form_slugs order by slug`)).rows.map((r) => r.slug));
    expect(seen).toEqual([`form-${seed.b.orgId.slice(0, 8)}`, `old-${seed.b.orgId.slice(0, 8)}`]);
    const changed = await formOpsAs(respondentCtx, (tx) => tx.execute(sql`update form_slugs set is_primary = true returning 1`));
    expect(changed.rows).toEqual([]);
    const insert = await failure(
      formOpsAs(respondentCtx, (tx) => tx.execute(sql`insert into form_slugs (slug, org_id, form_id) values ('squatted', ${seed.b.orgId}, ${seed.b.formIds[1]})`)),
    );
    expect(pgCode(insert)).toBe('42501');
  });

  it('allows one primary slug per form, and refuses a slug that any other form holds, in any org', async () => {
    const second = await failure(t.owner.query(`insert into form_slugs (slug, org_id, form_id, is_primary) values ('second-primary', $1, $2, true)`, [seed.b.orgId, seed.b.formIds[0]]));
    expect(pgCode(second)).toBe('23505');
    const taken = `form-${seed.a.orgId.slice(0, 8)}`;
    const crossOrg = await failure(formOpsAs(editorOf(), (tx) => tx.execute(sql`insert into form_slugs (slug, org_id, form_id) values (${taken}, ${seed.b.orgId}, ${seed.b.formIds[1]})`)));
    expect(pgCode(crossOrg)).toBe('23505');
  });
});

describe('form_counters (ACC-04)', () => {
  const countOf = async (formId: string) => (await t.owner.query<{ n: number }>('select submitted_total::int as n from form_counters where form_id = $1', [formId])).rows[0]!.n;
  const reset = (formId: string) => t.owner.query('update form_counters set submitted_total = 0 where form_id = $1', [formId]);

  it('has a row for every form, made with the form', async () => {
    const created = randomUUID();
    await formOpsAs(editorOf(), (tx) =>
      tx.execute(sql`insert into forms (id, org_id, team_id, owner_user_id, title) values (${created}, ${seed.b.orgId}, ${seed.b.teamId}, ${seed.b.editorId}, 'a fresh form')`),
    );
    expect(await countOf(created)).toBe(0);
    const missing = await t.owner.query('select f.id from forms f left join form_counters c on c.form_id = f.id where c.form_id is null');
    expect(missing.rows).toEqual([]);
  });

  it('lets a respondent context change submitted_total and nothing else of the row', async () => {
    const formId = seed.b.formIds[0];
    await reset(formId);
    const bumped = await formOpsAs(respondentCtx, (tx) =>
      tx.execute<{ n: number }>(sql`update form_counters set submitted_total = submitted_total + 1 where form_id = ${formId} returning submitted_total::int as n`),
    );
    expect(bumped.rows).toEqual([{ n: 1 }]);
    for (const column of ['form_id', 'org_id']) {
      const err = await failure(formOpsAs(respondentCtx, (tx) => tx.execute(sql`update form_counters set ${sql.identifier(column)} = ${sql.identifier(column)}`)));
      expect(pgCode(err), column).toBe('42501');
    }
    expect(pgCode(await failure(formOpsAs(respondentCtx, (tx) => tx.execute(sql`delete from form_counters`))))).toBe('42501');
    const created = randomUUID();
    await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [created, seed.b.orgId, seed.b.teamId, seed.b.ownerId, 'counter form']);
    await t.owner.query('delete from form_counters where form_id = $1', [created]);
    const insert = await failure(formOpsAs(respondentCtx, (tx) => tx.execute(sql`insert into form_counters (form_id, org_id) values (${created}, ${seed.b.orgId})`)));
    expect(pgCode(insert)).toBe('42501');
    await t.owner.query('insert into form_counters (form_id, org_id) values ($1, $2)', [created, seed.b.orgId]);
    expect(await countOf(formId)).toBe(1);
  });

  it('is moved by respondent and system contexts only: a member or an API key changes nothing', async () => {
    const formId = seed.b.formIds[0];
    await reset(formId);
    for (const ctx of [editorOf(), ownerOf(), apiKeyCtx]) {
      const changed = await formOpsAs(ctx, (tx) => tx.execute(sql`update form_counters set submitted_total = 99 where form_id = ${formId} returning 1`));
      expect(changed.rows, ctx.actor).toEqual([]);
    }
    expect(await countOf(formId)).toBe(0);
    const system = await formOpsAs(systemCtx, (tx) => tx.execute(sql`update form_counters set submitted_total = submitted_total + 1 where form_id = ${formId} returning 1`));
    expect(system.rows).toHaveLength(1);
    // A place given back (failed payment) cannot take the counter below zero.
    await formOpsAs(systemCtx, (tx) => tx.execute(sql`update form_counters set submitted_total = submitted_total - 1 where form_id = ${formId}`));
    const below = await failure(formOpsAs(systemCtx, (tx) => tx.execute(sql`update form_counters set submitted_total = submitted_total - 1 where form_id = ${formId}`)));
    expect(pgCode(below)).toBe('23514');
    expect(await countOf(formId)).toBe(0);
  });

  it('with a limit of N, N concurrent guarded updates take exactly N places', async () => {
    const formId = seed.b.formIds[1];
    await reset(formId);
    const limit = 5;
    // The submit transaction's last statement: the guard and the increment are one row lock.
    const take = () =>
      formOpsAs(respondentCtx, async (tx) => {
        const { rows } = await tx.execute(sql`update form_counters set submitted_total = submitted_total + 1 where form_id = ${formId} and submitted_total < ${limit} returning submitted_total`);
        return rows.length;
      });
    const results = await Promise.all(Array.from({ length: 30 }, take));
    expect(results.filter((n) => n === 1)).toHaveLength(limit);
    expect(results.filter((n) => n === 0)).toHaveLength(25);
    expect(await countOf(formId)).toBe(limit);
  });
});

describe('form_favourites', () => {
  const starredBy = (ctx: FormOpsCtx) =>
    formOpsAs(ctx, async (tx) => (await tx.execute<{ user_id: string }>(sql`select user_id from form_favourites order by user_id`)).rows.map((r) => r.user_id));

  it('shows a user their own stars and no colleague’s, whatever the role', async () => {
    expect(await starredBy(editorOf())).toEqual([seed.b.editorId]);
    expect(await starredBy(ownerOf())).toEqual([seed.b.ownerId]);
    expect(await starredBy(viewerOf())).toEqual([]);
    expect((await t.owner.query('select count(*)::int as n from form_favourites where org_id = $1', [seed.b.orgId])).rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('shows no actor kind other than a user any star', async () => {
    for (const ctx of [apiKeyCtx, systemCtx, respondentCtx, { actor: 'platform' } as FormOpsCtx]) expect(await starredBy(ctx), ctx.actor).toEqual([]);
  });

  it('lets a user star and unstar for themselves only', async () => {
    const [first, second] = seed.b.formIds;
    const star = (ctx: FormOpsCtx, userId: string, formId: string, orgId = seed.b.orgId) =>
      formOpsAs(ctx, (tx) => tx.execute(sql`insert into form_favourites (form_id, user_id, org_id) values (${formId}, ${userId}, ${orgId})`));
    await star(editorOf(), seed.b.editorId, second);
    expect(await starredBy(editorOf())).toEqual([seed.b.editorId, seed.b.editorId]);
    // Not for a colleague, not as another actor kind, not a form of another org.
    expect(pgCode(await failure(star(editorOf(), seed.b.viewerId, second)))).toBe('42501');
    expect(pgCode(await failure(star(respondentCtx, seed.b.editorId, first)))).toBe('42501');
    expect(pgCode(await failure(star(editorOf(), seed.b.editorId, seed.a.formIds[0])))).toBe('23503');
    expect(pgCode(await failure(star(editorOf(), seed.b.editorId, seed.a.formIds[0], seed.a.orgId)))).toBe('42501');
    // A colleague's star is out of reach of a delete; one's own goes.
    const colleague = await formOpsAs(editorOf(), (tx) => tx.execute(sql`delete from form_favourites where user_id = ${seed.b.ownerId}`));
    expect(colleague.rowCount).toBe(0);
    expect(await starredBy(ownerOf())).toEqual([seed.b.ownerId]);
    const own = await formOpsAs(editorOf(), (tx) => tx.execute(sql`delete from form_favourites where form_id = ${second}`));
    expect(own.rowCount).toBe(1);
    expect(await starredBy(editorOf())).toEqual([seed.b.editorId]);
    // A star is one row per form and user.
    expect(pgCode(await failure(star(editorOf(), seed.b.editorId, first)))).toBe('23505');
  });

  it('goes with the account, and only with that account', async () => {
    const leaver = randomUUID();
    await t.owner.query(`insert into users (id, email, email_norm, password_hash) values ($1, $2, $2, 'argon2id$x')`, [leaver, `leaver-${leaver}@stars.test`]);
    await t.owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [seed.b.orgId, leaver]);
    await t.owner.query('insert into form_favourites (form_id, user_id, org_id) values ($1, $2, $3), ($4, $2, $3)', [seed.b.formIds[0], leaver, seed.b.orgId, seed.b.formIds[1]]);
    const stars = async (userId: string) => (await t.owner.query<{ n: number }>('select count(*)::int as n from form_favourites where user_id = $1', [userId])).rows[0]!.n;
    expect(await stars(leaver)).toBe(2);
    const others = await stars(seed.b.editorId);
    expect(others).toBeGreaterThan(0);
    const result = await withUser(t.app.db, { userId: leaver, requestId: 'stars' }, (tx) => accountDelete(tx, leaver, { apply: true }));
    expect(result.status).toBe('deleted');
    expect(await stars(leaver)).toBe(0);
    expect(await stars(seed.b.editorId)).toBe(others);
  });
});
