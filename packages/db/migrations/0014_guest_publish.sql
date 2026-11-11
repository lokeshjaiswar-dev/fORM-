-- Anonymous publish looks up an existing form, or the first active org, before withTenant.
create function guest_publish_home(p_form_id uuid)
returns table (org_id uuid, owner_user_id uuid)
language sql stable security definer set search_path = pg_catalog, public as $$
  select f.org_id, f.owner_user_id from forms f where f.id = p_form_id
  union all
  select o.id, m.user_id
  from orgs o
  join memberships m on m.org_id = o.id and m.role = 'owner' and m.status = 'active'
  where o.status = 'active'
    and not exists (select 1 from forms x where x.id = p_form_id)
  order by 1
  limit 1
$$;
grant execute on function guest_publish_home(uuid) to fr_app;
