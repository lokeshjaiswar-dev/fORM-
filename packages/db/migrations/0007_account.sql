-- The platform as Data Fiduciary for its own users (CMP-21, WP-1.31): which privacy notice each user was shown, their
-- privacy requests and grievances, and account export and deletion. Rows are the user's own (like sessions): the
-- policies key on app_user() for a user actor. Deletion and the export of rows outside the user's reach (memberships,
-- the platform audit chain) go through the definer functions below, callable only in the user's own context.

alter table users add column deleted_at timestamptz;
alter table users add constraint users_deleted_check check ((status = 'deleted') = (deleted_at is not null));

-- One row per notice text a user acknowledged: at sign-up, at a first OAuth sign-in, or later in the builder settings.
-- Kept after the account is deleted, against the pseudonymous id: the record of which notice was given.
create table user_notice_acks (
  id uuid primary key,
  user_id uuid not null references users (id),
  notice_version text not null check (notice_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,3})?$'),
  notice_hash bytea not null check (length(notice_hash) = 32),
  locale text not null check (length(locale) between 2 and 35),
  context text not null check (context in ('signup', 'oauth_signup', 'settings')),
  acknowledged_at timestamptz not null default now(),
  unique (user_id, notice_hash)
);
alter table user_notice_acks enable row level security;
alter table user_notice_acks force row level security;
create policy user_notice_acks_self on user_notice_acks for all to fr_app
  using (user_id = (select app_user()) and (select app_actor()) = 'user')
  with check (user_id = (select app_user()) and (select app_actor()) = 'user');
grant select, insert on user_notice_acks to fr_app;
create trigger user_notice_acks_append_only before update or delete on user_notice_acks
  for each row execute function audit_append_only();

-- Requests and grievances a builder user sends the platform's privacy contact (DPDP s.13; answered within 90 days).
-- The message goes when the account is deleted; the reference, category and dates stay for the record.
create table user_grievances (
  id uuid primary key,
  user_id uuid not null references users (id),
  reference text not null unique check (reference ~ '^GRV-[A-Z2-7]{8}$'),
  category text not null check (category in ('information', 'correction', 'erasure', 'nomination', 'complaint', 'other')),
  message text check (length(message) between 1 and 5000),
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at timestamptz not null default now(),
  due_at timestamptz not null,
  closed_at timestamptz,
  check (due_at > created_at and due_at <= created_at + interval '90 days'),
  check ((status = 'closed') = (closed_at is not null)),
  check (message is not null or status = 'closed')
);
create index user_grievances_user_id_idx on user_grievances (user_id, created_at desc);
create index user_grievances_open_due_idx on user_grievances (due_at) where status = 'open';
alter table user_grievances enable row level security;
alter table user_grievances force row level security;
create policy user_grievances_self on user_grievances for all to fr_app
  using (user_id = (select app_user()) and (select app_actor()) = 'user')
  with check (user_id = (select app_user()) and (select app_actor()) = 'user' and status = 'open');
grant select, insert on user_grievances to fr_app;

-- The account functions run only for the user themselves, in their own context (withUser), never in an org.
create function account_self(p_user_id uuid, p_fn text) returns void
language plpgsql stable set search_path = pg_catalog, public as $$
begin
  if p_user_id is null or app_user() is distinct from p_user_id or app_actor() <> 'user' or app_org() is not null then
    raise exception '%: only the user themselves, outside any org', p_fn using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- The org side of the account, for deletion: per org, the user's role, who else is there, the forms the user owns and
-- the owner they would pass to. blocker: last_member (nobody would be left to manage the org's data), sole_owner (the
-- org would have no owner), no_owner_for_forms (forms to hand over and no owner to take them).
create function account_org_plan(p_user_id uuid)
returns table (org_id uuid, slug text, name text, role text, other_owners integer, other_members integer, forms_owned integer,
  heir_user_id uuid, blocker text)
language sql stable set search_path = pg_catalog, public as $$
  with mine as (
    select m.org_id, o.slug, o.name, m.role
    from memberships m join orgs o on o.id = m.org_id
    where m.user_id = p_user_id and o.status <> 'deleted'
  ), counted as (
    select mine.*,
      (select count(*)::integer from memberships x join users u on u.id = x.user_id
       where x.org_id = mine.org_id and x.user_id <> p_user_id and x.role = 'owner' and x.status = 'active' and u.status = 'active') as other_owners,
      (select count(*)::integer from memberships x where x.org_id = mine.org_id and x.user_id <> p_user_id) as other_members,
      (select count(*)::integer from forms f where f.org_id = mine.org_id and f.owner_user_id = p_user_id) as forms_owned,
      (select x.user_id from memberships x join users u on u.id = x.user_id
       where x.org_id = mine.org_id and x.user_id <> p_user_id and x.role = 'owner' and x.status = 'active' and u.status = 'active'
       order by x.created_at, x.user_id limit 1) as heir_user_id
    from mine
  )
  select c.org_id, c.slug, c.name, c.role, c.other_owners, c.other_members, c.forms_owned, c.heir_user_id,
    case
      when c.other_members = 0 then 'last_member'
      when c.role = 'owner' and c.other_owners = 0 then 'sole_owner'
      when c.forms_owned > 0 and c.heir_user_id is null then 'no_owner_for_forms'
    end
  from counted c
  order by c.name, c.org_id
$$;

-- POST /v1/me/export: what the user's own context cannot read. Their memberships (every status) with the forms they
-- own, and their own events on the platform audit chain from the last 13 months (the chain's online window).
create function account_export_data(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform account_self(p_user_id, 'account_export_data');
  return jsonb_build_object(
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('orgId', o.id, 'orgSlug', o.slug, 'orgName', o.name, 'role', m.role, 'status', m.status,
        'joinedAt', m.created_at,
        'formsOwned', (select count(*) from forms f where f.org_id = m.org_id and f.owner_user_id = p_user_id)) order by o.name, o.id)
      from memberships m join orgs o on o.id = m.org_id
      where m.user_id = p_user_id), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('occurredAt', l.occurred_at, 'action', l.action, 'outcome', l.outcome, 'reason', l.reason,
        'resourceType', l.resource_type, 'resourceId', l.resource_id, 'sessionId', l.session_id, 'userAgent', l.actor_ua,
        'metadata', l.metadata) order by l.occurred_at desc, l.seq desc)
      from (
        select * from audit_log a
        where a.org_id = '00000000-0000-0000-0000-000000000000'::uuid and a.actor_id = p_user_id
          and a.occurred_at > now() - interval '13 months'
        order by a.occurred_at desc, a.seq desc limit 5000
      ) l), '[]'::jsonb)
  );
end
$$;

-- POST /v1/me/delete (p_apply) and GET /v1/me/deletion (the same plan, nothing changed). Blocked while any org would
-- be left without an owner or without members; otherwise, in one transaction: the user's forms pass to an owner of
-- their org (org data stays with the org), the memberships, sessions, linked accounts and email tokens go, open
-- grievances are closed without their message, and the user row is reduced to a pseudonymous tombstone, so audit
-- records and form history keep pointing at an id that no longer names anyone. The address is free to sign up again.
create function account_delete(p_user_id uuid, p_apply boolean)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
declare
  v_plan jsonb;
  v_blocked boolean;
  v_forms integer;
  v_sessions integer;
  v_orgs integer;
begin
  perform account_self(p_user_id, 'account_delete');
  if p_apply then
    -- Membership changes in the user's orgs wait for this transaction, so the plan cannot go stale before it is applied.
    perform 1 from users u where u.id = p_user_id and u.status <> 'deleted' for update;
    if not found then
      raise exception 'account_delete: no such account' using errcode = 'no_data_found';
    end if;
    perform 1 from memberships m where m.org_id in (select x.org_id from memberships x where x.user_id = p_user_id) for update;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('orgId', p.org_id, 'slug', p.slug, 'name', p.name, 'role', p.role,
      'formsOwned', p.forms_owned, 'formsTo', p.heir_user_id, 'blocker', p.blocker)), '[]'::jsonb),
    coalesce(bool_or(p.blocker is not null), false)
  into v_plan, v_blocked
  from account_org_plan(p_user_id) p;
  if v_blocked or not p_apply then
    return jsonb_build_object('status', case when v_blocked then 'blocked' else 'ready' end, 'orgs', v_plan);
  end if;

  update forms f set owner_user_id = p.heir_user_id
  from account_org_plan(p_user_id) p
  where f.org_id = p.org_id and f.owner_user_id = p_user_id and p.heir_user_id is not null;
  get diagnostics v_forms = row_count;
  delete from memberships m where m.user_id = p_user_id;
  get diagnostics v_orgs = row_count;
  delete from sessions s where s.user_id = p_user_id;
  get diagnostics v_sessions = row_count;
  delete from user_identities i where i.user_id = p_user_id;
  delete from auth_tokens t where t.user_id = p_user_id;
  update user_grievances g set message = null, status = 'closed', closed_at = coalesce(g.closed_at, now())
  where g.user_id = p_user_id and (g.message is not null or g.status <> 'closed');
  update users u set
    email = 'deleted-' || u.id || '@deleted.invalid', email_norm = 'deleted-' || u.id || '@deleted.invalid',
    email_verified_at = null, name = null, locale = null, password_hash = null, totp_secret_enc = null, totp_enabled_at = null,
    totp_last_step = null, recovery_code_hashes = null, last_login_at = null, status = 'deleted', deleted_at = now()
  where u.id = p_user_id;
  return jsonb_build_object('status', 'deleted', 'orgs', v_plan, 'orgsLeft', v_orgs, 'formsReassigned', v_forms, 'sessionsEnded', v_sessions);
end
$$;

grant execute on function account_export_data(uuid), account_delete(uuid, boolean) to fr_app;
