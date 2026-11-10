-- Published snapshots and a public slug for GET /f/:slug.
alter table forms add column slug text;
create unique index forms_slug_key on forms (slug) where slug is not null;

create table form_versions (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  number integer not null,
  schema_version integer not null,
  published_at timestamptz not null default now(),
  published_by uuid not null,
  definition jsonb not null,
  compiled jsonb not null,
  content_hash text not null,
  constraint form_versions_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint form_versions_form_number_key unique (org_id, form_id, number)
);
create index form_versions_form_idx on form_versions (org_id, form_id, number desc);
alter table form_versions enable row level security;
alter table form_versions force row level security;
create policy form_versions_tenant on form_versions for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, update, delete on form_versions to fr_app;

alter table forms add constraint forms_live_version_fkey foreign key (live_version_id) references form_versions (id);

-- Public fill looks up the org before withTenant (architecture §2.1).
create function resolve_form_slug(p_slug text)
returns table (org_id uuid, form_id uuid, live_version_id uuid)
language sql stable security definer set search_path = pg_catalog, public as $$
  select f.org_id, f.id, f.live_version_id
  from forms f
  where f.slug = p_slug and f.lifecycle = 'active' and f.live_version_id is not null
$$;
grant execute on function resolve_form_slug(text) to fr_app;
