-- Extensions, schema privileges and the null-safe tenant helpers (architecture §2.1, §2.2).
-- Runs as fr_migrator, the database owner. Roles come from bootstrap (packages/db/src/bootstrap.ts).

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists btree_gin;
create extension if not exists btree_gist;

-- Functions are not executable by PUBLIC unless granted; definer functions are granted one by one.
alter default privileges revoke execute on functions from public;

revoke all on schema public from public;
grant usage on schema public to fr_app, fr_template_seeder, fr_system_agg;

-- Partitions live here. Nobody but the owner has any privilege on it: they are reachable only through
-- their RLS-protected parents in public (architecture §2.4, F-2).
create schema parts;
revoke all on schema parts from public;

-- actor_kind ∈ user | api_key | respondent | system | platform
create function app_org() returns uuid language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
create function app_user() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function app_perms() returns text[] language sql stable as $$ select coalesce(nullif(current_setting('app.perms', true), '')::text[], '{}') $$;
create function app_teams() returns uuid[] language sql stable as $$ select coalesce(nullif(current_setting('app.team_ids', true), '')::uuid[], '{}') $$;
create function app_actor() returns text language sql stable as $$ select coalesce(nullif(current_setting('app.actor_kind', true), ''), 'none') $$;
create function app_subject_ids() returns uuid[] language sql stable as $$ select coalesce(nullif(current_setting('app.subject_ids', true), '')::uuid[], '{}') $$;

grant execute on function app_org(), app_user(), app_perms(), app_teams(), app_actor(), app_subject_ids()
  to fr_app, fr_template_seeder, fr_system_agg;
