import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audit,
  createPartitions,
  listUserOrgs,
  membershipFor,
  orgsDueFor,
  partitionsOf,
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
    expect(await membershipFor(t.app.db, seed.a.ownerId, seed.a.orgId)).toEqual({ role: 'owner', grants: [] });
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
    const before = await partitionsOf(t.owner, 'audit_log');
    // The months come from the database clock, so a run that spans a month boundary still agrees.
    const { rows: months } = await t.owner.query<{ name: string }>(
      `select 'audit_log_' || to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => i), 'YYYY_MM') as name
       from generate_series(0, 6) i order by i`,
    );
    const expected = months.map((m) => m.name).filter((n) => !before.some((p) => p.name === `parts.${n}`));
    const created = await createPartitions(t.app.db, 'audit_log', 6);
    expect(created).toEqual(expected);
    expect(created.length).toBeGreaterThan(0);
    expect(await createPartitions(t.app.db, 'audit_log', 6)).toEqual([]);
    const rows = await partitionsOf(t.owner, 'audit_log');
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(months.map((m) => `parts.${m.name}`)));
    for (const r of rows) {
      expect(r).toMatchObject({ name: expect.stringMatching(/^parts\.audit_log_\d{4}_\d{2}$/), forced: true, owner: 'fr_migrator' });
      expect(r.grantees.filter((g) => g !== 'fr_migrator')).toEqual([]);
    }
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
    expect(rows.map((r) => r.fn)).toEqual([
      'account_delete',
      'account_export_data',
      'audit_archive_detach',
      'audit_chain_begin',
      'audit_chain_keys',
      'audit_checkpoint_names_a_link',
      'audit_log_append',
      'audit_log_continue_chain',
      'audit_pending_keys',
      'audit_pending_take',
      'auth_create_user',
      'auth_identity_user',
      'auth_mfa_ticket',
      'auth_recovery_code_use',
      'auth_session',
      'auth_throttle_hit',
      'auth_token_peek',
      'auth_token_take',
      'auth_user_by_email',
      'auth_user_credentials',
      'create_org',
      'create_partitions',
      'invite_accept',
      'invite_by_token',
      'list_user_orgs',
      'member_access_token',
      'member_sessions_revoke',
      'membership_for',
      'orgs_due_for',
      'resolve_job_org',
      'template_delete',
      'template_for_binding',
      'template_rows_guard',
    ]);
    expect(rows.every((r) => !r.public && !r.seeder)).toBe(true);
  });
});

describe('audit_pending', () => {
  const event = { actorKind: 'user' as const, action: 'request.authorize' as const, resourceType: 'route', outcome: 'denied' as const, reason: 'not_a_member' };
  const success = { actorKind: 'system' as const, action: 'system.heartbeat' as const, resourceType: 'org', outcome: 'success' as const };

  async function pendingFor(orgKey: string): Promise<number> {
    const { rows } = await t.owner.query<{ n: number }>('select count(*)::int as n from audit_pending where org_key = $1', [orgKey]);
    return rows[0]!.n;
  }

  it('records denied actions on a separate connection, surviving the business rollback', async () => {
    const before = await pendingFor(seed.b.orgId);
    const err = await failure(
      withTenant(t.app.db, { orgId: seed.b.orgId, actor: 'user', userId: seed.b.editorId, requestId: 'r' }, async () => {
        await audit.appendDetached(t.app.db, seed.b.orgId, { ...event, actorId: seed.b.editorId });
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
        await audit.append(tx, seed.b.orgId, success);
        throw new Error('later failure');
      }),
    );
    expect(await pendingFor(seed.b.orgId)).toBe(before);
  });

  it('files events without a tenant under the platform key, and refuses other orgs’ keys', async () => {
    const before = await pendingFor(PLATFORM_ORG_KEY);
    await audit.appendDetached(t.app.db, null, { ...event, actorKind: 'none' });
    expect(await pendingFor(PLATFORM_ORG_KEY)).toBe(before + 1);
    const err = await failure(
      withTenant(t.app.db, { orgId: seed.b.orgId, actor: 'system', requestId: 'r' }, (tx) => audit.append(tx, seed.a.orgId, success)),
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
