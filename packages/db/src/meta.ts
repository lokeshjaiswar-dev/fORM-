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

/**
 * Partitions of tables in `public` (or nested in `parts`). The pg-boss schema has partitioned tables of its own;
 * they hold job ids, not tenant data, and are outside RLS by design (architecture §5.1).
 */
const APP_PARENT = `exists (select 1 from pg_class pc join pg_namespace pn on pn.oid = pc.relnamespace
       where pc.oid = i.inhparent and pn.nspname in ('public', 'parts'))`;

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
     where c.relkind in ('r', 'p') and n.nspname <> 'parts' and ${APP_PARENT}`,
  ],
  [
    'partition-rls-not-forced',
    `select c.oid::regclass::text as object from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where c.relkind in ('r', 'p') and not (c.relrowsecurity and c.relforcerowsecurity) and ${APP_PARENT}`,
  ],
  [
    'partition-granted',
    `select distinct c.oid::regclass::text || ' to ' || case a.grantee when 0 then 'public' else a.grantee::regrole::text end as object
     from pg_inherits i join pg_class c on c.oid = i.inhrelid
     cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where c.relkind in ('r', 'p') and a.grantee <> c.relowner and ${APP_PARENT}`,
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
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
     order by 1`,
  ],
  [
    'app-role-bypasses-rls',
    `select rolname as object from pg_roles where rolname in ('fr_app', 'fr_template_seeder') and (rolbypassrls or rolsuper)`,
  ],
];

/**
 * RLS meta-checks (architecture §2.3). Every table in `public` forces RLS and has a policy; tables with an
 * `org_id` column have a `<table>_tenant` policy; partitions of those tables live in `parts`, force RLS and grant nothing;
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

export interface PartitionInfo {
  /** Schema-qualified, e.g. `parts.audit_log_2027_01`. */
  name: string;
  forced: boolean;
  owner: string;
  /** Every role holding a privilege on it (`public` for PUBLIC), the owner included. */
  grantees: string[];
}

/** The partitions of `parent`, a table in `public`. */
export async function partitionsOf(client: Queryable, parent: string): Promise<PartitionInfo[]> {
  const { rows } = await client.query<PartitionInfo>(
    `select c.oid::regclass::text as name, c.relrowsecurity and c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner,
       array(select distinct case a.grantee when 0 then 'public' else a.grantee::regrole::text end
             from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a order by 1) as grantees
     from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where i.inhparent = to_regclass('public.' || quote_ident($1)) and c.relkind = 'r' order by 1`,
    [parent],
  );
  return rows;
}
