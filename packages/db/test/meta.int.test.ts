import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rlsViolations, type RlsViolation } from '../src/index.ts';
import { setupTestDb, type TestDb } from './harness.ts';

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(() => t?.close());

/** Runs `ddl` as the schema owner, collects violations, and rolls everything back. */
async function violationsAfter(ddl: string): Promise<RlsViolation[]> {
  const c = await t.owner.connect();
  try {
    await c.query('begin');
    await c.query(ddl);
    return await rlsViolations(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('RLS meta-tests', () => {
  it('pass on the migrated schema', async () => {
    expect(await rlsViolations(t.owner)).toEqual([]);
  });

  it('fail on a tenant table without RLS or a policy', async () => {
    const v = await violationsAfter('create table leaky (id uuid primary key, org_id uuid not null)');
    expect(v).toEqual(
      expect.arrayContaining([
        { rule: 'rls-not-forced', object: 'leaky' },
        { rule: 'no-policy', object: 'leaky' },
        { rule: 'no-tenant-policy', object: 'leaky' },
      ]),
    );
  });

  it('fail when RLS is enabled but not forced, or the tenant policy is missing', async () => {
    const v = await violationsAfter(`
      create table half (id uuid primary key, org_id uuid not null);
      alter table half enable row level security;
      create policy half_read on half for select to fr_app using (org_id = (select app_org()));`);
    expect(v).toEqual([
      { rule: 'rls-not-forced', object: 'half' },
      { rule: 'no-tenant-policy', object: 'half' },
    ]);
  });

  it('fail on a policy that calls current_setting( directly', async () => {
    const v = await violationsAfter(`
      create table raw (id uuid primary key, org_id uuid not null);
      alter table raw enable row level security, force row level security;
      create policy raw_tenant on raw for all to fr_app using (org_id = current_setting('app.org_id')::uuid);`);
    expect(v).toEqual([{ rule: 'raw-current-setting', object: 'public.raw.raw_tenant' }]);
  });

  it('fail on a granted, unforced or misplaced partition and on grants on schema parts', async () => {
    const { rows } = await t.owner.query<{ name: string }>(
      `select c.oid::regclass::text as name from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.audit_log'::regclass and c.relkind = 'r' limit 1`,
    );
    const partition = rows[0]!.name;
    expect(await violationsAfter(`grant select on ${partition} to fr_app`)).toEqual([{ rule: 'partition-granted', object: `${partition} to fr_app` }]);
    expect(await violationsAfter(`alter table ${partition} no force row level security`)).toEqual([
      { rule: 'partition-rls-not-forced', object: partition },
    ]);
    expect(await violationsAfter('grant usage on schema parts to fr_app')).toEqual([{ rule: 'parts-schema-granted', object: 'fr_app' }]);
    expect(
      await violationsAfter(`create table public.audit_log_2001_01 partition of audit_log for values from ('2001-01-01') to ('2001-02-01');
        alter table public.audit_log_2001_01 enable row level security, force row level security`),
    ).toEqual([{ rule: 'partition-outside-parts', object: 'audit_log_2001_01' }]);
  });

  it('leave partitioned tables of other schemas (pg-boss) alone, but not partitions of public tables placed there', async () => {
    expect(
      await violationsAfter(`create schema queue_like;
        create table queue_like.job (name text not null, id uuid not null) partition by list (name);
        create table queue_like.job_common partition of queue_like.job default;
        grant select on queue_like.job_common to fr_app`),
    ).toEqual([]);
    expect(
      await violationsAfter(`create schema elsewhere;
        create table elsewhere.audit_log_2001_01 partition of audit_log for values from ('2001-01-01') to ('2001-02-01')`),
    ).toEqual([
      { rule: 'partition-outside-parts', object: 'elsewhere.audit_log_2001_01' },
      { rule: 'partition-rls-not-forced', object: 'elsewhere.audit_log_2001_01' },
    ]);
  });

  it('fail on a definer function without a pinned search_path or executable by PUBLIC', async () => {
    const v = await violationsAfter(`
      create function unsafe_lookup() returns int language sql security definer as $$ select 1 $$;
      create function public_lookup() returns int language sql security definer set search_path = pg_catalog, public as $$ select 1 $$;
      grant execute on function public_lookup() to public;`);
    expect(v).toEqual([
      { rule: 'definer-unsafe', object: 'public_lookup()' },
      { rule: 'definer-unsafe', object: 'unsafe_lookup()' },
    ]);
  });
});

describe('roles', () => {
  it('fr_app and fr_template_seeder cannot bypass RLS; fr_migrator owns the schema', async () => {
    const { rows } = await t.owner.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean; rolcreaterole: boolean }>(
      `select rolname, rolbypassrls, rolsuper, rolcreaterole from pg_roles where rolname like 'fr\\_%' order by rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'fr_app', rolbypassrls: false, rolsuper: false, rolcreaterole: false },
      { rolname: 'fr_migrator', rolbypassrls: true, rolsuper: false, rolcreaterole: false },
      { rolname: 'fr_system_agg', rolbypassrls: true, rolsuper: false, rolcreaterole: false },
      { rolname: 'fr_template_seeder', rolbypassrls: false, rolsuper: false, rolcreaterole: false },
    ]);
    const owners = await t.owner.query<{ owner: string }>(
      `select distinct pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'parts') and c.relkind in ('r', 'p')`,
    );
    expect(owners.rows).toEqual([{ owner: 'fr_migrator' }]);
  });

  it('fr_template_seeder reaches the template tables only, fr_system_agg the rollup sources and the rollup', async () => {
    const { rows } = await t.owner.query<{ role: string; table: string; privs: string[] }>(
      `with p as (
         select r.role, c.relname as table, array(
           select x from unnest(array['select', 'insert', 'update', 'delete']) x
           where has_table_privilege(r.role, c.oid, x) or (x <> 'delete' and has_any_column_privilege(r.role, c.oid, x))) as privs
         from (values ('fr_system_agg'), ('fr_template_seeder')) r (role)
         cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'parts') and c.relkind in ('r', 'p'))
       select * from p where cardinality(privs) > 0 order by 1, 2`,
    );
    const sid = ['select', 'insert', 'update'];
    expect(rows).toEqual([
      { role: 'fr_system_agg', table: 'form_template_bindings', privs: ['select'] },
      { role: 'fr_system_agg', table: 'template_stats_daily', privs: sid },
      { role: 'fr_system_agg', table: 'template_usages', privs: ['select'] },
      { role: 'fr_system_agg', table: 'templates', privs: ['select'] },
      { role: 'fr_template_seeder', table: 'template_categories', privs: sid },
      { role: 'fr_template_seeder', table: 'template_category_links', privs: ['select', 'insert', 'delete'] },
      { role: 'fr_template_seeder', table: 'template_localizations', privs: [...sid, 'delete'] },
      { role: 'fr_template_seeder', table: 'template_packs', privs: sid },
      { role: 'fr_template_seeder', table: 'template_search_synonyms', privs: [...sid, 'delete'] },
      { role: 'fr_template_seeder', table: 'template_signing_keys', privs: sid },
      { role: 'fr_template_seeder', table: 'template_versions', privs: sid },
      { role: 'fr_template_seeder', table: 'templates', privs: sid },
    ]);
  });

  it('fr_template_seeder policies admit system rows only', async () => {
    const { rows } = await t.owner.query<{ table: string; qual: string; with_check: string }>(
      `select tablename as table, qual, with_check from pg_policies where 'fr_template_seeder' = any (roles) order by 1`,
    );
    expect(rows.map((r) => r.table)).toEqual([
      'template_categories',
      'template_category_links',
      'template_localizations',
      'template_packs',
      'template_search_synonyms',
      'template_signing_keys',
      'template_versions',
      'templates',
    ]);
    for (const r of rows) expect([r.qual, r.with_check], r.table).toEqual(['(org_id IS NULL)', '(org_id IS NULL)']);
  });
});
