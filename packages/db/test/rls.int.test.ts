import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTenantCtx, forms, orgs, userPublicColumns, users, withTenant, type TenantCtx } from '../src/index.ts';
import { failure, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';
import { isolation } from './isolation.ts';

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

const env = () => ({ t, seed });

isolation(
  'orgs',
  {
    foreign: (s) => sql`id = ${s.a.orgId}`,
    own: (s) => sql`id = ${s.b.orgId}`,
    update: (s) => sql`update orgs set name = name where id = ${s.a.orgId}`,
    insertForeign: () => sql`insert into orgs (id, slug, name) values (${randomUUID()}, ${randomUUID()}, 'x')`,
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'users',
  {
    foreign: (s) => sql`id in (${s.a.ownerId}, ${s.a.editorId})`,
    own: (s) => sql`id = ${s.b.ownerId}`,
    update: (s) => sql`update users set name = 'x' where id = ${s.a.editorId}`,
    insertForeign: () => sql`insert into users (id, email, email_norm) values (${randomUUID()}, 'x@a.test', ${randomUUID()})`,
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'memberships',
  {
    foreign: (s) => sql`org_id = ${s.a.orgId}`,
    own: (s) => sql`org_id = ${s.b.orgId}`,
    update: (s) => sql`update memberships set role = 'viewer' where org_id = ${s.a.orgId}`,
    insertForeign: (s) => sql`insert into memberships (org_id, user_id, role) values (${s.a.orgId}, ${s.b.editorId}, 'viewer')`,
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'sessions',
  {
    foreign: (s) => sql`user_id in (${s.a.ownerId}, ${s.a.editorId})`,
    own: (s) => sql`user_id = ${s.b.editorId}`,
    update: (s) => sql`update sessions set revoked_at = now() where user_id = ${s.a.editorId}`,
    insertForeign: (s) =>
      sql`insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at)
          values (${randomUUID()}, ${Buffer.alloc(32, 1)}, ${s.a.editorId}, 'pwd', now() + interval '1 hour', now() + interval '1 day')`,
    visibleTo: ['user'],
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'user_identities',
  {
    foreign: (s) => sql`user_id = ${s.a.editorId}`,
    own: (s) => sql`user_id = ${s.b.editorId}`,
    update: (s) => sql`update user_identities set last_used_at = now() where user_id = ${s.a.editorId}`,
    insertForeign: (s) => sql`insert into user_identities (id, user_id, provider, subject) values (${randomUUID()}, ${s.a.editorId}, 'microsoft', ${randomUUID()})`,
    visibleTo: ['user'],
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'auth_tokens',
  {
    foreign: (s) => sql`user_id = ${s.a.editorId}`,
    own: (s) => sql`user_id = ${s.b.editorId}`,
    update: (s) => sql`update auth_tokens set consumed_at = now() where user_id = ${s.a.editorId}`,
    insertForeign: (s) =>
      sql`insert into auth_tokens (id, token_hash, purpose, user_id, expires_at) values (${randomUUID()}, ${Buffer.alloc(32, 2)}, 'password_reset', ${s.a.editorId}, now() + interval '1 hour')`,
    visibleTo: ['user'],
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'user_notice_acks',
  {
    foreign: (s) => sql`user_id = ${s.a.editorId}`,
    own: (s) => sql`user_id = ${s.b.editorId}`,
    update: (s) => sql`update user_notice_acks set locale = 'hi-IN' where user_id = ${s.a.editorId}`,
    insertForeign: (s) =>
      sql`insert into user_notice_acks (id, user_id, notice_version, notice_hash, locale, context)
          values (${randomUUID()}, ${s.a.editorId}, '2026-10-19', ${Buffer.alloc(32, 3)}, 'en-IN', 'settings')`,
    visibleTo: ['user'],
    expect: { select: 0, update: 'denied' },
  },
  env,
);

isolation(
  'user_grievances',
  {
    foreign: (s) => sql`user_id = ${s.a.editorId}`,
    own: (s) => sql`user_id = ${s.b.editorId}`,
    update: (s) => sql`update user_grievances set status = 'answered' where user_id = ${s.a.editorId}`,
    insertForeign: (s) =>
      sql`insert into user_grievances (id, user_id, reference, category, message, due_at)
          values (${randomUUID()}, ${s.a.editorId}, 'GRV-AAAAAAAA', 'other', 'x', now() + interval '1 day')`,
    visibleTo: ['user'],
    expect: { select: 0, update: 'denied' },
  },
  env,
);

isolation(
  'auth_throttle',
  {
    foreign: () => sql`true`,
    update: () => sql`update auth_throttle set hits = 0`,
    insertForeign: () => sql`insert into auth_throttle (bucket, key, window_start, hits) values ('auth_any', ${Buffer.alloc(1)}, now(), 1)`,
    expect: { select: 'denied', update: 'denied' },
  },
  env,
);

isolation(
  'forms',
  {
    foreign: (s) => sql`org_id = ${s.a.orgId}`,
    own: (s) => sql`org_id = ${s.b.orgId}`,
    update: (s) => sql`update forms set title = 'pwned' where org_id = ${s.a.orgId}`,
    insertForeign: (s) =>
      sql`insert into forms (id, org_id, team_id, owner_user_id, title) values (${randomUUID()}, ${s.a.orgId}, ${s.a.teamId}, ${s.b.editorId}, 'x')`,
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'form_drafts',
  {
    foreign: (s) => sql`org_id = ${s.a.orgId}`,
    own: (s) => sql`org_id = ${s.b.orgId}`,
    update: (s) => sql`update form_drafts set draft_rev = draft_rev + 1 where org_id = ${s.a.orgId}`,
    insertForeign: (s) =>
      sql`insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by) values (${randomUUID()}, ${s.a.orgId}, '{}', 2, 2, ${s.b.editorId})`,
    expect: { select: 0, update: 0 },
  },
  env,
);

isolation(
  'audit_log',
  {
    foreign: (s) => sql`org_id = ${s.a.orgId}`,
    own: (s) => sql`org_id = ${s.b.orgId}`,
    update: (s) => sql`update audit_log set reason = 'x' where org_id = ${s.a.orgId}`,
    insertForeign: (s) =>
      sql`insert into audit_log (org_id, seq, occurred_at, actor_kind, action, resource_type, outcome, prev_hash, hash)
          values (${s.a.orgId}, 99, now(), 'system', 'x', 'x', 'success', '\\x00', '\\x00')`,
    expect: { select: 0, update: 'denied' },
  },
  env,
);

isolation(
  'audit_pending',
  {
    foreign: (s) => sql`org_key = ${s.a.orgId}`,
    update: () => sql`update audit_pending set event = '{}'`,
    insertForeign: (s) => sql`insert into audit_pending (org_key, event) values (${s.a.orgId}, '{}')`,
    expect: { select: 'denied', update: 'denied' },
  },
  env,
);

isolation(
  'audit_heads',
  {
    foreign: (s) => sql`org_key = ${s.a.orgId}`,
    own: (s) => sql`org_key = ${s.b.orgId}`,
    update: (s) => sql`update audit_heads set seq = 0 where org_key = ${s.a.orgId}`,
    insertForeign: (s) => sql`insert into audit_heads (org_key, seq, hash) values (${s.a.orgId}, 0, ${Buffer.alloc(32)})`,
    expect: { select: 0, update: 'denied' },
  },
  env,
);

isolation(
  'audit_checkpoints',
  {
    foreign: (s) => sql`org_key = ${s.a.orgId}`,
    own: (s) => sql`org_key = ${s.b.orgId}`,
    update: (s) => sql`update audit_checkpoints set key_id = 'x' where org_key = ${s.a.orgId}`,
    // seq 1 with the zero hash is a real link of org A, so only RLS stands in the way.
    insertForeign: (s) =>
      sql`insert into audit_checkpoints (org_key, seq, hash, signed_at, key_id, alg, signature)
          values (${s.a.orgId}, 1, ${Buffer.alloc(32)}, now(), 'k2', 'ed25519', ${Buffer.alloc(64)})`,
    expect: { select: 0, update: 'denied' },
  },
  env,
);

isolation(
  'audit_archives',
  {
    foreign: (s) => sql`org_key = ${s.a.orgId}`,
    own: (s) => sql`org_key = ${s.b.orgId}`,
    update: (s) => sql`update audit_archives set object_key = 'x' where org_key = ${s.a.orgId}`,
    insertForeign: (s) =>
      sql`insert into audit_archives (org_key, month, object_key, row_count, min_seq, max_seq, sha256)
          values (${s.a.orgId}, '2020-02', 'x', 1, 1, 1, ${Buffer.alloc(32)})`,
    expect: { select: 0, update: 'denied' },
  },
  env,
);

const userCtx = (): TenantCtx => ({ orgId: seed.b.orgId, actor: 'user', userId: seed.b.editorId, perms: ['forms.read'], requestId: 'r1' });

describe('tenant context', () => {
  it('sees zero rows outside withTenant, without raising', async () => {
    for (const table of ['orgs', 'users', 'memberships', 'sessions', 'user_identities', 'auth_tokens', 'forms', 'form_drafts', 'audit_log', 'audit_heads', 'audit_checkpoints', 'audit_archives']) {
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
      withTenant(t.app.db, userCtx(), (tx) =>
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
    expect(visible.map((u) => u.id).sort()).toEqual([seed.b.ownerId, seed.b.editorId].sort());
  });

  it('lets api-key, system and respondent actors (no user id) query users without raising', async () => {
    for (const actor of ['api_key', 'system', 'respondent'] as const) {
      const rows = await withTenant(t.app.db, { orgId: seed.b.orgId, actor, requestId: 'r' }, (tx) => tx.select({ id: users.id }).from(users));
      expect(rows.length, actor).toBe(2);
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
