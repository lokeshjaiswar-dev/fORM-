import type pg from 'pg';

export interface RlsViolation {
  rule:
    | 'rls-not-forced'
    | 'no-policy'
    | 'no-tenant-policy'
    | 'partition-outside-parts'
    | 'partition-rls-not-forced'
    | 'partition-granted'
    | 'parts-schema-granted'
    | 'raw-current-setting'
    | 'definer-unsafe'
    | 'app-role-bypasses-rls';
  object: string;
}

type Queryable = Pick<pg.ClientBase, 'query'>;

const CHECKS: ReadonlyArray<readonly [RlsViolation['rule'], string]> = [
  [
    'rls-not-forced',
    `select c.relname as object from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and not (c.relrowsecurity and c.relforcerowsecurity)`,
  ],
  [
    'no-policy',
    `select c.relname as object from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`,
  ],
  [
    'no-tenant-policy',
    `select c.relname as object from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_tenant')`,
  ],
  [
    'partition-outside-parts',
    `select c.oid::regclass::text as object from pg_inherits i
     join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname <> 'parts'`,
  ],
  [
    'partition-rls-not-forced',
    `select c.oid::regclass::text as object from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where c.relkind in ('r', 'p') and not (c.relrowsecurity and c.relforcerowsecurity)`,
  ],
  [
    'partition-granted',
    `select distinct c.oid::regclass::text || ' to ' || case a.grantee when 0 then 'public' else a.grantee::regrole::text end as object
     from pg_inherits i join pg_class c on c.oid = i.inhrelid
     cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where c.relkind in ('r', 'p') and a.grantee <> c.relowner`,
  ],
  [
    'parts-schema-granted',
    `select distinct case a.grantee when 0 then 'public' else a.grantee::regrole::text end as object
     from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
     where n.nspname = 'parts' and a.grantee <> n.nspowner`,
  ],
  [
    'raw-current-setting',
    `select schemaname || '.' || tablename || '.' || policyname as object from pg_policies
     where coalesce(qual, '') ilike '%current_setting(%' or coalesce(with_check, '') ilike '%current_setting(%'`,
  ],
  [
    'definer-unsafe',
    `select p.oid::regprocedure::text as object from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and (
       not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%')
       or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`,
  ],
  [
    'app-role-bypasses-rls',
    `select rolname as object from pg_roles where rolname in ('fr_app', 'fr_template_seeder') and (rolbypassrls or rolsuper)`,
  ],
];

/**
 * RLS meta-checks (architecture §2.3). Every table in `public` forces RLS and has a policy; tables with an
 * `org_id` column have a `<table>_tenant` policy; partitions live in `parts`, force RLS and grant nothing;
 * policies never call `current_setting(` directly; definer functions pin `search_path` and are not public.
 */
export async function rlsViolations(client: Queryable): Promise<RlsViolation[]> {
  const out: RlsViolation[] = [];
  for (const [rule, query] of CHECKS) {
    const { rows } = await client.query<{ object: string }>(query);
    for (const r of rows) out.push({ rule, object: r.object });
  }
  return out;
}
