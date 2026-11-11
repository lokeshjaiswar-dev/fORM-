-- One round-trip anonymous publish (high-latency hosts).
create function guest_publish_form(
  p_form_id uuid,
  p_title text,
  p_slug text,
  p_draft jsonb,
  p_definition jsonb,
  p_compiled jsonb,
  p_content_hash text,
  p_schema_version integer,
  p_size_bytes integer,
  p_version_id uuid
)
returns table (slug text, version_id uuid, number integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid;
  v_owner uuid;
  v_number integer;
  v_slug text;
begin
  select h.org_id, h.owner_user_id into v_org, v_owner from guest_publish_home(p_form_id) h;
  if v_org is null then
    raise exception 'guest_publish_form: no organisation is available' using errcode = 'P0001';
  end if;

  insert into forms (id, org_id, team_id, owner_user_id, title)
  values (p_form_id, v_org, v_org, v_owner, p_title)
  on conflict (id) do nothing;

  insert into form_drafts (form_id, org_id, draft, draft_rev, schema_version, size_bytes, updated_by, updated_at)
  values (p_form_id, v_org, p_draft, 1, p_schema_version, p_size_bytes, v_owner, now())
  on conflict (form_id) do update set
    draft = excluded.draft,
    draft_rev = form_drafts.draft_rev + 1,
    schema_version = excluded.schema_version,
    size_bytes = excluded.size_bytes,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  select coalesce(max(form_versions.number), 0) + 1 into v_number from form_versions where form_id = p_form_id;
  insert into form_versions (id, org_id, form_id, number, schema_version, published_at, published_by, definition, compiled, content_hash)
  values (p_version_id, v_org, p_form_id, v_number, p_schema_version, now(), v_owner, p_definition, p_compiled, p_content_hash);

  select forms.slug into v_slug from forms where id = p_form_id;
  v_slug := coalesce(v_slug, p_slug);
  update forms
  set live_version_id = p_version_id, slug = v_slug, title = p_title, updated_at = now(), updated_by = v_owner
  where id = p_form_id;

  return query select v_slug, p_version_id, v_number;
end;
$$;
grant execute on function guest_publish_form(uuid, text, text, jsonb, jsonb, jsonb, text, integer, integer, uuid) to fr_app;
