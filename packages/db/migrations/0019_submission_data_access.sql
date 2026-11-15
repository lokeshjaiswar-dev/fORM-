-- Submission data access (security review SR-5, architecture §2.2, ADR-0015 point 4).
--
-- 0012 and 0018 gave form_submissions and form_files only the org-wide `*_tenant` policy (`for all`, org_id =
-- app_org()). Any context of the org, whatever its permissions, could therefore read every answer and every file row:
-- a respondent transaction (the public routes, which architecture §2.2 says "cannot expose the tenant"), a member whose
-- role lacks `submissions.read`, an API key. This migration adds the restrictive policy the architecture describes
-- for submission data, and takes the one write the respondent routes made on `forms` away from them.
--
-- A new migration, because 0012 and 0018 have been applied.

-- 1. What the respondent routes need to know about a file, in two columns the upload route now fills in and the
--    submit route checks: which kind of field the file was uploaded for (a signature is a PNG a pad drew, a file is
--    anything the field accepts), and which submission came to hold it (empty until one does; the orphan sweep
--    removes files nobody holds after 24 hours). The link has no cascade to the bytes: deleting a submission
--    un-holds its files, and the sweep removes them.
alter table form_files add column purpose text not null default 'file' check (purpose in ('file', 'signature'));
alter table form_files add column submission_id uuid;
alter table form_files add constraint form_files_submission_fkey
  foreign key (submission_id) references form_submissions (id) on delete set null;
create index form_files_unattached_idx on form_files (created_at) where submission_id is null;

-- 2. Reading submissions and files needs a system job, `submissions.read`, or (submissions only) a respondent whose
--    verified token named that submission. Restrictive: it narrows `form_submissions_tenant`, it does not replace it.
--    By default a respondent can only INSERT (the `*_tenant` policy lets the INSERT through); there is no respondent
--    UPDATE or DELETE at all, and changing or deleting a submission needs a system job or the matching permission.
--    A policy cannot be skipped by a route that forgets its own check.
create policy form_submissions_data_access on form_submissions as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or ((select app_actor()) = 'respondent' and id = any ((select app_subject_ids())::uuid[]))
  or 'submissions.read' = any ((select app_perms())::text[]));
create policy form_submissions_data_update on form_submissions as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'submissions.edit' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'submissions.edit' = any ((select app_perms())::text[]));
create policy form_submissions_data_delete on form_submissions as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'submissions.delete' = any ((select app_perms())::text[]));

create policy form_files_data_access on form_files as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or 'submissions.read' = any ((select app_perms())::text[]));
create policy form_files_data_delete on form_files as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'submissions.delete' = any ((select app_perms())::text[]));

-- 3. A respondent context never writes `forms`. The submit route used to UPDATE the counters itself, which is why it
--    could; a trigger now does it (below), so the policy can say what it should.
create policy forms_no_respondent_insert on forms as restrictive for insert to fr_app
  with check ((select app_actor()) <> 'respondent');
create policy forms_no_respondent_update on forms as restrictive for update to fr_app
  using ((select app_actor()) <> 'respondent') with check ((select app_actor()) <> 'respondent');
create policy forms_no_respondent_delete on forms as restrictive for delete to fr_app
  using ((select app_actor()) <> 'respondent');

-- 4. The one thing the submit route asks about files: for the ids the answers name, in this form of this org, what
--    the upload route recorded (the field, the kind, the name and type the upload check approved, the true size and
--    hash). Nothing else about a file, no listing, nothing without ids; and it answers only inside a tenant context,
--    for that context's org, so it can neither list the files of an org nor look into another. The route rewrites each
--    file reference in the answers from these rows instead of believing the respondent's copy.
create function form_files_check(p_form_id uuid, p_ids uuid[])
returns table (id uuid, block_id text, purpose text, name text, mime text, size_bytes integer, sha256 text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select f.id, f.block_id, f.purpose, f.name, f.mime, f.size_bytes, f.sha256
  from form_files f
  where f.org_id = app_org() and f.form_id = p_form_id and f.id = any (p_ids) and cardinality(p_ids) <= 100
$$;
revoke all on function form_files_check(uuid, uuid[]) from public;
grant execute on function form_files_check(uuid, uuid[]) to fr_app;

-- 5. What a stored submission does to the rest of the org's data, in the same statement as the INSERT, whoever
--    inserts it: the form's counters, and the hold on the files its answers name (a reference is `"fileId": "<uuid>"`
--    in the jsonb text; only unheld files of the same form are taken). Runs as the owner, which bypasses RLS, so the
--    respondent that inserts the row needs no write on `forms` or `form_files`.
create function form_submission_recorded() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update forms set submission_count = submission_count + 1, last_submission_at = new.submitted_at
  where id = new.form_id and org_id = new.org_id;
  update form_files set submission_id = new.id
  where org_id = new.org_id and form_id = new.form_id and submission_id is null
    and id::text in (select m[1] from regexp_matches(new.answers::text, '"fileId": "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"', 'g') as m);
  return null;
end
$$;
revoke all on function form_submission_recorded() from public;
create trigger form_submissions_recorded after insert on form_submissions for each row execute function form_submission_recorded();
