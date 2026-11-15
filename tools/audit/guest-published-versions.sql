-- guest-published-versions.sql
--
-- READ-ONLY. Lists the published versions (and the drafts) that may have come from the anonymous publish endpoint
-- `POST /v1/p/publish`, removed in f81adbe7 (migration 0016). While it existed, anyone who could reach the API could
-- put a live form and a draft into an org, filed under that org's owner. Nothing here changes or deletes data; what
-- to do with the rows is a decision for the org (see docs/platform/backlog.md, BL-266).
--
-- Run it as the schema owner (`fr_migrator`, which bypasses row-level security and sees every org), once per
-- deployment that ran a build between migrations 0014 and 0016:
--
--   psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f tools/audit/guest-published-versions.sql
--
-- Both statements are SELECTs. The first lists every version that has no `form.published` audit event, with the
-- evidence for and against the guest path; the second lists drafts the guest function wrote. Read the columns together:
--
--  * `no_publish_event`: the member publish route records `form.published` (resource = the version id) from the build
--    that added it. Every version published before that build has none, member-published or not, so this alone is
--    not proof of anything: it is the list to examine, and the next two columns say which rows to look at first.
--  * `in_guest_window`: published after migration 0014 was applied and before 0016 was (`fr_meta.schema_migrations`),
--    the only time `guest_publish_form()` existed on this database. A version outside the window cannot be guest-made.
--  * `same_transaction_as_form` / `same_transaction_as_draft`: `guest_publish_form()` wrote the form row, the draft
--    and the version in ONE transaction, so their `now()` timestamps are identical to the microsecond. The member
--    route creates the form in one request, saves the draft in another and publishes in a third, so theirs never are.
--    `same_transaction_as_form` is strong evidence the form was made by the guest path; `same_transaction_as_draft`
--    is strong evidence for the latest version of a form (a later edit of the draft breaks the match, so its absence
--    on an older version proves nothing).
--  * `published_by` is the org owner the function filed the form under; `published_by_email` helps ask them.
--
-- A version with `in_guest_window` and either `same_transaction_*` is almost certainly the guest path. A version
-- with `in_guest_window` alone is a candidate to ask the org about. `has_submissions` shows which forms already
-- took responses (people filled a form nobody in the org knowingly published). It reads `submissions`, the table
-- migration 0021 made from the prototype's `form_submissions`: run this on a database that has applied 0021 (a
-- database that has not can replace the table name below with `form_submissions`).

select
  o.slug as org_slug,
  v.org_id,
  v.form_id,
  f.title as form_title,
  f.lifecycle,
  v.id as version_id,
  v.number as version_number,
  v.published_at,
  v.published_by,
  u.email as published_by_email,
  (f.live_version_id = v.id) as is_live,
  f.slug as public_slug,
  true as no_publish_event,
  (w.opened_at is not null and v.published_at >= w.opened_at and v.published_at < coalesce(w.closed_at, 'infinity'::timestamptz)) as in_guest_window,
  (f.created_at = v.published_at) as same_transaction_as_form,
  exists (select 1 from form_drafts d where d.form_id = v.form_id and d.org_id = v.org_id and d.updated_at = v.published_at) as same_transaction_as_draft,
  (v.media is not null) as has_pictures,
  exists (select 1 from submissions s where s.form_id = v.form_id and s.org_id = v.org_id) as has_submissions
from form_versions v
join forms f on f.id = v.form_id and f.org_id = v.org_id
join orgs o on o.id = v.org_id
left join users u on u.id = v.published_by
cross join (
  select min(applied_at) filter (where version = 14) as opened_at, min(applied_at) filter (where version = 16) as closed_at
  from fr_meta.schema_migrations
) w
where not exists (
    select 1 from audit_log a
    where a.org_id = v.org_id and a.action = 'form.published' and a.resource_id = v.id::text
  )
  and not exists (
    select 1 from audit_pending p
    where p.org_key = v.org_id and p.event ->> 'action' = 'form.published' and p.event ->> 'resourceId' = v.id::text
  )
order by in_guest_window desc,
  (f.created_at = v.published_at) desc,
  v.published_at;

-- Drafts the guest function wrote: its draft row carries the same transaction timestamp as the version it published
-- (and `updated_by` is the org owner it chose). A draft the owner has edited since no longer matches and is not listed:
-- check the versions above for those forms.
select
  o.slug as org_slug,
  d.org_id,
  d.form_id,
  f.title as form_title,
  d.draft_rev,
  d.updated_at as draft_updated_at,
  d.updated_by,
  u.email as updated_by_email,
  v.id as version_id,
  v.number as version_number
from form_drafts d
join forms f on f.id = d.form_id and f.org_id = d.org_id
join orgs o on o.id = d.org_id
join form_versions v on v.form_id = d.form_id and v.org_id = d.org_id and v.published_at = d.updated_at
left join users u on u.id = d.updated_by
order by d.updated_at;
