-- The audit chain (architecture §2.7, ADR-0006, WP-1.04): per-org heads, the BEFORE INSERT continuity check,
-- signed checkpoints, monthly archives and the narrow definer functions of the chain worker. Business code only
-- ever inserts into audit_pending; audit.chain moves the rows into audit_log. Platform events are chained under
-- the zero org key, which is also their audit_log.org_id, so every row belongs to exactly one chain.

alter table audit_log alter column org_id set not null;
-- Rows enter audit_log only through audit_log_append(), which the chain worker calls while it holds the head.
revoke insert on audit_log from fr_app;

create index audit_pending_org_key on audit_pending (org_key, id);

create function audit_genesis() returns bytea language sql immutable as $$ select decode(repeat('00', 32), 'hex') $$;

-- The last link of each chain. Only the continuity trigger changes it; tenants may read their own.
create table audit_heads (
  org_key uuid primary key,
  seq bigint not null check (seq >= 0),
  hash bytea not null check (length(hash) = 32),
  updated_at timestamptz not null default now()
);
alter table audit_heads enable row level security;
alter table audit_heads force row level security;
create policy audit_heads_tenant on audit_heads for select to fr_app using (org_key = (select app_org()));
grant select on audit_heads to fr_app;

-- Every insert must continue its chain: seq = head.seq + 1 and prev_hash = head.hash. The head advances in the
-- same statement, so a gap, a fork or a replay is refused for every role, the owner included.
create function audit_log_continue_chain() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_seq bigint;
  v_hash bytea;
begin
  if length(new.hash) <> 32 or length(new.prev_hash) <> 32 then
    raise exception 'audit_log: hashes must be 32 bytes' using errcode = 'check_violation';
  end if;
  -- Checked first: an INSERT that meets a head row another transaction has changed waits for that transaction.
  if not exists (select 1 from audit_heads h where h.org_key = new.org_id) then
    insert into audit_heads (org_key, seq, hash) values (new.org_id, 0, audit_genesis()) on conflict (org_key) do nothing;
  end if;
  select h.seq, h.hash into v_seq, v_hash from audit_heads h where h.org_key = new.org_id for update;
  if new.seq <> v_seq + 1 or new.prev_hash <> v_hash then
    raise exception 'audit_log: seq % does not continue the chain of % (head at seq %)', new.seq, new.org_id, v_seq
      using errcode = 'integrity_constraint_violation';
  end if;
  update audit_heads set seq = new.seq, hash = new.hash, updated_at = now() where org_key = new.org_id;
  return new;
end
$$;
create trigger audit_log_chain before insert on audit_log for each row execute function audit_log_continue_chain();

-- Hourly signed anchors of each head (audit.checkpoint). A checkpoint can only name a link that exists.
create table audit_checkpoints (
  org_key uuid not null,
  seq bigint not null check (seq >= 1),
  hash bytea not null check (length(hash) = 32),
  signed_at timestamptz not null,
  key_id text not null,
  alg text not null check (alg in ('ed25519', 'es256')),
  signature bytea not null,
  anchored_object text,
  primary key (org_key, seq)
);
alter table audit_checkpoints enable row level security;
alter table audit_checkpoints force row level security;
-- Tenants read their own; only the chain worker (a system actor inside the tenant) records one.
create policy audit_checkpoints_tenant on audit_checkpoints for select to fr_app using (org_key = (select app_org()));
create policy audit_checkpoints_tenant_insert on audit_checkpoints for insert to fr_app
  with check (org_key = (select app_org()) and (select app_actor()) = 'system');
grant select, insert on audit_checkpoints to fr_app;
create trigger audit_checkpoints_append_only before update or delete on audit_checkpoints
  for each row execute function audit_append_only();

create function audit_checkpoint_names_a_link() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from audit_log l where l.org_id = new.org_key and l.seq = new.seq and l.hash = new.hash) then
    raise exception 'audit_checkpoints: % has no link at seq % with that hash', new.org_key, new.seq
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;
create trigger audit_checkpoints_link before insert on audit_checkpoints
  for each row execute function audit_checkpoint_names_a_link();

-- One NDJSON.zst object per org and month in the audit bucket, written before the month's partition is detached.
create table audit_archives (
  org_key uuid not null,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  object_key text not null,
  row_count bigint not null check (row_count > 0),
  min_seq bigint not null,
  max_seq bigint not null,
  sha256 bytea not null check (length(sha256) = 32),
  archived_at timestamptz not null default now(),
  primary key (org_key, month),
  check (min_seq between 1 and max_seq)
);
alter table audit_archives enable row level security;
alter table audit_archives force row level security;
create policy audit_archives_tenant on audit_archives for select to fr_app using (org_key = (select app_org()));
create policy audit_archives_tenant_insert on audit_archives for insert to fr_app
  with check (org_key = (select app_org()) and (select app_actor()) = 'system');
grant select, insert on audit_archives to fr_app;
create trigger audit_archives_append_only before update or delete on audit_archives
  for each row execute function audit_append_only();

-- The chain worker's functions need a system actor inside the tenant of the chain (withTenant on the org key).
create function audit_chain_org(p_fn text) returns uuid
language plpgsql stable set search_path = pg_catalog, public as $$
declare
  v_org uuid := app_org();
begin
  if v_org is null or app_actor() <> 'system' then
    raise exception '%: needs a system actor inside the tenant of the chain', p_fn using errcode = 'insufficient_privilege';
  end if;
  return v_org;
end
$$;

-- The cross-chain functions (key listings, partition detach) need a system actor in the platform tenant.
create function audit_platform_system(p_fn text) returns void
language plpgsql stable set search_path = pg_catalog, public as $$
begin
  if app_org() is distinct from '00000000-0000-0000-0000-000000000000'::uuid or app_actor() <> 'system' then
    raise exception '%: needs a system actor inside the platform tenant', p_fn using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- Takes the head of the current chain for this transaction, creating it at genesis. No rows when another
-- chainer holds it: that one is already moving the pending rows.
create function audit_chain_begin()
returns table (seq bigint, hash bytea)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_org uuid := audit_chain_org('audit_chain_begin');
begin
  -- A plain read first: an INSERT that meets the head another chainer is advancing would wait for it.
  if not exists (select 1 from audit_heads h where h.org_key = v_org) then
    insert into audit_heads (org_key, seq, hash) values (v_org, 0, audit_genesis()) on conflict (org_key) do nothing;
  end if;
  return query select h.seq, h.hash from audit_heads h where h.org_key = v_org for update skip locked;
end
$$;

-- Removes and returns the oldest pending rows of the current chain; a rollback puts the rows back. The call takes
-- the head row FOR UPDATE NOWAIT: it is a no-op for the transaction that audit_chain_begin() gave the head, takes
-- the head for a caller that skipped it, and fails fast while another chainer holds it. Either way only the head's
-- holder takes rows, and the continuity trigger checks the links it appends.
create function audit_pending_take(p_limit integer)
returns table (id bigint, event jsonb, occurred_at text)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_org uuid := audit_chain_org('audit_pending_take');
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'audit_pending_take: limit must be between 1 and 5000' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from audit_heads h where h.org_key = v_org for update nowait;
  if not found then
    raise exception 'audit_pending_take: call audit_chain_begin() first' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return query
    with taken as (
      delete from audit_pending p
      where p.id in (select p2.id from audit_pending p2 where p2.org_key = v_org order by p2.id limit p_limit for update)
      returning p.id, p.event, p.occurred_at
    )
    select t.id, t.event, to_char(t.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from taken t order by t.id;
end
$$;

-- Appends hashed rows to the current chain, in seq order; the continuity trigger checks every one.
create function audit_log_append(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_org uuid := audit_chain_org('audit_log_append');
  v_n integer := 0;
  r record;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'audit_log_append: rows must be a json array' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from audit_heads h where h.org_key = v_org for update nowait;
  if not found then
    raise exception 'audit_log_append: call audit_chain_begin() first' using errcode = 'object_not_in_prerequisite_state';
  end if;
  for r in
    select * from jsonb_to_recordset(p_rows) as x(
      seq bigint, occurred_at timestamptz, actor_kind text, actor_id uuid, impersonator_id uuid, session_id uuid,
      api_key_id uuid, actor_ip_hash text, actor_ua text, action text, resource_type text, resource_id text,
      form_id uuid, outcome text, reason text, metadata jsonb, request_id text, trace_id text, prev_hash text, hash text)
    order by x.seq
  loop
    insert into audit_log (org_id, seq, occurred_at, actor_kind, actor_id, impersonator_id, session_id, api_key_id,
      actor_ip_hash, actor_ua, action, resource_type, resource_id, form_id, outcome, reason, metadata, request_id,
      trace_id, prev_hash, hash)
    values (v_org, r.seq, r.occurred_at, r.actor_kind, r.actor_id, r.impersonator_id, r.session_id, r.api_key_id,
      decode(r.actor_ip_hash, 'hex'), r.actor_ua, r.action, r.resource_type, r.resource_id, r.form_id, r.outcome, r.reason,
      coalesce(r.metadata, '{}'), r.request_id, r.trace_id, decode(r.prev_hash, 'hex'), decode(r.hash, 'hex'));
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- The dispatcher's view: which chains have pending rows, and how old the oldest is (chain lag).
create function audit_pending_keys()
returns table (org_key uuid, oldest timestamptz, pending bigint)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
begin
  perform audit_platform_system('audit_pending_keys');
  return query select p.org_key, min(p.occurred_at), count(*) from audit_pending p group by p.org_key order by min(p.occurred_at);
end
$$;

-- Every chain that exists: what audit.checkpoint, audit.verify and audit.archive walk (the platform key included).
create function audit_chain_keys()
returns setof uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform audit_platform_system('audit_chain_keys');
  return query select h.org_key from audit_heads h order by h.org_key;
end
$$;

-- Detaches the month's partition once every chain in it is archived with the same row count. Months inside the
-- 13-month online window are refused. Returns the detached partition, or null when it is not attached. The detach
-- needs an exclusive lock on audit_log; waiting for it (behind a long audit.verify) would queue every chainer, so
-- it gives up after 5 s and the job retries. Verify treats an archived month that is still attached as online.
create function audit_archive_detach(p_month text)
returns text
language plpgsql volatile security definer set search_path = pg_catalog, public set lock_timeout = '5s' as $$
declare
  v_start timestamptz;
  v_name text;
  v_rel regclass;
  v_missing uuid;
begin
  perform audit_platform_system('audit_archive_detach');
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'audit_archive_detach: month must be YYYY-MM' using errcode = 'invalid_parameter_value';
  end if;
  v_start := (p_month || '-01 00:00:00+00')::timestamptz;
  if v_start + interval '1 month' > (date_trunc('month', now() at time zone 'UTC') - interval '13 months') at time zone 'UTC' then
    raise exception 'audit_archive_detach: % is inside the 13-month online window', p_month using errcode = 'invalid_parameter_value';
  end if;
  v_name := 'audit_log_' || replace(p_month, '-', '_');
  v_rel := to_regclass(format('parts.%I', v_name));
  if v_rel is null or not exists (select 1 from pg_inherits i where i.inhrelid = v_rel and i.inhparent = 'public.audit_log'::regclass) then
    return null;
  end if;
  execute format(
    'select c.org_id from (select org_id, count(*) as n from parts.%I group by org_id) c
     left join audit_archives a on a.org_key = c.org_id and a.month = $1
     where a.row_count is distinct from c.n limit 1', v_name)
    into v_missing using p_month;
  if v_missing is not null then
    raise exception 'audit_archive_detach: % of % is not archived', p_month, v_missing using errcode = 'object_not_in_prerequisite_state';
  end if;
  execute format('alter table public.audit_log detach partition parts.%I', v_name);
  return 'parts.' || v_name;
end
$$;

-- Job handlers re-derive the org from the resource (ADR-0016). An audit chain belongs to its own key while it
-- has pending rows or a head; the zero key is the platform chain.
create or replace function resolve_job_org(p_resource_type text, p_resource_id uuid)
returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  case p_resource_type
    when 'org' then return (select o.id from orgs o where o.id = p_resource_id);
    when 'form' then return (select f.org_id from forms f where f.id = p_resource_id);
    when 'form_draft' then return (select d.org_id from form_drafts d where d.form_id = p_resource_id);
    when 'audit_chain' then return (
      select p_resource_id
      where exists (select 1 from audit_pending p where p.org_key = p_resource_id)
         or exists (select 1 from audit_heads h where h.org_key = p_resource_id));
    else raise exception 'resolve_job_org: unknown resource type %', p_resource_type using errcode = 'invalid_parameter_value';
  end case;
end
$$;

grant execute on function audit_chain_begin(), audit_pending_take(integer), audit_log_append(jsonb), audit_pending_keys(),
  audit_chain_keys(), audit_archive_detach(text) to fr_app;
