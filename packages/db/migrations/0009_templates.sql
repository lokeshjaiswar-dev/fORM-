-- Template storage and RLS (WP-T1.1, TPL-04; templates spec §5.1, §5.2). System rows have org_id null and are written
-- only by fr_template_seeder; fr_app reads them inside a tenant context and writes org rows only. Versions, localizations
-- and category links inherit visibility from their parent (scope, team, personal owner, drafts for their author and
-- reviewers), so full-text search cannot leak what a list hides. Policies named <table>_tenant are the read policies.

create type template_kind as enum ('form', 'theme', 'email', 'ending', 'pdf', 'snippet', 'workflow');
create type template_scope as enum ('system', 'org', 'team', 'personal');
create type template_lifecycle as enum ('active', 'deprecated', 'archived');
create type template_version_state as enum ('draft', 'in_review', 'published', 'rejected', 'superseded');

-- Template content is for builder-side actors; respondents and connections without a tenant see none of it.
create function app_reads_templates() returns boolean language sql stable as $$
  select app_org() is not null and app_actor() in ('user', 'api_key', 'system', 'platform')
$$;
grant execute on function app_reads_templates() to fr_app;

-- Full-text configuration per localization locale; T1.4's search parses queries with the same one.
create function template_search_config(p_locale text) returns regconfig language sql immutable as $$
  select case when lower(p_locale) like 'en%' then 'pg_catalog.english'::regconfig else 'pg_catalog.simple'::regconfig end
$$;
grant execute on function template_search_config(text) to fr_app, fr_template_seeder;

create table template_packs (
  id uuid primary key,
  org_id uuid references orgs (id),
  publisher text not null check (char_length(publisher) between 1 and 100),
  name text not null check (char_length(name) between 1 and 200),
  version text not null check (char_length(version) between 1 and 50),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_hash bytea not null check (length(manifest_hash) = 32),
  signature_key_id text,
  verification text not null check (verification in ('verified', 'unsigned', 'failed')),
  imported_by uuid,
  imported_at timestamptz not null default now()
);
create unique index template_packs_uq on template_packs
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), publisher, name, version);

-- team_id gets its foreign key with the teams table (WSP-05, P2), as forms.team_id does.
create table templates (
  id uuid primary key,
  org_id uuid references orgs (id),
  team_id uuid,
  owner_user_id uuid references users (id),
  scope template_scope not null,
  kind template_kind not null,
  publisher text not null default 'org' check (char_length(publisher) between 1 and 100),
  slug text not null check (char_length(slug) between 1 and 200),
  lifecycle template_lifecycle not null default 'active',
  source text not null check (source in ('system_pack', 'pack_import', 'user', 'clone', 'fork', 'jotform_import', 'ai')),
  pack_id uuid references template_packs (id),
  forked_from_version_id uuid,
  current_version_id uuid,
  default_locale text not null default 'en-IN' check (default_locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  industries text[] not null default '{}',
  tags text[] not null default '{}',
  layout text check (layout in ('classic', 'cards')),
  featured boolean not null default false,
  sort_weight integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint templates_scope_shape check (
    (scope = 'system' and org_id is null and team_id is null and owner_user_id is null) or
    (scope = 'org' and org_id is not null and team_id is null) or
    (scope = 'team' and org_id is not null and team_id is not null) or
    (scope = 'personal' and org_id is not null and owner_user_id is not null)),
  -- Lets fork bindings reference (org_id, id), so a binding can never name another org's fork.
  constraint templates_org_id_id_key unique (org_id, id)
);
create unique index templates_slug_uq on templates
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), publisher, slug) where deleted_at is null;
create index templates_gallery on templates
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, lifecycle, featured desc, sort_weight desc) where deleted_at is null;
create index templates_industries on templates using gin (industries);
create index templates_tags on templates using gin (tags);

create table template_versions (
  id uuid primary key,
  template_id uuid not null references templates (id),
  org_id uuid,
  version integer not null check (version >= 1),
  state template_version_state not null default 'draft',
  schema_version integer not null check (schema_version >= 1),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash bytea not null check (length(payload_hash) = 32),
  lock_fingerprints jsonb not null default '{}' check (jsonb_typeof(lock_fingerprints) = 'object'),
  required_features text[] not null default '{}',
  locales text[] not null default '{en-IN}',
  change_level text check (change_level in ('patch', 'minor', 'major')),
  changelog text check (char_length(changelog) <= 5000),
  mandatory boolean not null default false,
  mandatory_deadline timestamptz,
  thumbnail_asset_id uuid,
  preview_assets jsonb not null default '{}',
  stats_fields integer,
  stats_pages integer,
  est_minutes integer,
  has_sensitive boolean,
  created_by uuid,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_comment text check (char_length(review_comment) <= 5000),
  published_at timestamptz,
  pack_signature jsonb,
  constraint template_versions_template_version_key unique (template_id, version),
  -- Lets templates and bindings reference (id, template_id): a version of one template cannot stand in for another's.
  constraint template_versions_id_template_key unique (id, template_id)
);
create unique index template_versions_one_draft on template_versions (template_id) where state = 'draft';
create unique index template_versions_one_published on template_versions (template_id) where state = 'published';
create index template_versions_org_id_idx on template_versions (org_id, template_id);

-- The cycles templates <-> template_versions are deferred, so a template and its first version go in one transaction.
alter table templates add constraint templates_current_fk foreign key (current_version_id, id)
  references template_versions (id, template_id) deferrable initially deferred;
alter table templates add constraint templates_forked_fk foreign key (forked_from_version_id)
  references template_versions (id) deferrable initially deferred;

create table template_localizations (
  template_version_id uuid not null references template_versions (id),
  org_id uuid,
  locale text not null check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  title text not null check (char_length(title) between 1 and 200),
  summary text not null check (char_length(summary) <= 1000),
  description jsonb,
  field_labels text not null default '',
  search tsvector not null default ''::tsvector,
  completeness numeric(5,2) not null default 100 check (completeness between 0 and 100),
  primary key (template_version_id, locale)
);
create index template_localizations_search on template_localizations using gin (search);
create index template_localizations_title_trgm on template_localizations using gin (title gin_trgm_ops);

create table template_categories (
  id uuid primary key,
  org_id uuid references orgs (id),
  facet text not null check (facet in ('use_case', 'industry', 'compliance')),
  parent_id uuid references template_categories (id),
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9_-]{0,98}[a-z0-9])?$'),
  names jsonb not null check (jsonb_typeof(names) = 'object'),
  icon text,
  kinds template_kind[] not null default '{form}',
  sort integer not null default 0
);
create unique index template_categories_uq on template_categories
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), facet, slug);

create table template_category_links (
  template_id uuid not null references templates (id),
  category_id uuid not null references template_categories (id),
  org_id uuid,
  primary key (template_id, category_id)
);
create index template_category_links_category on template_category_links (category_id);

create table brand_kits (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  team_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  is_default boolean not null default false,
  tokens jsonb not null check (jsonb_typeof(tokens) = 'object'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint brand_kits_org_id_id_key unique (org_id, id)
);
create unique index brand_kits_one_default on brand_kits
  (org_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_default and deleted_at is null;

-- forms.brand_kit_id and forms.template_origin exist since 0002; the kit must be one of the form's own org.
alter table forms add constraint forms_brand_kit_fkey foreign key (org_id, brand_kit_id) references brand_kits (org_id, id);

create table form_template_bindings (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  template_id uuid not null references templates (id),
  template_version_id uuid not null,
  kind template_kind not null,
  instance_root_id text,
  id_map jsonb not null check (jsonb_typeof(id_map) = 'object'),
  key_map jsonb check (jsonb_typeof(key_map) = 'object'),
  update_state text not null default 'current' check (update_state ~ '^(current|available|required|dismissed@[1-9][0-9]{0,8})$'),
  governance text not null default 'bound' check (governance in ('bound', 'detached')),
  applied_by uuid,
  applied_at timestamptz not null default now(),
  constraint form_template_bindings_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint form_template_bindings_version_fkey foreign key (template_version_id, template_id) references template_versions (id, template_id)
);
create index form_template_bindings_template on form_template_bindings (org_id, template_id, template_version_id);
create index form_template_bindings_form on form_template_bindings (org_id, form_id);

create table template_fork_bindings (
  id uuid primary key,
  org_id uuid not null,
  template_id uuid not null,
  upstream_template_id uuid not null references templates (id),
  upstream_version_id uuid not null,
  id_map jsonb not null check (jsonb_typeof(id_map) = 'object'),
  update_state text not null default 'current' check (update_state ~ '^(current|available|required|dismissed@[1-9][0-9]{0,8})$'),
  constraint template_fork_bindings_template_fkey foreign key (org_id, template_id) references templates (org_id, id),
  constraint template_fork_bindings_upstream_fkey foreign key (upstream_version_id, upstream_template_id) references template_versions (id, template_id)
);
create index template_fork_bindings_org on template_fork_bindings (org_id, template_id);
create index template_fork_bindings_upstream on template_fork_bindings (upstream_template_id, upstream_version_id);

-- Append-only event log (templates spec §9) with a 400-day TTL: rows past it may be deleted (retention.sweep), never
-- updated; fr_app has no DELETE.
create table template_usages (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  user_id uuid,
  template_id uuid not null,
  template_version_id uuid not null,
  action text not null check (action in ('preview', 'use', 'insert', 'apply_theme', 'publish_from', 'update_applied', 'update_dismissed', 'detach', 'fork', 'export')),
  form_id uuid,
  locale text,
  occurred_at timestamptz not null default now()
);
create index template_usages_occurred_at on template_usages using brin (occurred_at);
create index template_usages_org on template_usages (org_id, template_id, occurred_at);

-- Written by templates.stats as fr_system_agg; org_id null is the cross-tenant aggregate of a system template.
create table template_stats_daily (
  id bigint generated always as identity primary key,
  template_id uuid not null,
  day date not null,
  org_id uuid,
  previews integer,
  uses integer,
  publishes integer,
  submissions integer,
  updates_applied integer,
  distinct_orgs integer
);
create unique index template_stats_daily_uq on template_stats_daily
  (template_id, day, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Trust store (WP-T1.2 seeds the release key): org_id null for platform keys, an org's own keys otherwise. Key ids are
-- unique per owner, not globally, so a tenant can neither squat a key id another owner needs nor learn that it exists.
-- Platform key ids are in the reserved fORM- namespace and org key ids never are: a key id names at most one key among
-- those a tenant sees (the platform's and its own), and no org key can shadow a release key.
create table template_signing_keys (
  id uuid primary key,
  key_id text not null check (char_length(key_id) between 1 and 100),
  org_id uuid references orgs (id),
  public_key bytea not null,
  alg text not null check (alg in ('ed25519', 'es256')),
  label text,
  added_by uuid,
  revoked_at timestamptz,
  constraint template_signing_keys_namespace check ((org_id is null) = (key_id ~* '^form-'))
);
create unique index template_signing_keys_uq on template_signing_keys
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), key_id);

create table template_search_synonyms (
  org_id uuid,
  term text not null check (char_length(term) between 1 and 100),
  expands_to text[] not null
);
create unique index template_search_synonyms_uq on template_search_synonyms
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), term);

-- 90-day TTL, with retention.sweep.
create table template_search_misses (
  org_id uuid not null,
  q_norm text not null check (char_length(q_norm) between 1 and 200),
  locale text not null,
  count integer not null default 1 check (count >= 1),
  last_at timestamptz not null default now(),
  primary key (org_id, q_norm, locale)
);

-- Children carry the org of their parent, and rows may reference only system rows or rows of their own org. Runs as
-- the owner, so it sees the true parent whatever the caller may read: a child of another org's parent gets that
-- org's id and fails the caller's WITH CHECK, and the seeder can never attach a system row to an org's template.
create function template_rows_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid;
  v_found boolean;
begin
  case tg_table_name
    when 'templates' then
      if new.pack_id is not null and (tg_op = 'INSERT' or new.pack_id is distinct from old.pack_id) then
        select p.org_id into v_org from template_packs p where p.id = new.pack_id;
        if found and v_org is distinct from new.org_id then
          raise exception 'templates: the pack belongs to another org' using errcode = 'foreign_key_violation';
        end if;
      end if;
      if new.forked_from_version_id is not null and (tg_op = 'INSERT' or new.forked_from_version_id is distinct from old.forked_from_version_id) then
        select v.org_id into v_org from template_versions v where v.id = new.forked_from_version_id;
        if found and v_org is not null and v_org is distinct from new.org_id then
          raise exception 'templates: the forked version belongs to another org' using errcode = 'foreign_key_violation';
        end if;
      end if;
    when 'template_versions' then
      select t.org_id into new.org_id from templates t where t.id = new.template_id;
    when 'template_localizations' then
      select v.org_id into new.org_id from template_versions v where v.id = new.template_version_id;
    when 'template_category_links' then
      select t.org_id into new.org_id from templates t where t.id = new.template_id;
      select c.org_id, true into v_org, v_found from template_categories c where c.id = new.category_id;
      if v_found and v_org is not null and v_org is distinct from new.org_id then
        raise exception 'template_category_links: the category belongs to another org' using errcode = 'foreign_key_violation';
      end if;
    when 'template_categories' then
      if new.parent_id is not null then
        select c.org_id, true into v_org, v_found from template_categories c where c.id = new.parent_id;
        if v_found and v_org is not null and v_org is distinct from new.org_id then
          raise exception 'template_categories: the parent belongs to another org' using errcode = 'foreign_key_violation';
        end if;
      end if;
    when 'form_template_bindings' then
      if tg_op = 'INSERT' or new.template_id is distinct from old.template_id then
        select t.org_id, true into v_org, v_found from templates t where t.id = new.template_id;
        if v_found and v_org is not null and v_org is distinct from new.org_id then
          raise exception 'form_template_bindings: the template belongs to another org' using errcode = 'foreign_key_violation';
        end if;
      end if;
    when 'template_fork_bindings' then
      if tg_op = 'INSERT' or new.upstream_template_id is distinct from old.upstream_template_id then
        select t.org_id, true into v_org, v_found from templates t where t.id = new.upstream_template_id;
        if v_found and v_org is not null and v_org is distinct from new.org_id then
          raise exception 'template_fork_bindings: the upstream template belongs to another org' using errcode = 'foreign_key_violation';
        end if;
      end if;
    when 'template_usages' then
      select t.org_id into v_org from templates t where t.id = new.template_id;
      if not found or (v_org is not null and v_org is distinct from new.org_id) then
        raise exception 'template_usages: the template belongs to another org' using errcode = 'foreign_key_violation';
      end if;
      perform from template_versions v where v.id = new.template_version_id and v.template_id = new.template_id;
      if not found then
        raise exception 'template_usages: the version is not one of the template' using errcode = 'foreign_key_violation';
      end if;
    else
      raise exception 'template_rows_guard: unexpected table %', tg_table_name;
  end case;
  return new;
end
$$;
create trigger templates_guard before insert or update on templates for each row execute function template_rows_guard();
create trigger template_versions_guard before insert or update on template_versions for each row execute function template_rows_guard();
create trigger template_localizations_guard before insert or update on template_localizations for each row execute function template_rows_guard();
create trigger template_categories_guard before insert or update on template_categories for each row execute function template_rows_guard();
create trigger template_category_links_guard before insert or update on template_category_links for each row execute function template_rows_guard();
create trigger form_template_bindings_guard before insert or update on form_template_bindings for each row execute function template_rows_guard();
create trigger template_fork_bindings_guard before insert or update on template_fork_bindings for each row execute function template_rows_guard();
create trigger template_usages_guard before insert on template_usages for each row execute function template_rows_guard();

-- A template, binding or fork binding of fr_app may name only a version the caller can read: org RLS and the owner-run
-- guard alone would let a member bind or fork a system draft, a peer's personal template or another team's, and read
-- its payload back through template_for_binding(). Runs as the caller, so the lookup is under the caller's RLS (a
-- policy cannot do it: templates <-> template_versions would recurse). An invisible version answers as a missing one
-- (23503), as another org's does, so the error tells nothing about what exists. Fires after the guard (name order).
create function template_refs_visible() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_ref uuid;
begin
  if current_user <> 'fr_app' or new.org_id is distinct from app_org() then
    return new;
  end if;
  case tg_table_name
    when 'templates' then
      if tg_op = 'UPDATE' and new.forked_from_version_id is not distinct from old.forked_from_version_id then
        return new;
      end if;
      v_ref := new.forked_from_version_id;
    when 'form_template_bindings' then
      if tg_op = 'UPDATE' and new.template_version_id is not distinct from old.template_version_id then
        return new;
      end if;
      v_ref := new.template_version_id;
    when 'template_fork_bindings' then
      if tg_op = 'UPDATE' and new.upstream_version_id is not distinct from old.upstream_version_id then
        return new;
      end if;
      v_ref := new.upstream_version_id;
    else
      raise exception 'template_refs_visible: unexpected table %', tg_table_name;
  end case;
  if v_ref is not null and not exists (select 1 from template_versions v where v.id = v_ref) then
    raise exception '%: the template version does not exist', tg_table_name using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;
create trigger templates_refs before insert or update on templates for each row execute function template_refs_visible();
create trigger form_template_bindings_refs before insert or update on form_template_bindings for each row execute function template_refs_visible();
create trigger template_fork_bindings_refs before insert or update on template_fork_bindings for each row execute function template_refs_visible();

-- Published, superseded and rejected versions never change their content, for any role (templates spec §2.2). States
-- move draft -> in_review | published, in_review -> published | rejected, published -> superseded; only drafts are deleted.
-- Past draft, the state and the mandatory flag (which forces updates on bound forms) change in fr_app only for a
-- reviewer (templates.approve), templates.govern or a job.
create function template_versions_immutable() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'draft' then
      raise exception 'template_versions: only a draft can be deleted' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if new.template_id is distinct from old.template_id or new.version is distinct from old.version then
    raise exception 'template_versions: a version keeps its template and number' using errcode = 'insufficient_privilege';
  end if;
  if old.state = 'draft' then
    if new.state not in ('draft', 'in_review', 'published') then
      raise exception 'template_versions: a draft goes to in_review or published, not %', new.state using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.payload is distinct from old.payload or new.payload_hash is distinct from old.payload_hash
    or new.lock_fingerprints is distinct from old.lock_fingerprints or new.schema_version is distinct from old.schema_version
    or new.required_features is distinct from old.required_features then
    raise exception 'template_versions: a % version is immutable', old.state using errcode = 'insufficient_privilege';
  end if;
  if new.state is distinct from old.state and not (
    (old.state = 'in_review' and new.state in ('published', 'rejected')) or (old.state = 'published' and new.state = 'superseded')) then
    raise exception 'template_versions: % cannot become %', old.state, new.state using errcode = 'check_violation';
  end if;
  if current_user = 'fr_app' and (new.state is distinct from old.state or new.mandatory is distinct from old.mandatory
    or new.mandatory_deadline is distinct from old.mandatory_deadline)
    and not coalesce(app_actor() = 'system' or 'templates.approve' = any (app_perms()) or 'templates.govern' = any (app_perms()), false) then
    raise exception 'template_versions: changing the state or mandatory flag of a % version needs templates.approve', old.state
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger template_versions_immutable before update or delete on template_versions
  for each row execute function template_versions_immutable();

-- setweight A/B/C over the unaccented title, summary and field labels, in the locale's configuration.
create function template_localizations_search() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_cfg regconfig := template_search_config(new.locale);
begin
  new.search := setweight(to_tsvector(v_cfg, unaccent(new.title)), 'A')
    || setweight(to_tsvector(v_cfg, unaccent(new.summary)), 'B')
    || setweight(to_tsvector(v_cfg, unaccent(new.field_labels)), 'C');
  return new;
end
$$;
create trigger template_localizations_search before insert or update on template_localizations
  for each row execute function template_localizations_search();

-- RLS. The visibility of a template (templates_tenant) is repeated in the update policy, because an UPDATE's new row
-- must also pass the read policy: soft deletion therefore goes through template_delete().
alter table template_packs enable row level security;
alter table template_packs force row level security;
create policy template_packs_tenant on template_packs for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy template_packs_seed on template_packs for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table templates enable row level security;
alter table templates force row level security;
create policy templates_tenant on templates for select to fr_app using (
  deleted_at is null and (select app_reads_templates()) and (
    org_id is null
    or (org_id = (select app_org()) and (
         scope = 'org'
      or (scope = 'team' and team_id = any ((select app_teams())::uuid[]))
      or (scope = 'personal' and owner_user_id = (select app_user()))
      or 'templates.govern' = any ((select app_perms())::text[])))));
-- A member creates and moves templates only into scopes they can see: their own personal templates, their teams.
create policy templates_insert on templates for insert to fr_app with check (
  org_id = (select app_org()) and (select app_reads_templates())
  and (scope <> 'personal' or owner_user_id = (select app_user()) or 'templates.govern' = any ((select app_perms())::text[]))
  and (scope <> 'team' or team_id = any ((select app_teams())::uuid[]) or 'templates.govern' = any ((select app_perms())::text[])));
create policy templates_update on templates for update to fr_app using (
  org_id = (select app_org()) and deleted_at is null and (select app_reads_templates()) and (
       scope = 'org'
    or (scope = 'team' and team_id = any ((select app_teams())::uuid[]))
    or (scope = 'personal' and owner_user_id = (select app_user()))
    or 'templates.govern' = any ((select app_perms())::text[])))
  with check (
    org_id = (select app_org())
    and (scope <> 'personal' or owner_user_id = (select app_user()) or 'templates.govern' = any ((select app_perms())::text[]))
    and (scope <> 'team' or team_id = any ((select app_teams())::uuid[]) or 'templates.govern' = any ((select app_perms())::text[])));
create policy templates_seed on templates for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table template_versions enable row level security;
alter table template_versions force row level security;
-- Drafts, reviews and rejections are visible to their author and to reviewers, of org rows only. The update and delete
-- policies repeat that rule: Postgres applies the read policy only when a statement reads columns.
create policy template_versions_tenant on template_versions for select to fr_app using (
  (org_id is null or org_id = (select app_org()))
  and exists (select 1 from templates t where t.id = template_id)
  and (state in ('published', 'superseded')
       or (org_id = (select app_org()) and (
            created_by = (select app_user())
         or 'templates.approve' = any ((select app_perms())::text[])))));
create policy template_versions_insert on template_versions for insert to fr_app with check (
  org_id = (select app_org()) and exists (select 1 from templates t where t.id = template_id));
create policy template_versions_update on template_versions for update to fr_app using (
  org_id = (select app_org()) and exists (select 1 from templates t where t.id = template_id)
  and (state in ('published', 'superseded') or created_by = (select app_user()) or 'templates.approve' = any ((select app_perms())::text[])))
  with check (org_id = (select app_org()));
create policy template_versions_delete on template_versions for delete to fr_app using (
  org_id = (select app_org()) and exists (select 1 from templates t where t.id = template_id)
  and (state in ('published', 'superseded') or created_by = (select app_user()) or 'templates.approve' = any ((select app_perms())::text[])));
create policy template_versions_seed on template_versions for all to fr_template_seeder using (org_id is null) with check (org_id is null);

-- Localizations and category links inherit visibility from their parent (closes the FTS leak). Writes are split by
-- command: a FOR ALL write policy would also widen SELECT.
alter table template_localizations enable row level security;
alter table template_localizations force row level security;
create policy template_localizations_tenant on template_localizations for select to fr_app using (
  exists (select 1 from template_versions v where v.id = template_version_id));
create policy template_localizations_insert on template_localizations for insert to fr_app with check (
  org_id = (select app_org()) and exists (select 1 from template_versions v where v.id = template_version_id));
create policy template_localizations_update on template_localizations for update to fr_app using (
  org_id = (select app_org()) and exists (select 1 from template_versions v where v.id = template_version_id))
  with check (org_id = (select app_org()));
create policy template_localizations_delete on template_localizations for delete to fr_app using (
  org_id = (select app_org()) and exists (select 1 from template_versions v where v.id = template_version_id));
create policy template_localizations_seed on template_localizations for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table template_categories enable row level security;
alter table template_categories force row level security;
create policy template_categories_tenant on template_categories for select to fr_app using (
  (select app_reads_templates()) and (org_id is null or org_id = (select app_org())));
create policy template_categories_insert on template_categories for insert to fr_app
  with check (org_id = (select app_org()) and (select app_reads_templates()));
create policy template_categories_update on template_categories for update to fr_app
  using (org_id = (select app_org()) and (select app_reads_templates())) with check (org_id = (select app_org()));
create policy template_categories_delete on template_categories for delete to fr_app
  using (org_id = (select app_org()) and (select app_reads_templates()));
create policy template_categories_seed on template_categories for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table template_category_links enable row level security;
alter table template_category_links force row level security;
create policy template_category_links_tenant on template_category_links for select to fr_app using (
  exists (select 1 from templates t where t.id = template_id));
create policy template_category_links_insert on template_category_links for insert to fr_app with check (
  org_id = (select app_org()) and exists (select 1 from templates t where t.id = template_id));
create policy template_category_links_delete on template_category_links for delete to fr_app using (
  org_id = (select app_org()) and exists (select 1 from templates t where t.id = template_id));
create policy template_category_links_seed on template_category_links for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table brand_kits enable row level security;
alter table brand_kits force row level security;
create policy brand_kits_tenant on brand_kits for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));

alter table form_template_bindings enable row level security;
alter table form_template_bindings force row level security;
create policy form_template_bindings_tenant on form_template_bindings for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));

alter table template_fork_bindings enable row level security;
alter table template_fork_bindings force row level security;
create policy template_fork_bindings_tenant on template_fork_bindings for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));

alter table template_usages enable row level security;
alter table template_usages force row level security;
create policy template_usages_tenant on template_usages for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create function template_usages_append_only() returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' and old.occurred_at < now() - interval '400 days' then
    return old;
  end if;
  raise exception 'template_usages is append-only until its 400-day TTL' using errcode = 'insufficient_privilege';
end
$$;
create trigger template_usages_append_only before update or delete on template_usages
  for each row execute function template_usages_append_only();

-- A system template's cross-tenant figures only once at least 5 distinct orgs used it (templates spec §9).
alter table template_stats_daily enable row level security;
alter table template_stats_daily force row level security;
create policy template_stats_daily_tenant on template_stats_daily for select to fr_app using (
  (select app_reads_templates()) and (
    org_id = (select app_org())
    or (org_id is null and distinct_orgs >= 5 and exists (select 1 from templates t where t.id = template_id and t.org_id is null))));

alter table template_signing_keys enable row level security;
alter table template_signing_keys force row level security;
create policy template_signing_keys_tenant on template_signing_keys for select to fr_app using (
  (select app_reads_templates()) and (org_id is null or org_id = (select app_org())));
create policy template_signing_keys_insert on template_signing_keys for insert to fr_app
  with check (org_id = (select app_org()) and (select app_reads_templates()));
create policy template_signing_keys_update on template_signing_keys for update to fr_app
  using (org_id = (select app_org()) and (select app_reads_templates())) with check (org_id = (select app_org()));
create policy template_signing_keys_seed on template_signing_keys for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table template_search_synonyms enable row level security;
alter table template_search_synonyms force row level security;
create policy template_search_synonyms_tenant on template_search_synonyms for select to fr_app using (
  (select app_reads_templates()) and (org_id is null or org_id = (select app_org())));
create policy template_search_synonyms_insert on template_search_synonyms for insert to fr_app
  with check (org_id = (select app_org()) and (select app_reads_templates()));
create policy template_search_synonyms_update on template_search_synonyms for update to fr_app
  using (org_id = (select app_org()) and (select app_reads_templates())) with check (org_id = (select app_org()));
create policy template_search_synonyms_delete on template_search_synonyms for delete to fr_app
  using (org_id = (select app_org()) and (select app_reads_templates()));
create policy template_search_synonyms_seed on template_search_synonyms for all to fr_template_seeder using (org_id is null) with check (org_id is null);

alter table template_search_misses enable row level security;
alter table template_search_misses force row level security;
create policy template_search_misses_tenant on template_search_misses for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));

-- fr_app: DML on org rows. No DELETE on templates (soft deletion through template_delete()), template_usages is
-- append-only, template_stats_daily is read-only.
grant select on template_packs to fr_app;
grant insert (id, org_id, publisher, name, version, manifest, manifest_hash, signature_key_id, verification, imported_by)
  on template_packs to fr_app;
grant select on templates to fr_app;
grant insert (id, org_id, team_id, owner_user_id, scope, kind, publisher, slug, lifecycle, source, pack_id, forked_from_version_id,
  current_version_id, default_locale, industries, tags, layout, featured, sort_weight, created_by) on templates to fr_app;
grant update (team_id, owner_user_id, scope, slug, lifecycle, current_version_id, default_locale, industries, tags, layout, featured,
  sort_weight, updated_at) on templates to fr_app;
grant select, delete on template_versions to fr_app;
grant insert (id, template_id, version, state, schema_version, payload, payload_hash, lock_fingerprints, required_features, locales,
  change_level, changelog, mandatory, mandatory_deadline, thumbnail_asset_id, preview_assets, stats_fields, stats_pages, est_minutes,
  has_sensitive, created_by, submitted_at, reviewed_by, reviewed_at, review_comment, published_at, pack_signature) on template_versions to fr_app;
grant update (state, schema_version, payload, payload_hash, lock_fingerprints, required_features, locales, change_level, changelog,
  mandatory, mandatory_deadline, thumbnail_asset_id, preview_assets, stats_fields, stats_pages, est_minutes, has_sensitive, submitted_at,
  reviewed_by, reviewed_at, review_comment, published_at) on template_versions to fr_app;
grant select, delete on template_localizations to fr_app;
grant insert (template_version_id, locale, title, summary, description, field_labels, completeness) on template_localizations to fr_app;
grant update (title, summary, description, field_labels, completeness) on template_localizations to fr_app;
grant select, insert, update, delete on template_categories to fr_app;
grant select, insert, delete on template_category_links to fr_app;
grant select, insert, update on brand_kits to fr_app;
grant select, insert, delete on form_template_bindings to fr_app;
grant update (template_version_id, id_map, key_map, update_state, governance, applied_by, applied_at) on form_template_bindings to fr_app;
grant select, insert, delete on template_fork_bindings to fr_app;
grant update (upstream_version_id, id_map, update_state) on template_fork_bindings to fr_app;
grant select, insert on template_usages to fr_app;
grant select on template_stats_daily to fr_app;
grant select, insert on template_signing_keys to fr_app;
grant update (label, revoked_at) on template_signing_keys to fr_app;
grant select, insert, update, delete on template_search_synonyms to fr_app;
grant select, insert, update, delete on template_search_misses to fr_app;

-- fr_template_seeder: system rows of the template tables only (the policies above), never a delete of a version.
grant select, insert, update on template_packs, templates, template_versions, template_categories, template_signing_keys to fr_template_seeder;
grant select, insert, update, delete on template_localizations, template_search_synonyms to fr_template_seeder;
grant select, insert, delete on template_category_links to fr_template_seeder;

-- fr_system_agg (BYPASSRLS): reads the rollup sources, writes the rollup (templates.stats, WP-T1.7). No payloads.
grant select (id, org_id, scope, kind) on templates to fr_system_agg;
grant select on template_usages, form_template_bindings to fr_system_agg;
grant select, insert, update on template_stats_daily to fr_system_agg;

-- Diffs and lineage read a bound version even after its template was soft-deleted (templates spec §5.2). Only for a
-- binding of the current org, for builder-side actors, and a draft or review only for its author and reviewers of the
-- org (the rule of template_versions_tenant), should a binding name one.
create function template_for_binding(p_binding_id uuid)
returns table (binding_id uuid, form_id uuid, template_id uuid, template_version_id uuid, template_org_id uuid, scope template_scope,
  kind template_kind, slug text, version integer, state template_version_state, schema_version integer, payload jsonb, payload_hash bytea,
  lock_fingerprints jsonb, template_deleted_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public as $$
  select b.id, b.form_id, t.id, v.id, t.org_id, t.scope, t.kind, t.slug, v.version, v.state, v.schema_version, v.payload, v.payload_hash,
    v.lock_fingerprints, t.deleted_at
  from form_template_bindings b
  join template_versions v on v.id = b.template_version_id and v.template_id = b.template_id
  join templates t on t.id = b.template_id
  where b.id = p_binding_id and b.org_id = app_org() and app_reads_templates() and (t.org_id is null or t.org_id = b.org_id)
    and (v.state in ('published', 'superseded')
         or (v.org_id = b.org_id and (v.created_by = app_user() or 'templates.approve' = any (app_perms()))))
$$;

-- Soft deletion of a template the caller can see (templates_tenant). Returns false when there is none (or it is gone).
create function template_delete(p_template_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
begin
  if not app_reads_templates() then
    raise exception 'template_delete: needs a builder-side actor in an org' using errcode = 'insufficient_privilege';
  end if;
  update templates t set deleted_at = now(), updated_at = now()
  where t.id = p_template_id and t.org_id = app_org() and t.deleted_at is null and (
       t.scope = 'org'
    or (t.scope = 'team' and t.team_id = any (app_teams()))
    or (t.scope = 'personal' and t.owner_user_id = app_user())
    or 'templates.govern' = any (app_perms()));
  return found;
end
$$;

grant execute on function template_for_binding(uuid), template_delete(uuid) to fr_app;
