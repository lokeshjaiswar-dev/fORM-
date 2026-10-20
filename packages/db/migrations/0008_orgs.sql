-- Organisations, members, invites and org settings (WP-1.02, architecture §2.4): org defaults, the permission
-- checks RLS adds under the API's (WSP-03), invites accepted through invite_accept(), org creation through
-- create_org(), and membership_for() with the permissions an org grants on top of a role (CMP-24).

-- Org defaults (WSP-09). The API also checks the time zone against the IANA list.
alter table orgs
  add constraint orgs_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  add constraint orgs_name_length check (char_length(btrim(name)) between 1 and 100),
  add constraint orgs_locale_format check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  add constraint orgs_time_zone_length check (char_length(time_zone) between 1 and 64),
  add constraint orgs_date_format_known check (date_format in ('DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY', 'MMMM D, YYYY'));

-- Org fields change only with org.settings (or from a job). Restrictive, so the tenant policy still applies.
create policy orgs_settings_write on orgs as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]));

-- Members change with members.manage; a member may also leave (delete their own row). Invites are accepted and orgs
-- created inside definer functions, which add the rows themselves.
create policy memberships_manage_insert on memberships as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
create policy memberships_manage_update on memberships as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
create policy memberships_manage_delete on memberships as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[])
    or ((select app_actor()) = 'user' and user_id = (select app_user())));
revoke update on memberships from fr_app;
grant update (role, status) on memberships to fr_app;

-- Every org keeps an active owner: removing, demoting or suspending the last one fails, whoever asks. Owner changes
-- of one org take a transaction lock first, so two concurrent ones cannot each leave the other as the last owner.
create function memberships_last_owner_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.role <> 'owner' or old.status <> 'active' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fr:org_owners:' || old.org_id::text, 0));
  if not exists (
    select 1 from memberships m
    where m.org_id = old.org_id and m.user_id <> old.user_id and m.role = 'owner' and m.status = 'active'
  ) and exists (select 1 from orgs o where o.id = old.org_id and o.status <> 'deleted') then
    raise exception 'memberships: an org keeps at least one active owner' using errcode = 'check_violation', constraint = 'memberships_last_owner';
  end if;
  return coalesce(new, old);
end
$$;
create trigger memberships_last_owner_guard before update of role, status or delete on memberships
  for each row execute function memberships_last_owner_guard();

-- Draft writes need forms.edit (or a job): a viewer's write changes nothing even if a route forgets its check.
create policy form_drafts_edit_insert on form_drafts as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]));
create policy form_drafts_edit_update on form_drafts as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]));
create policy form_drafts_edit_delete on form_drafts as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]));

-- Per-org settings beside the org defaults on orgs. One row per org; create_org() adds it, the API upserts it for
-- orgs created before it existed.
create table org_settings (
  org_id uuid primary key references orgs (id),
  -- CMP-24: approving a form's privacy notice is grantable to editors (architecture §2.4, permissions table).
  editors_approve_notice boolean not null default false,
  invite_days integer not null default 7 check (invite_days between 1 and 30),
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);
alter table org_settings enable row level security;
alter table org_settings force row level security;
create policy org_settings_tenant on org_settings for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy org_settings_write_insert on org_settings as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]));
create policy org_settings_write_update on org_settings as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]));
grant select on org_settings to fr_app;
grant insert (org_id, editors_approve_notice, invite_days, updated_at, updated_by) on org_settings to fr_app;
grant update (editors_approve_notice, invite_days, updated_at, updated_by) on org_settings to fr_app;
insert into org_settings (org_id) select id from orgs;

-- Invitations by email (WSP-02). Only the SHA-256 of the link token is stored, and fr_app cannot read it: the link is
-- looked up with invite_by_token() and redeemed with invite_accept(). Accepted and revoked invites are final.
create table invites (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  email text not null check (char_length(email) between 3 and 254),
  email_norm text not null check (email_norm = lower(email_norm) and position('@' in email_norm) > 1),
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  team_ids uuid[] not null default '{}',
  token_hash bytea not null unique check (length(token_hash) = 32),
  invited_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references users (id),
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check (accepted_at is null or revoked_at is null),
  check ((accepted_at is null) = (accepted_by is null))
);
-- One open invite per address and org; inviting again revokes the open one first.
create unique index invites_open_email on invites (org_id, email_norm) where accepted_at is null and revoked_at is null;
create index invites_org_created on invites (org_id, created_at desc);
alter table invites enable row level security;
alter table invites force row level security;
create policy invites_tenant on invites for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy invites_manage on invites as restrictive for all to fr_app
  using ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
grant select (id, org_id, email, email_norm, role, team_ids, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)
  on invites to fr_app;
grant insert (id, org_id, email, email_norm, role, team_ids, token_hash, invited_by, expires_at) on invites to fr_app;
grant update (revoked_at) on invites to fr_app;

create function invites_final_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception 'invites: an accepted or revoked invite stays as it is' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger invites_final_guard before update on invites for each row execute function invites_final_guard();

-- Sessions remember the org chosen in the switcher (the default when a request names none); a change of a member's
-- role revokes their sessions bound to that org, so the new privilege starts with a fresh token (ADR-0017).
grant update (active_org_id) on sessions to fr_app;
alter table sessions drop constraint sessions_revoked_reason_check;
alter table sessions add constraint sessions_revoked_reason_check
  check (revoked_reason in ('logout', 'rotated', 'revoked', 'password_reset', 'mfa_enabled', 'mfa_disabled', 'role_changed'));

-- BL-193: occurred_at comes from the database clock, never from the writer.
revoke insert on audit_pending from fr_app;
grant insert (org_key, event) on audit_pending to fr_app;

-- X-FR-Org validation: the user's role in the org, and the permissions the org's settings grant on top of it.
drop function membership_for(uuid, uuid);
create function membership_for(p_user_id uuid, p_org_id uuid)
returns table (role text, grants text[])
language sql stable security definer set search_path = pg_catalog, public as $$
  select m.role,
    case when m.role = 'editor' and coalesce(s.editors_approve_notice, false) then array['compliance.approve_notice'] else '{}'::text[] end
  from memberships m join orgs o on o.id = m.org_id left join org_settings s on s.org_id = m.org_id
  where m.user_id = p_user_id and m.org_id = p_org_id and m.status = 'active' and o.status in ('active', 'suspended')
$$;

-- POST /v1/orgs: a new org with its settings and the signed-in user as owner, in the caller's user context. The
-- caller must be that user, active and verified. 'slug_taken' when the slug is in use, 'limit' past 25 owned orgs.
create function create_org(p_org_id uuid, p_slug text, p_name text, p_user_id uuid, p_locale text, p_time_zone text, p_date_format text)
returns text
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
begin
  if p_user_id is null or p_user_id is distinct from app_user() or app_actor() <> 'user' then
    raise exception 'create_org: only the signed-in user can create an org for themselves' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from users u where u.id = p_user_id and u.status = 'active' and u.email_verified_at is not null) then
    raise exception 'create_org: the user must be active and verified' using errcode = 'insufficient_privilege';
  end if;
  if (select count(*) from memberships m where m.user_id = p_user_id and m.role = 'owner') >= 25 then
    return 'limit';
  end if;
  insert into orgs (id, slug, name, locale, time_zone, date_format)
  values (p_org_id, p_slug, btrim(p_name), coalesce(p_locale, 'en-IN'), coalesce(p_time_zone, 'Asia/Kolkata'), coalesce(p_date_format, 'DD-MM-YYYY'))
  on conflict (slug) do nothing;
  if not found then
    return 'slug_taken';
  end if;
  insert into org_settings (org_id, updated_by) values (p_org_id, p_user_id);
  insert into memberships (org_id, user_id, role) values (p_org_id, p_user_id, 'owner');
  return 'created';
end
$$;

-- Who an invite link is for, before it is used: the org, the role, the address and the state of the invite.
create function invite_by_token(p_token_hash bytea)
returns table (invite_id uuid, org_id uuid, org_name text, email text, role text, inviter_name text, state text, expires_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public as $$
  select i.id, i.org_id, o.name, i.email, i.role, coalesce(u.name, u.email),
    case
      when i.revoked_at is not null then 'revoked'
      when i.accepted_at is not null then 'used'
      when i.expires_at <= now() then 'expired'
      when o.status <> 'active' then 'org_inactive'
      else 'open' end,
    i.expires_at
  from invites i join orgs o on o.id = i.org_id join users u on u.id = i.invited_by
  where i.token_hash = p_token_hash
$$;

-- Redeems an invite for the signed-in user (the caller), whose verified address must be the invited one. Adds the
-- membership (an existing active one keeps its role) and records the acceptance in one transaction. Outcomes:
-- accepted, already_member, unknown, revoked, used, expired, org_inactive, email_not_verified, email_mismatch, suspended.
create function invite_accept(p_token_hash bytea, p_user_id uuid)
returns table (outcome text, invite_id uuid, org_id uuid, role text)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  i invites%rowtype;
  v_org_status text;
  v_user_status text;
  v_verified boolean;
  v_email_norm text;
  v_member_status text;
  v_outcome text;
begin
  if p_user_id is null or p_user_id is distinct from app_user() or app_actor() <> 'user' then
    raise exception 'invite_accept: only the signed-in user can accept an invite for themselves' using errcode = 'insufficient_privilege';
  end if;
  select * into i from invites t where t.token_hash = p_token_hash for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  select o.status into v_org_status from orgs o where o.id = i.org_id;
  select u.status, u.email_verified_at is not null, u.email_norm into v_user_status, v_verified, v_email_norm from users u where u.id = p_user_id;
  select m.status into v_member_status from memberships m where m.org_id = i.org_id and m.user_id = p_user_id;
  v_outcome := case
    when i.revoked_at is not null then 'revoked'
    when i.accepted_at is not null then 'used'
    when i.expires_at <= now() then 'expired'
    when v_org_status is distinct from 'active' then 'org_inactive'
    when v_user_status is distinct from 'active' or not coalesce(v_verified, false) then 'email_not_verified'
    when v_email_norm is distinct from i.email_norm then 'email_mismatch'
    when v_member_status = 'suspended' then 'suspended'
    when v_member_status = 'active' then 'already_member'
    else 'accepted' end;
  if v_outcome = 'accepted' then
    insert into memberships (org_id, user_id, role) values (i.org_id, p_user_id, i.role);
  end if;
  if v_outcome in ('accepted', 'already_member') then
    update invites t set accepted_at = now(), accepted_by = p_user_id where t.id = i.id;
  end if;
  return query select v_outcome, i.id, i.org_id,
    case when v_outcome = 'already_member' then (select m.role from memberships m where m.org_id = i.org_id and m.user_id = p_user_id) else i.role end;
end
$$;

-- After a member's role or status changed: revokes their live sessions bound to the current org (the switcher's
-- choice), so the new privilege starts with a fresh token. Only for a user with members.manage in that org.
create function member_sessions_revoke(p_user_id uuid)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
declare
  v_count integer;
begin
  if app_actor() <> 'user' or app_org() is null or not ('members.manage' = any (app_perms())) then
    raise exception 'member_sessions_revoke: needs members.manage in the current org' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from memberships m where m.org_id = app_org() and m.user_id = p_user_id) then
    return 0;
  end if;
  update sessions s set revoked_at = now(), revoked_reason = 'role_changed'
  where s.user_id = p_user_id and s.active_org_id = app_org() and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- BL-203: without SMTP, an admin hands a member a one-time link (a password reset, or the email verification while
-- the address is unconfirmed). Only for a member of the current org who belongs to no other org (an org admin
-- cannot take over an account another org relies on); admins and owners only by an owner; never for oneself.
-- Outcomes: issued, not_a_member, other_orgs, forbidden, inactive; the purpose comes back with 'issued'.
create function member_access_token(p_user_id uuid, p_token_id uuid, p_token_hash bytea, p_minutes integer)
returns table (outcome text, purpose text)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_target_role text;
  v_caller_role text;
  v_status text;
  v_verified boolean;
  v_purpose text;
begin
  if app_actor() <> 'user' or app_org() is null or not ('members.manage' = any (app_perms())) then
    raise exception 'member_access_token: needs members.manage in the current org' using errcode = 'insufficient_privilege';
  end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 1440 then
    raise exception 'member_access_token: minutes must be between 5 and 1440' using errcode = 'invalid_parameter_value';
  end if;
  select m.role into v_target_role from memberships m where m.org_id = app_org() and m.user_id = p_user_id and m.status = 'active';
  if v_target_role is null then
    return query select 'not_a_member'::text, null::text;
    return;
  end if;
  select m.role into v_caller_role from memberships m where m.org_id = app_org() and m.user_id = app_user() and m.status = 'active';
  if p_user_id = app_user() or v_caller_role is null or (v_target_role in ('owner', 'admin') and v_caller_role <> 'owner') then
    return query select 'forbidden'::text, null::text;
    return;
  end if;
  if exists (select 1 from memberships m where m.user_id = p_user_id and m.org_id <> app_org()) then
    return query select 'other_orgs'::text, null::text;
    return;
  end if;
  select u.status, u.email_verified_at is not null into v_status, v_verified from users u where u.id = p_user_id;
  if v_status is distinct from 'active' then
    return query select 'inactive'::text, null::text;
    return;
  end if;
  v_purpose := case when v_verified then 'password_reset' else 'verify_email' end;
  update auth_tokens t set consumed_at = now() where t.user_id = p_user_id and t.purpose = v_purpose and t.consumed_at is null;
  insert into auth_tokens (id, token_hash, purpose, user_id, data, expires_at)
  values (p_token_id, p_token_hash, v_purpose, p_user_id, jsonb_build_object('issuedBy', app_user(), 'orgId', app_org()), now() + make_interval(mins => p_minutes));
  return query select 'issued'::text, v_purpose;
end
$$;

grant execute on function membership_for(uuid, uuid), create_org(uuid, text, text, uuid, text, text, text), invite_by_token(bytea),
  invite_accept(bytea, uuid), member_sessions_revoke(uuid), member_access_token(uuid, uuid, bytea, integer) to fr_app;
