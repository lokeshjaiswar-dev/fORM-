-- Narrow SECURITY DEFINER functions for work that spans orgs or happens before a tenant is known
-- (architecture §2.1, F-1). Owned by fr_migrator (BYPASSRLS), pinned search_path, EXECUTE granted one by one.

-- GET /v1/orgs: the orgs a user belongs to.
create function list_user_orgs(p_user_id uuid)
returns table (org_id uuid, slug text, name text, role text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select o.id, o.slug, o.name, m.role
  from memberships m join orgs o on o.id = m.org_id
  where m.user_id = p_user_id and m.status = 'active' and o.status in ('active', 'suspended')
  order by o.name, o.id
$$;

-- X-FR-Org validation: the user's role in the org, or null.
create function membership_for(p_user_id uuid, p_org_id uuid)
returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select m.role
  from memberships m join orgs o on o.id = m.org_id
  where m.user_id = p_user_id and m.org_id = p_org_id and m.status = 'active' and o.status in ('active', 'suspended')
$$;

-- Org-spanning jobs list candidate orgs, then run one withTenant per org; each handler decides in-tenant
-- whether there is work. Unknown job names fail, so a typo never silently processes nothing.
create function orgs_due_for(p_job text)
returns setof uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if p_job is null or p_job not in (
    'retention.sweep', 'drafts.expire', 'analytics.rollup', 'audit.checkpoint',
    'payment.reconcile', 'billing.meter', 'kms.rotate', 'dsr.overdue'
  ) then
    raise exception 'orgs_due_for: unknown job %', p_job using errcode = 'invalid_parameter_value';
  end if;
  return query select o.id from orgs o where o.status <> 'deleted' order by o.id;
end
$$;

-- Job handlers re-derive the org from the resource and abort on mismatch (architecture §5.1, ADR-0016).
-- Returns null when the resource does not exist. Later tables extend the case list.
create function resolve_job_org(p_resource_type text, p_resource_id uuid)
returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  case p_resource_type
    when 'org' then return (select o.id from orgs o where o.id = p_resource_id);
    when 'form' then return (select f.org_id from forms f where f.id = p_resource_id);
    when 'form_draft' then return (select d.org_id from form_drafts d where d.form_id = p_resource_id);
    else raise exception 'resolve_job_org: unknown resource type %', p_resource_type using errcode = 'invalid_parameter_value';
  end case;
end
$$;

-- Monthly range partitions for a partitioned table in public: the current month plus p_months ahead,
-- created in schema parts with RLS enabled and forced and no privileges for anyone but the owner.
-- Returns the partitions it created. There is never a default partition.
create function create_partitions(p_parent regclass, p_months integer)
returns setof text
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
declare
  v_table text;
  v_start timestamp;
  v_name text;
begin
  if p_months is null or p_months < 0 or p_months > 24 then
    raise exception 'create_partitions: months must be between 0 and 24, got %', p_months using errcode = 'invalid_parameter_value';
  end if;
  select c.relname into v_table
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_partitioned_table p on p.partrelid = c.oid
  where c.oid = p_parent and n.nspname = 'public' and p.partstrat = 'r' and p.partnatts = 1;
  if v_table is null then
    raise exception 'create_partitions: % is not a range-partitioned table in public', p_parent using errcode = 'invalid_parameter_value';
  end if;
  for i in 0..p_months loop
    -- Month boundaries in UTC, whatever the session time zone.
    v_start := date_trunc('month', now() at time zone 'UTC') + make_interval(months => i);
    v_name := format('%s_%s', v_table, to_char(v_start, 'YYYY_MM'));
    continue when to_regclass(format('parts.%I', v_name)) is not null;
    execute format('create table parts.%I partition of public.%I for values from (%L) to (%L)',
      v_name, v_table, to_char(v_start, 'YYYY-MM-DD"T"HH24:MI:SS"+00"'),
      to_char(v_start + interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS"+00"'));
    execute format('alter table parts.%I enable row level security, force row level security', v_name);
    execute format('revoke all on table parts.%I from public', v_name);
    return next v_name;
  end loop;
end
$$;

grant execute on function list_user_orgs(uuid), membership_for(uuid, uuid), orgs_due_for(text),
  resolve_job_org(text, uuid), create_partitions(regclass, integer) to fr_app;
