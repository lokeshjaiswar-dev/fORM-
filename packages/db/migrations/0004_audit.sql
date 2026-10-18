-- Audit placeholders (architecture §2.7). The chain worker (audit.chain), heads and checkpoints arrive in P1.

create function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;

-- Written by business code inside its transaction, or on a separate connection for denied and failed
-- actions. org_key is the org id, or the zero uuid for platform-level events.
create table audit_pending (
  id bigint generated always as identity primary key,
  org_key uuid not null,
  event jsonb not null,
  occurred_at timestamptz not null default now()
);
alter table audit_pending enable row level security;
alter table audit_pending force row level security;
create policy audit_pending_append on audit_pending for insert to fr_app
  with check (org_key = coalesce((select app_org()), '00000000-0000-0000-0000-000000000000'::uuid));
grant insert on audit_pending to fr_app;
create trigger audit_pending_append_only before update on audit_pending
  for each row execute function audit_append_only();

create table audit_log (
  id bigint generated always as identity,
  org_id uuid,
  seq bigint not null,
  occurred_at timestamptz not null,
  actor_kind text not null,
  actor_id uuid,
  impersonator_id uuid,
  session_id uuid,
  api_key_id uuid,
  actor_ip_hash bytea,
  actor_ua text,
  action text not null,
  resource_type text not null,
  resource_id text,
  form_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'error')),
  reason text,
  metadata jsonb not null default '{}',
  request_id text,
  trace_id text,
  prev_hash bytea not null,
  hash bytea not null,
  primary key (id, occurred_at)
) partition by range (occurred_at);
create unique index audit_log_org_seq on audit_log (org_id, seq, occurred_at);
create index audit_log_org_time on audit_log (org_id, occurred_at desc);
create index audit_log_org_resource on audit_log (org_id, resource_type, resource_id, occurred_at desc);
alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_log_tenant on audit_log for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert on audit_log to fr_app;
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function audit_append_only();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_append_only();

select create_partitions('public.audit_log'::regclass, 3);
