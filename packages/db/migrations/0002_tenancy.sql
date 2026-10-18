-- Orgs, users, memberships, forms and drafts, with forced RLS from the first table (architecture §2.4).

create table orgs (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  plan text not null default 'free',
  region text not null default 'in-mum-1',
  locale text not null default 'en-IN',
  time_zone text not null default 'Asia/Kolkata',
  date_format text not null default 'DD-MM-YYYY',
  status text not null default 'active' check (status in ('active', 'suspended', 'pending_deletion', 'deleted')),
  deletion_scheduled_at timestamptz,
  created_at timestamptz not null default now()
);
alter table orgs enable row level security;
alter table orgs force row level security;
-- Sign-up goes through create_org() (P1); cross-org listing through list_user_orgs().
create policy orgs_tenant on orgs for select to fr_app using (id = (select app_org()));
create policy orgs_tenant_update on orgs for update to fr_app
  using (id = (select app_org())) with check (id = (select app_org()));
grant select on orgs to fr_app;
grant update (name, locale, time_zone, date_format) on orgs to fr_app;

-- Global identity; the platform is Fiduciary for this data (CMP-21).
create table users (
  id uuid primary key,
  email text not null,
  email_norm text not null unique,
  email_verified_at timestamptz,
  name text,
  locale text,
  password_hash text,
  totp_secret_enc jsonb,
  totp_enabled_at timestamptz,
  recovery_code_hashes text[],
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
alter table users enable row level security;
alter table users force row level security;

create table memberships (
  org_id uuid not null references orgs (id),
  user_id uuid not null references users (id),
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer', 'creator', 'data_collaborator', 'data_viewer')),
  custom_role_id uuid,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_id_idx on memberships (user_id);
alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_tenant on memberships for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, update, delete on memberships to fr_app;

-- Members of the current org and the signed-in user. Credentials are not readable by fr_app at all:
-- login and session lookups go through definer functions (P1).
create policy users_visible on users for select to fr_app using (
  id = (select app_user())
  or exists (select 1 from memberships m where m.user_id = users.id and m.org_id = (select app_org())));
create policy users_self_update on users for update to fr_app
  using (id = (select app_user())) with check (id = (select app_user()));
grant select (id, email, email_norm, email_verified_at, name, locale, status, last_login_at, created_at) on users to fr_app;
grant update (name, locale) on users to fr_app;

create table forms (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  team_id uuid not null,
  owner_user_id uuid not null,
  title text not null,
  lifecycle text not null default 'active' check (lifecycle in ('active', 'archived', 'trashed')),
  trashed_at timestamptz,
  live_version_id uuid,
  has_sensitive boolean not null default false,
  notice_approved_hash bytea,
  template_origin jsonb,
  brand_kit_id uuid,
  label_ids uuid[] not null default '{}',
  submission_count bigint not null default 0,
  last_submission_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  -- Lets children reference (org_id, id), so a row can never point at another org's form.
  constraint forms_org_id_id_key unique (org_id, id)
);
create index forms_list on forms (org_id, team_id, lifecycle, updated_at desc);
create index forms_title_trgm on forms using gin (org_id, title gin_trgm_ops);
alter table forms enable row level security;
alter table forms force row level security;
create policy forms_tenant on forms for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, update, delete on forms to fr_app;

-- 1:1 with forms (BLD-07); draft_rev is the compare-and-swap revision for PUT with If-Match.
create table form_drafts (
  form_id uuid primary key,
  org_id uuid not null,
  draft jsonb not null,
  draft_rev integer not null default 1,
  schema_version integer not null,
  base_version_id uuid,
  size_bytes integer not null check (size_bytes between 0 and 5242880),
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  constraint form_drafts_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
create index form_drafts_org_id_idx on form_drafts (org_id);
alter table form_drafts enable row level security;
alter table form_drafts force row level security;
create policy form_drafts_tenant on form_drafts for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, update, delete on form_drafts to fr_app;
