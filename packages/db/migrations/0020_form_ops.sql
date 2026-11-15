-- Publish and FormOps storage (WP-1.07: PUB-01, PUB-03, ACC-01..05, ACC-08; BL-241). Architecture §2.4.
--
-- 1. form_versions become immutable and gain the columns the publish pipeline stores (BL-241).
-- 2. form_version_state: the operational life of a version (superseded, retired), kept apart so the version row never
--    changes.
-- 3. form_access: who may open a form, when, how often, and the password (hash only, never selectable).
-- 4. form_slugs: every address a form ever had, so an old link keeps working and redirects to the primary one.
-- 5. form_counters: the atomic submission counter behind the limit (ACC-04).
-- 6. form_favourites: a member's own starred forms.
--
-- A new migration: 0013 and 0017 have been applied and are never edited.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. form_versions
-- ---------------------------------------------------------------------------------------------------------------

alter table form_versions add column label text;
-- The evaluation engine and its major version the compiled plan was made for, so a later engine can tell which
-- versions it must keep on the engine they were compiled for.
alter table form_versions add column engine text not null default 'logic@2';
-- The draft revision (form_drafts.draft_rev) this version froze: publishing the same revision twice returns the
-- version that exists. Null for the versions published before this column existed.
alter table form_versions add column draft_rev integer check (draft_rev is null or draft_rev >= 1);
-- Templates spec §5.1 (BL-241): where the form came from, and the org-profile values resolved at publish.
alter table form_versions add column template_lineage jsonb not null default '[]';
alter table form_versions add column variables_snapshot jsonb not null default '{}';

-- Children that name a version also name its org and form, so a row can never point at another form's version.
alter table form_versions add constraint form_versions_org_form_id_key unique (org_id, form_id, id);

-- A published version never changes and is never deleted (PUB-01): what a respondent saw must stay provable. The
-- trigger stops every role, the owner included; fr_app has no UPDATE or DELETE privilege on top of that, so the
-- refusal is a plain "permission denied" before the trigger is ever reached. The only way past it is the org purge
-- (CMP-17, not built yet), which will need its own reviewed path.
create function form_versions_immutable() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'form_versions: a published version is immutable (% refused)', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end
$$;
create trigger form_versions_immutable before update or delete on form_versions
  for each row execute function form_versions_immutable();
revoke update, delete on form_versions from fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. form_version_state
-- ---------------------------------------------------------------------------------------------------------------

-- superseded_at: when a newer version went live. retired_at: when the version stopped taking submissions for good
-- (nothing writes it yet; whether an old version still accepts one is worked out at submit time from superseded_at
-- and form_access.accept_previous_versions_hours). Every version has exactly one row: the trigger below makes it.
create table form_version_state (
  version_id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  superseded_at timestamptz,
  retired_at timestamptz,
  constraint form_version_state_version_fkey foreign key (org_id, form_id, version_id)
    references form_versions (org_id, form_id, id)
);
create index form_version_state_form_idx on form_version_state (org_id, form_id);
alter table form_version_state enable row level security;
alter table form_version_state force row level security;
create policy form_version_state_tenant on form_version_state for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- A respondent context reads the state of the version it is submitting to, and writes nothing.
create policy form_version_state_no_respondent_insert on form_version_state as restrictive for insert to fr_app
  with check ((select app_actor()) <> 'respondent');
create policy form_version_state_no_respondent_update on form_version_state as restrictive for update to fr_app
  using ((select app_actor()) <> 'respondent') with check ((select app_actor()) <> 'respondent');
-- Rows go with the version, which never goes: no delete. Only the two dates change.
grant select, insert on form_version_state to fr_app;
grant update (superseded_at, retired_at) on form_version_state to fr_app;

-- For the versions that exist: superseded when the next one was published, except the form's live version.
insert into form_version_state (version_id, org_id, form_id, superseded_at)
select v.id, v.org_id, v.form_id,
  case when v.id = f.live_version_id then null else (
    select n.published_at from form_versions n
    where n.org_id = v.org_id and n.form_id = v.form_id and n.number > v.number
    order by n.number limit 1) end
from form_versions v join forms f on f.org_id = v.org_id and f.id = v.form_id;

-- For every later version, in the statement that publishes it, so "mark the previous version superseded" is always an
-- UPDATE of a row that exists. Runs as the inserting role, so the policies above apply to it as well.
create function form_versions_state_created() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into form_version_state (version_id, org_id, form_id) values (new.id, new.org_id, new.form_id)
  on conflict (version_id) do nothing;
  return null;
end
$$;
create trigger form_versions_state_created after insert on form_versions
  for each row execute function form_versions_state_created();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. form_access
-- ---------------------------------------------------------------------------------------------------------------

-- One row per form that has been configured; a form without a row is open with the defaults. `rev` is the
-- compare-and-swap revision of PUT .../access (If-Match). The columns of ACC-07 (uniqueness), ACC-09 and the P3
-- sign-in requirement arrive with the work packages that use them.
create table form_access (
  form_id uuid primary key,
  org_id uuid not null,
  rev integer not null default 1 check (rev >= 1),
  enabled boolean not null default true,
  open_at timestamptz,
  close_at timestamptz,
  -- { timeZone, windows: [{ weekdays, from, to }] } (ACC-06); null means always.
  availability jsonb,
  submission_limit integer check (submission_limit is null or submission_limit >= 1),
  -- argon2id hash of the form password (ACC-05). fr_app can write it and cannot read it: the only reader is
  -- form_access_password_hash(), for the unlock route.
  password_hash text,
  password_updated_at timestamptz,
  -- Origins allowed to frame the form (frame-ancestors); empty means any. Stored now, enforced by WP-1.09.
  embed_allowlist text[] not null default '{}',
  -- Hosts the "after submit" redirect may go to; null means no list was set (the publish check does not apply),
  -- empty means no redirect is allowed.
  redirect_allowlist text[],
  -- Custom text of the closed / not yet open / limit reached / password screens, by screen role.
  screens jsonb not null default '{}',
  accept_previous_versions_hours integer not null default 72 check (accept_previous_versions_hours between 0 and 720),
  constraint form_access_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint form_access_window_check check (open_at is null or close_at is null or close_at > open_at)
);
alter table form_access enable row level security;
alter table form_access force row level security;
create policy form_access_tenant on form_access for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Respondent contexts read the rules (a closed form must say so) and never write them.
create policy form_access_no_respondent_insert on form_access as restrictive for insert to fr_app
  with check ((select app_actor()) <> 'respondent');
create policy form_access_no_respondent_update on form_access as restrictive for update to fr_app
  using ((select app_actor()) <> 'respondent') with check ((select app_actor()) <> 'respondent');
-- Column-level SELECT leaves out password_hash, so `select *` and a RETURNING of every column fail with "permission
-- denied": a query that names its columns cannot leak the hash into a response by accident. No delete: the row
-- lives with the form, and "no password" is password_hash = null.
grant select (form_id, org_id, rev, enabled, open_at, close_at, availability, submission_limit, password_updated_at,
  embed_allowlist, redirect_allowlist, screens, accept_previous_versions_hours) on form_access to fr_app;
grant insert on form_access to fr_app;
grant update (rev, enabled, open_at, close_at, availability, submission_limit, password_hash, password_updated_at,
  embed_allowlist, redirect_allowlist, screens, accept_previous_versions_hours) on form_access to fr_app;

-- The one reader of the hash: the unlock route, to verify a password. It answers for the context's own org only, for
-- respondent and system contexts only (a member's context has no reason to read it), and returns null for a form
-- that has no password or is not in the org, so a caller learns nothing about other orgs' forms.
create function form_access_password_hash(p_form_id uuid)
returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select a.password_hash from form_access a
  where a.form_id = p_form_id and a.org_id = app_org() and app_actor() in ('respondent', 'system')
$$;
revoke all on function form_access_password_hash(uuid) from public;
grant execute on function form_access_password_hash(uuid) to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. form_slugs
-- ---------------------------------------------------------------------------------------------------------------

-- A slug belongs to one form for good: a slug that was released could be claimed by another org, and every link to
-- the old form would then land on theirs. So no delete; "changing" a slug adds a row and moves is_primary.
create table form_slugs (
  slug text primary key,
  org_id uuid not null,
  form_id uuid not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint form_slugs_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint form_slugs_shape_check check (slug <> '' and length(slug) <= 128)
);
create unique index form_slugs_primary_key on form_slugs (form_id) where is_primary;
create index form_slugs_form_idx on form_slugs (org_id, form_id);
alter table form_slugs enable row level security;
alter table form_slugs force row level security;
create policy form_slugs_tenant on form_slugs for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy form_slugs_no_respondent_insert on form_slugs as restrictive for insert to fr_app
  with check ((select app_actor()) <> 'respondent');
create policy form_slugs_no_respondent_update on form_slugs as restrictive for update to fr_app
  using ((select app_actor()) <> 'respondent') with check ((select app_actor()) <> 'respondent');
grant select, insert on form_slugs to fr_app;
grant update (is_primary) on form_slugs to fr_app;

insert into form_slugs (slug, org_id, form_id, is_primary)
select slug, org_id, id, true from forms where slug is not null;

-- forms.slug stays the form's current address (the lists and the builder read it). Whoever sets it, the registry
-- follows in the same statement: the slug becomes the primary one (added, or promoted when it is one of the form's old
-- slugs), the previous primary stays as an old slug, and a slug that another form holds, as its current or an old
-- one, is refused with unique_violation (23505), also when that form is in another org. Code that adds the
-- form_slugs row itself, before or after setting forms.slug, must tolerate the row existing (`on conflict (slug) do
-- nothing`).
create function forms_slug_registered() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  -- First, so the one-primary-per-form index never sees two.
  update form_slugs set is_primary = false
  where org_id = new.org_id and form_id = new.id and is_primary and slug <> new.slug;
  perform 1 from form_slugs where slug = new.slug and org_id = new.org_id and form_id = new.id;
  if found then
    update form_slugs set is_primary = true where slug = new.slug and not is_primary;
  else
    -- A plain insert: the primary key refuses a slug of any other form, whichever org it is in.
    insert into form_slugs (slug, org_id, form_id, is_primary) values (new.slug, new.org_id, new.id, true);
  end if;
  return null;
end
$$;
create trigger forms_slug_registered_insert after insert on forms
  for each row when (new.slug is not null) execute function forms_slug_registered();
create trigger forms_slug_registered_update after update of slug on forms
  for each row when (new.slug is not null and new.slug is distinct from old.slug) execute function forms_slug_registered();

-- Public fill resolves a slug before any tenant is known (architecture §2.1). Through form_slugs now, so an old slug
-- finds its form too; primary_slug is the address to redirect to (the requested slug when it is the primary one). A
-- form that is archived, trashed or not published resolves to nothing, whatever slug is asked for.
drop function resolve_form_slug(text);
create function resolve_form_slug(p_slug text)
returns table (org_id uuid, form_id uuid, live_version_id uuid, primary_slug text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select f.org_id, f.id, f.live_version_id, coalesce(p.slug, s.slug)
  from form_slugs s
  join forms f on f.org_id = s.org_id and f.id = s.form_id
  left join form_slugs p on p.org_id = f.org_id and p.form_id = f.id and p.is_primary
  where s.slug = p_slug and f.lifecycle = 'active' and f.live_version_id is not null
$$;
revoke all on function resolve_form_slug(text) from public;
grant execute on function resolve_form_slug(text) to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. form_counters
-- ---------------------------------------------------------------------------------------------------------------

-- The submission limit's counter (ACC-04): the submit transaction runs `update form_counters set submitted_total =
-- submitted_total + 1 where form_id = $1 and (limit is null or submitted_total < limit) returning ...` as its last
-- statement, so the row lock is held for the commit only and N concurrent submits against a limit of N accept
-- exactly N. Every form has a row (the trigger below), so "no row updated" always means "limit reached".
create table form_counters (
  form_id uuid primary key,
  org_id uuid not null,
  submitted_total bigint not null default 0 check (submitted_total >= 0),
  constraint form_counters_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
alter table form_counters enable row level security;
alter table form_counters force row level security;
create policy form_counters_tenant on form_counters for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Rows are made with the form, never by a respondent. The counter moves in respondent contexts (the submit
-- transaction) and system jobs (a failed payment gives the place back); a member's context never edits it.
create policy form_counters_no_respondent_insert on form_counters as restrictive for insert to fr_app
  with check ((select app_actor()) <> 'respondent');
create policy form_counters_counted_by on form_counters as restrictive for update to fr_app
  using ((select app_actor()) in ('respondent', 'system')) with check ((select app_actor()) in ('respondent', 'system'));
-- A respondent may change submitted_total and nothing else of the row; no delete.
grant select, insert on form_counters to fr_app;
grant update (submitted_total) on form_counters to fr_app;

insert into form_counters (form_id, org_id, submitted_total)
select id, org_id, submission_count from forms;

create function forms_counter_created() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into form_counters (form_id, org_id) values (new.id, new.org_id) on conflict (form_id) do nothing;
  return null;
end
$$;
create trigger forms_counter_created after insert on forms
  for each row execute function forms_counter_created();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. form_favourites
-- ---------------------------------------------------------------------------------------------------------------

-- A member's stars. Personal: the restrictive policy lets a user context see and change its own rows only, so even
-- an org owner cannot read a colleague's, and no other actor kind reads any.
create table form_favourites (
  form_id uuid not null,
  user_id uuid not null references users (id),
  org_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (form_id, user_id),
  constraint form_favourites_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
create index form_favourites_user_idx on form_favourites (org_id, user_id, form_id);
alter table form_favourites enable row level security;
alter table form_favourites force row level security;
create policy form_favourites_tenant on form_favourites for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy form_favourites_own on form_favourites as restrictive for all to fr_app
  using (user_id = (select app_user()) and (select app_actor()) = 'user')
  with check (user_id = (select app_user()) and (select app_actor()) = 'user');
grant select, insert, delete on form_favourites to fr_app;

-- Account deletion (0007) reduces the user row to a tombstone and does not delete it, so the foreign key never
-- cascades: the favourites go when the user becomes `deleted`, whichever code does it.
create function users_forget_favourites() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  delete from form_favourites where user_id = new.id;
  return null;
end
$$;
create trigger users_forget_favourites after update of status on users
  for each row when (new.status = 'deleted' and old.status is distinct from 'deleted')
  execute function users_forget_favourites();
