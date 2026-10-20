import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTenantCtx, forms, orgs, userPublicColumns, users, withTenant, type TenantCtx } from '../src/index.ts';
import { failure, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';
import { isolationSuite, publicTables, type TableSpec } from './isolation.ts';

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

const env = () => ({ t, seed });

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
