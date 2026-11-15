import { randomBytes, randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTenantCtx, forms, orgs, userPublicColumns, users, withTenant, type TenantCtx, type Tx } from '../src/index.ts';
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
