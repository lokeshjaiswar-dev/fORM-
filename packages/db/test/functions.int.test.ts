import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAudit,
  appendAuditDetached,
  createPartitions,
  listUserOrgs,
  membershipFor,
  orgsDueFor,
  PLATFORM_ORG_KEY,
  resolveJobOrg,
  withTenant,
  type OrgSpanningJob,
  type PartitionedTable,
} from '../src/index.ts';
import { failure, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

describe('definer functions (called as fr_app, outside any tenant)', () => {
  it('list_user_orgs lists active memberships only', async () => {
    expect(await listUserOrgs(t.app.db, seed.a.editorId)).toEqual([
      { orgId: seed.a.orgId, slug: expect.stringMatching(/^a-/), name: expect.any(String), role: 'editor' },
    ]);
    await t.owner.query(`insert into memberships (org_id, user_id, role, status) values ($1, $2, 'viewer', 'suspended')`, [seed.b.orgId, seed.a.editorId]);
    expect(await listUserOrgs(t.app.db, seed.a.editorId)).toHaveLength(1);
    expect(await listUserOrgs(t.app.db, randomUUID())).toEqual([]);
  });

  it('membership_for validates X-FR-Org', async () => {
    expect(await membershipFor(t.app.db, seed.a.ownerId, seed.a.orgId)).toBe('owner');
    expect(await membershipFor(t.app.db, seed.a.ownerId, seed.b.orgId)).toBeNull();
    expect(await membershipFor(t.app.db, seed.a.editorId, seed.b.orgId)).toBeNull();
  });

  it('orgs_due_for lists orgs for known jobs and rejects unknown ones', async () => {
    const due = await orgsDueFor(t.app.db, 'retention.sweep');
    expect(due).toEqual(expect.arrayContaining([seed.a.orgId, seed.b.orgId]));
    expect(pgCode(await failure(orgsDueFor(t.app.db, 'nope' as OrgSpanningJob)))).toBe('22023');
  });

  it('resolve_job_org re-derives the org from the resource', async () => {
    expect(await resolveJobOrg(t.app.db, 'form', seed.a.formIds[0])).toBe(seed.a.orgId);
    expect(await resolveJobOrg(t.app.db, 'form_draft', seed.b.formIds[1])).toBe(seed.b.orgId);
    expect(await resolveJobOrg(t.app.db, 'org', seed.b.orgId)).toBe(seed.b.orgId);
    expect(await resolveJobOrg(t.app.db, 'form', randomUUID())).toBeNull();
    expect(pgCode(await failure(resolveJobOrg(t.app.db, 'submission' as 'form', randomUUID())))).toBe('22023');
  });

  it('create_partitions is idempotent and creates forced-RLS partitions in parts that fr_app cannot touch', async () => {
    const created = await createPartitions(t.app.db, 'audit_log', 6);
    expect(created).toHaveLength(3);
    expect(await createPartitions(t.app.db, 'audit_log', 6)).toEqual([]);
    const { rows } = await t.owner.query<{ name: string; forced: boolean; owner: string; acl: string | null }>(
      `select c.oid::regclass::text as name, c.relrowsecurity and c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.audit_log'::regclass and c.relkind = 'r' order by 1`,
    );
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r).toMatchObject({ name: expect.stringMatching(/^parts\.audit_log_\d{4}_\d{2}$/), forced: true, owner: 'fr_migrator' });
    for (const r of rows) expect(r.acl === null || !/fr_app|^=|,=/.test(r.acl)).toBe(true);
    const err = await failure(t.app.pool.query(`select * from parts.${created[0]!}`));
    expect(pgCode(err)).toBe('42501');
  });

  it('create_partitions refuses bad input', async () => {
    expect(pgCode(await failure(createPartitions(t.app.db, 'audit_log', 25)))).toBe('22023');
    expect(pgCode(await failure(createPartitions(t.app.db, 'forms' as PartitionedTable, 1)))).toBe('22023');
  });

  it('only fr_app (and the owner) may execute them', async () => {
    const { rows } = await t.owner.query<{ fn: string; public: boolean; seeder: boolean }>(
      `select p.proname as fn, has_function_privilege('public', p.oid, 'execute') as public,
              has_function_privilege('fr_template_seeder', p.oid, 'execute') as seeder
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef order by 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual(['create_partitions', 'list_user_orgs', 'membership_for', 'orgs_due_for', 'resolve_job_org']);
    expect(rows.every((r) => !r.public && !r.seeder)).toBe(true);
  });
});

describe('audit_pending', () => {
  const event = { actorKind: 'user' as const, action: 'org.access', resourceType: 'org', outcome: 'denied' as const, reason: 'not a member' };

  async function pendingFor(orgKey: string): Promise<number> {
    const { rows } = await t.owner.query<{ n: number }>('select count(*)::int as n from audit_pending where org_key = $1', [orgKey]);
    return rows[0]!.n;
  }

  it('records denied actions on a separate connection, surviving the business rollback', async () => {
    const before = await pendingFor(seed.b.orgId);
    const err = await failure(
      withTenant(t.app.db, { orgId: seed.b.orgId, actor: 'user', userId: seed.b.editorId, requestId: 'r' }, async () => {
        await appendAuditDetached(t.app.db, seed.b.orgId, { ...event, actorId: seed.b.editorId });
        throw new Error('forbidden');
      }),
    );
    expect(String(err)).toMatch(/forbidden/);
    expect(await pendingFor(seed.b.orgId)).toBe(before + 1);
  });

  it('rolls in-transaction records back with the business change', async () => {
    const before = await pendingFor(seed.b.orgId);
    await failure(
      withTenant(t.app.db, { orgId: seed.b.orgId, actor: 'system', requestId: 'r' }, async (tx) => {
        await appendAudit(tx, seed.b.orgId, { ...event, actorKind: 'system', outcome: 'success' });
        throw new Error('later failure');
      }),
    );
    expect(await pendingFor(seed.b.orgId)).toBe(before);
  });

  it('files events without a tenant under the platform key, and refuses other orgs’ keys', async () => {
    const before = await pendingFor(PLATFORM_ORG_KEY);
    await appendAuditDetached(t.app.db, null, { ...event, actorKind: 'none' });
    expect(await pendingFor(PLATFORM_ORG_KEY)).toBe(before + 1);
    const err = await failure(
      withTenant(t.app.db, { orgId: seed.b.orgId, actor: 'system', requestId: 'r' }, (tx) => appendAudit(tx, seed.a.orgId, event)),
    );
    expect(pgCode(err)).toBe('42501');
  });

  it('cannot be changed, even by the owner', async () => {
    const err = await failure(t.owner.query(`update audit_pending set event = '{}'`));
    expect(String(err)).toMatch(/append-only/);
    const log = await failure(t.owner.query(`delete from audit_log`));
    expect(String(log)).toMatch(/append-only/);
    const truncate = await failure(t.owner.query(`truncate audit_log`));
    expect(String(truncate)).toMatch(/append-only/);
  });

  it('reads back through audit_log only within the tenant', async () => {
    const rows = await withTenant(t.app.db, { orgId: seed.a.orgId, actor: 'system', requestId: 'r', readOnly: true }, (tx) =>
      tx.execute<{ org_id: string }>(sql`select org_id from audit_log`),
    );
    expect(rows.rows.map((r) => r.org_id)).toEqual([seed.a.orgId]);
  });
});
