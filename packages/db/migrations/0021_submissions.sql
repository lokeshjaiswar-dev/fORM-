-- Submissions (WP-1.12: SUB-01; architecture §2.4, ADR-0004). Replaces the prototype's form_submissions.
--
-- 0. A form with responses and no version (the prototype's preview of a never-published form) gets one retired
--    legacy version, so its responses have a version to be filed under and are not refused or dropped.
-- 1. uuid_v7_ts(): the timestamp inside a UUIDv7, which is what binds a submission to its partition.
-- 2. submissions: monthly range partitions on received_at, kept in schema `parts` (no default partition), with the
--    restrictive data-access policies of 0019, the status check and the grid / unread / due / status / principal indexes.
-- 3. submission_idempotency and form_id_counters: the two satellite tables the submit transaction writes first and last.
-- 4. The rows of form_submissions move into submissions with everything they held (nothing is dropped: the answers, the
--    locale, the moment received and the prototype's display rows, which go to legacy_fields), form_files follows them
--    to the new key, the insert trigger moves over, and form_submissions goes.
--
-- A new migration: 0012 and 0019 have been applied and are never edited.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Before anything changes: every row to move must be able to name a version
-- ---------------------------------------------------------------------------------------------------------------

-- submissions.form_version_id is not null and a foreign key, because a response is only meaningful against the form
-- as the respondent saw it (definition_hash, the answers' shape). A prototype row carries no version, so step 4 files
-- it under the form's live version, or its newest one when none is live (an unpublished form).
--
-- A form can have responses and no version at all. The prototype's signed-in route POST /v1/forms/:formId/submissions
-- (from 283f4ba2 until 64ddc33c) stored a row for any form of the org, published or not, and the builder called it on
-- every preview submit; previews usually happen before a form is first published. So a database where the prototype
-- builder was used signed-in very likely holds such rows. They are real responses and the product owner's decision is
-- that prototype rows move, so the migration neither refuses nor drops them: each such form gets one LEGACY version,
-- here, and step 4 files the rows under it.
--
-- A legacy version is a stand-in, never a published form, and is marked so in four ways that later code can rely on:
--   * number 0. Real versions count from 1 and the publish route numbers the next one max(number) + 1, so the form's
--     first real publish is still version 1 and cannot collide with the legacy one; (org_id, form_id, number) stays
--     unique.
--   * label 'legacy (prototype preview)', engine 'legacy@0' (no plan was compiled), compiled '{}', draft_rev null. The
--     null draft_rev matters: publishing a draft revision that a version already froze returns that version, so a
--     legacy version holding the current revision would turn the form's first publish into a no-op.
--   * never live: forms.live_version_id stays null, so resolve_form_slug and the public page never see it.
--   * retired from birth: its form_version_state row (the trigger of 0020 makes it) is set to retired_at = now() and
--     superseded_at = 'epoch'. The old date is on purpose: submit accepts a version that is not live for
--     accept_previous_versions_hours (at most 720) after superseded_at, and a legacy version must not fall inside that
--     window on any date.
-- Its definition is the form's current draft when that has the v2 shape (the answers are keyed by that draft's block
-- ids, so the Responses page can still label them), else an empty definition (no pages, no blocks) that names only the
-- form. Either way it is a snapshot made now, not a claim of what the form looked like when the previews were made.
-- published_at is when the form was created: nothing was ever published, and this keeps the date before every response.
do $$
declare
  v_ids uuid[];
  v_forms bigint;
  v_rows bigint;
begin
  with versionless as (
    select f.org_id, f.id as form_id, f.owner_user_id, f.created_at, f.title, d.schema_version, d.draft,
      coalesce(jsonb_typeof(d.draft -> 'pages') = 'array' and jsonb_typeof(d.draft -> 'blocks') = 'object', false) as usable
    from forms f
    left join form_drafts d on d.org_id = f.org_id and d.form_id = f.id
    where exists (select 1 from form_submissions s where s.org_id = f.org_id and s.form_id = f.id)
      and not exists (select 1 from form_versions v where v.org_id = f.org_id and v.form_id = f.id)
  ), snapshot as (
    select o.*, case when o.usable then o.draft
      else jsonb_build_object('schemaVersion', 2, 'formId', o.form_id, 'title', o.title, 'pages', '[]'::jsonb, 'blocks', '{}'::jsonb) end as definition
    from versionless o
  ), inserted as (
    insert into form_versions (id, org_id, form_id, number, schema_version, published_at, published_by, definition, compiled,
      content_hash, label, engine, draft_rev)
    select gen_random_uuid(), x.org_id, x.form_id, 0, case when x.usable then x.schema_version else 2 end,
      x.created_at, x.owner_user_id, x.definition, '{}'::jsonb,
      encode(sha256(convert_to(x.definition::text, 'UTF8')), 'hex'), 'legacy (prototype preview)', 'legacy@0', null
    from snapshot x
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_ids from inserted;

  -- The trigger of 0020 made a form_version_state row for each (an AFTER trigger: the rows exist once the statement
  -- above is done); retire them. The upsert also covers a row the trigger did not make.
  insert into form_version_state (version_id, org_id, form_id, superseded_at, retired_at)
  select v.id, v.org_id, v.form_id, 'epoch'::timestamptz, now() from form_versions v where v.id = any (v_ids)
  on conflict (version_id) do update set superseded_at = excluded.superseded_at, retired_at = excluded.retired_at;

  select count(distinct s.form_id), count(*) into v_forms, v_rows
  from form_submissions s join form_versions v on v.org_id = s.org_id and v.form_id = s.form_id and v.id = any (v_ids);
  if v_forms > 0 then
    raise notice '0021: % prototype response(s) of % form(s) that were never published are filed under a legacy version (number 0)', v_rows, v_forms;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. uuid_v7_ts
-- ---------------------------------------------------------------------------------------------------------------

-- The first 48 bits of a UUIDv7 are its creation time in unix milliseconds. Immutable, so a CHECK constraint and a
-- partition-pruning predicate can use it. A uuid that is not a version 7 one (RFC 9562 variant) raises instead of
-- returning null: `received_at = null` is null, and a CHECK that evaluates to null passes, so null would let any
-- random id in. A caller that holds an id from outside (a URL) uses submissionKey() in @form/db, which never asks
-- the database about an id that is not a UUIDv7.
create function uuid_v7_ts(p_id uuid)
returns timestamptz
language plpgsql immutable strict parallel safe set search_path = pg_catalog as $$
declare
  t text := p_id::text;
begin
  if substr(t, 15, 1) <> '7' or substr(t, 20, 1) not in ('8', '9', 'a', 'b') then
    raise exception 'uuid_v7_ts: % is not a version 7 uuid', p_id using errcode = 'invalid_parameter_value';
  end if;
  return to_timestamp((('x' || substr(t, 1, 8) || substr(t, 10, 4))::bit(48)::bigint)::double precision / 1000);
end
$$;
revoke all on function uuid_v7_ts(uuid) from public;
-- A CHECK constraint runs as the inserting role, so fr_app needs it.
grant execute on function uuid_v7_ts(uuid) to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. submissions
-- ---------------------------------------------------------------------------------------------------------------

-- answers is plain jsonb for now (answer_codec_version 0); the encrypted codec (WP-1.11) writes another version
-- number, and blind indexes into principal_bidx. seq is one identity for the whole table: it orders and numbers
-- responses (gaps are fine: a rolled-back insert burns a number). delete_after is a placeholder, received_at + 10
-- years, until retention purposes exist (WP-1.22); a trigger fills it so every inserter agrees.
create table submissions (
  id uuid not null,
  received_at timestamptz not null,
  org_id uuid not null,
  form_id uuid not null,
  form_version_id uuid not null,
  definition_hash bytea not null,
  answer_codec_version smallint not null,
  seq bigint generated always as identity,
  status text not null,
  answers jsonb not null,
  computed jsonb not null,
  meta jsonb not null,
  -- Prototype data. form_submissions.fields held display rows ([{ key, label, value }]: the label and the text of each
  -- answer, as the page sent them) next to the answers. The new design builds those rows when a response is read, from
  -- the answers and the version they were validated against, and stores none (the submit route ignores what the page
  -- sends), so there is no column for them; the prototype's rows are kept here, as they were, for the responses this
  -- migration moves. Null for every response the submit route takes; a moved response has an array (empty when the
  -- prototype stored no rows), so `legacy_fields is not null` is what marks a row as prototype data. Only this migration
  -- writes it: fr_app has no INSERT or UPDATE grant on it, below.
  legacy_fields jsonb,
  principal_bidx bytea[],
  delete_after timestamptz not null,
  statutory_hold_until timestamptz,
  legal_hold boolean not null default false,
  read boolean not null default false,
  starred boolean not null default false,
  tags text[] not null default '{}',
  assignee_id uuid,
  workflow_state text,
  status_label text,
  archived_at timestamptz,
  trashed_at timestamptz,
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (id, received_at),
  -- The partition key is the id's own timestamp: a row cannot sit in a month its id does not name.
  constraint submissions_id_ts check (received_at = uuid_v7_ts(id)),
  constraint submissions_status_check check (status in (
    'complete', 'pending_payment', 'payment_failed', 'pending_scan', 'pending_guardian_consent', 'spam', 'archived', 'trashed')),
  constraint submissions_answers_object check (jsonb_typeof(answers) = 'object'),
  constraint submissions_computed_object check (jsonb_typeof(computed) = 'object'),
  constraint submissions_meta_object check (jsonb_typeof(meta) = 'object'),
  constraint submissions_legacy_fields_array check (legacy_fields is null or jsonb_typeof(legacy_fields) = 'array'),
  constraint submissions_codec_check check (answer_codec_version >= 0),
  constraint submissions_revision_check check (revision >= 1),
  -- One foreign key does both jobs: the version names its org and form (0020), so a row can never point at another
  -- form's version, and the form exists. Versions are immutable and never deleted.
  constraint submissions_version_fkey foreign key (org_id, form_id, form_version_id)
    references form_versions (org_id, form_id, id)
) partition by range (received_at);

create index submissions_grid on submissions (org_id, form_id, received_at desc) where trashed_at is null;
create index submissions_unread on submissions (org_id, form_id) where read = false and trashed_at is null;
create index submissions_due on submissions (delete_after) where legal_hold = false;
create index submissions_principal on submissions using gin (principal_bidx);
create index submissions_status on submissions (org_id, form_id, status) where status <> 'complete';

alter table submissions enable row level security;
alter table submissions force row level security;
create policy submissions_tenant on submissions for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Submission data access (SR-5, architecture §2.2, ADR-0015 point 4), as 0019 made it for form_submissions: reading
-- needs a system job, `submissions.read`, or a respondent whose verified token named the row; by default a respondent
-- can only INSERT, and changing or deleting needs a system job or the matching permission. Restrictive, so it
-- narrows `submissions_tenant` and a route that forgets its own check is still stopped.
create policy submissions_data_access on submissions as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or ((select app_actor()) = 'respondent' and id = any ((select app_subject_ids())::uuid[]))
  or 'submissions.read' = any ((select app_perms())::text[]));
create policy submissions_data_update on submissions as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'submissions.edit' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'submissions.edit' = any ((select app_perms())::text[]));
create policy submissions_data_delete on submissions as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'submissions.delete' = any ((select app_perms())::text[]));

-- Column grants keep the rest of a row out of reach of the code that writes it: the submit route names exactly these
-- columns, so a bug (or a body spread into an insert) cannot set the retention, hold, inbox, ordering or prototype
-- (legacy_fields) columns, and nothing can move a row to another form, version or month. delete_after,
-- statutory_hold_until and legal_hold are not writable yet: WP-1.22 grants them with the policy that decides who may
-- change a retention date.
grant select on submissions to fr_app;
grant insert (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers,
  computed, meta, principal_bidx) on submissions to fr_app;
grant update (answer_codec_version, status, answers, computed, meta, principal_bidx, read, starred, tags, assignee_id,
  workflow_state, status_label, archived_at, trashed_at, revision, updated_at) on submissions to fr_app;
grant delete on submissions to fr_app;

-- delete_after = received_at + 10 years, in UTC so the date does not depend on the session time zone, for any insert
-- that does not name one (fr_app has no INSERT privilege on the column, so in practice for all of them).
create function submissions_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if new.delete_after is null then
    new.delete_after := ((new.received_at at time zone 'UTC') + interval '10 years') at time zone 'UTC';
  end if;
  return new;
end
$$;
create trigger submissions_defaults before insert on submissions
  for each row execute function submissions_defaults();

-- Partitions for the months the prototype's rows were received in (the moved rows need a place), then the usual
-- current month and three ahead. Same names and bounds as create_partitions() makes, which skips what exists, so
-- partitions.maintain carries on from here. The partition table is reachable only through the parent: forced RLS and
-- no privilege for anyone but the owner (F-2).
do $$
declare
  v_start timestamp;
  v_last timestamp;
  v_name text;
begin
  select date_trunc('month', min(submitted_at) at time zone 'UTC'),
         date_trunc('month', greatest(max(submitted_at), now()) at time zone 'UTC')
  into v_start, v_last from form_submissions;
  while v_start is not null and v_start <= v_last loop
    v_name := format('submissions_%s', to_char(v_start, 'YYYY_MM'));
    if to_regclass(format('parts.%I', v_name)) is null then
      execute format('create table parts.%I partition of public.submissions for values from (%L) to (%L)',
        v_name, to_char(v_start, 'YYYY-MM-DD"T"HH24:MI:SS"+00"'), to_char(v_start + interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS"+00"'));
      execute format('alter table parts.%I enable row level security, force row level security', v_name);
      execute format('revoke all on table parts.%I from public', v_name);
    end if;
    v_start := v_start + interval '1 month';
  end loop;
end
$$;
select create_partitions('public.submissions'::regclass, 3);

-- ---------------------------------------------------------------------------------------------------------------
-- 3. submission_idempotency and form_id_counters
-- ---------------------------------------------------------------------------------------------------------------

-- The first write of a submit transaction (`insert ... on conflict do nothing returning`): a replay of the same
-- Idempotency-Key finds the row and returns the stored result before anything is stored or counted twice.
-- request_hash is a digest of the request, so a key reused with different answers is told apart from a replay.
-- response holds ids only (the submission id), never answers. No foreign key to submissions: the row is written
-- before the submission, in the same transaction, and expires on its own (24 h; a sweep deletes it). Only the submit
-- transaction (respondent) and system jobs touch it; only a system job deletes.
create table submission_idempotency (
  org_id uuid not null,
  form_id uuid not null,
  key text not null check (length(key) between 1 and 255),
  submission_id uuid not null,
  received_at timestamptz not null,
  request_hash bytea not null check (length(request_hash) = 32),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  expires_at timestamptz not null,
  primary key (org_id, form_id, key),
  constraint submission_idempotency_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
create index submission_idempotency_expires_idx on submission_idempotency (org_id, expires_at);
alter table submission_idempotency enable row level security;
alter table submission_idempotency force row level security;
create policy submission_idempotency_tenant on submission_idempotency for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy submission_idempotency_actor on submission_idempotency as restrictive for all to fr_app
  using ((select app_actor()) in ('respondent', 'system')) with check ((select app_actor()) in ('respondent', 'system'));
create policy submission_idempotency_delete on submission_idempotency as restrictive for delete to fr_app
  using ((select app_actor()) = 'system');
-- Rows are never edited: a replay reads, the sweep deletes.
grant select, insert, delete on submission_idempotency to fr_app;

-- Gap-free numbers for a "unique ID" field (one row per field and period, such as a year): the submit transaction
-- takes the next number in its last statements, so the row lock is held for the commit only and a rolled-back
-- submission gives its number back. `period` is empty for a counter that never restarts. Respondent and system
-- contexts create and advance rows (the first submission of a period creates its row); members and API keys only
-- read; nobody deletes (the rows go with the form, which never goes).
create table form_id_counters (
  form_id uuid not null,
  block_id text not null check (block_id <> '' and length(block_id) <= 64),
  period text not null default '' check (length(period) <= 32),
  org_id uuid not null,
  next_seq bigint not null default 1 check (next_seq >= 1),
  primary key (form_id, block_id, period),
  constraint form_id_counters_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
alter table form_id_counters enable row level security;
alter table form_id_counters force row level security;
create policy form_id_counters_tenant on form_id_counters for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy form_id_counters_insert_actor on form_id_counters as restrictive for insert to fr_app
  with check ((select app_actor()) in ('respondent', 'system'));
create policy form_id_counters_update_actor on form_id_counters as restrictive for update to fr_app
  using ((select app_actor()) in ('respondent', 'system')) with check ((select app_actor()) in ('respondent', 'system'));
grant select, insert on form_id_counters to fr_app;
grant update (next_seq) on form_id_counters to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Move the prototype's rows
-- ---------------------------------------------------------------------------------------------------------------

-- form_files pointed at form_submissions(id). Let go of that first; the new key is (submission_id,
-- submission_received_at) because a partitioned table's primary key includes the partition column.
alter table form_files drop constraint form_files_submission_fkey;
alter table form_files add column submission_received_at timestamptz;

-- A UUIDv7 for a moment in the past: the 48-bit millisecond clock, then the random bits of a v4 uuid with its
-- version nibble changed to 7 (the variant bits are already 10). Only this migration needs it, so it is temporary.
create function pg_temp.uuid_v7_at(p_at timestamptz) returns uuid
language plpgsql as $$
declare
  b bytea := uuid_send(gen_random_uuid());
begin
  b := overlay(b placing substring(int8send(floor(extract(epoch from p_at) * 1000)::bigint) from 3 for 6) from 1 for 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);
  return encode(b, 'hex')::uuid;
end
$$;

-- Old id -> new id and its received_at (the id's own millisecond, so the CHECK holds by construction).
create temp table submission_move (
  old_id uuid primary key,
  new_id uuid not null,
  received_at timestamptz not null
);
insert into submission_move (old_id, new_id, received_at)
select s.id, g.new_id, uuid_v7_ts(g.new_id)
from form_submissions s cross join lateral (select pg_temp.uuid_v7_at(s.submitted_at) as new_id) g;

-- seq follows the order the responses were received in. The triggers that count and link are not on submissions yet,
-- so this copy changes no counter and no file; the file links are rewritten below, from the same map.
insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version,
  status, answers, computed, meta, legacy_fields, updated_at)
select m.new_id, m.received_at, s.org_id, s.form_id, v.id,
  case when v.content_hash ~ '^[0-9a-f]{64}$' then decode(v.content_hash, 'hex') else sha256(convert_to(v.content_hash, 'UTF8')) end,
  0, 'complete', s.answers, '{}'::jsonb, jsonb_build_object('locale', s.locale),
  -- The display rows, as they were. The prototype's route only ever wrote arrays; a value that is not one (written by
  -- hand) is kept as the one element of an array, which the column's check needs, instead of being refused or dropped.
  case when jsonb_typeof(s.fields) = 'array' then s.fields else jsonb_build_array(s.fields) end,
  s.submitted_at
from form_submissions s
join submission_move m on m.old_id = s.id
cross join lateral (
  select x.id, x.content_hash from form_versions x
  where x.org_id = s.org_id and x.form_id = s.form_id
  -- The live version first, else the newest. (null sorts first under desc, which is what an unpublished form needs.)
  order by (x.id = (select f.live_version_id from forms f where f.org_id = s.org_id and f.id = s.form_id)) desc, x.number desc
  limit 1
) v
order by s.submitted_at, s.id;

update form_files f set submission_id = m.new_id, submission_received_at = m.received_at
from submission_move m where f.submission_id = m.old_id;

drop table submission_move;
drop function pg_temp.uuid_v7_at(timestamptz);

-- A file is held by a submission by both columns or by neither. Deleting the submission un-holds the file (both
-- columns go null) and the orphan sweep then removes it; there is no cascade to the bytes.
alter table form_files add constraint form_files_submission_pair_check check ((submission_id is null) = (submission_received_at is null));
alter table form_files add constraint form_files_submission_fkey
  foreign key (submission_id, submission_received_at) references submissions (id, received_at) on delete set null;
-- The ON DELETE SET NULL action finds the files of a deleted submission by this key.
create index form_files_submission_idx on form_files (submission_id, submission_received_at);

-- What a stored submission does to the rest of the org's data, in the same statement as the INSERT, whoever inserts it
-- (0019, now on submissions): the form's counters, and the hold on the files its answers name (a reference is
-- `"fileId": "<uuid>"` in the jsonb text; only unheld files of the same form are taken). Runs as the owner, which
-- bypasses RLS, so the respondent that inserts the row needs no write on `forms` or `form_files`. The function keeps
-- its name, owner and grants; only its body changes, and the trigger moves from the old table to the new one.
create or replace function form_submission_recorded() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update forms set submission_count = submission_count + 1, last_submission_at = new.received_at
  where id = new.form_id and org_id = new.org_id;
  update form_files set submission_id = new.id, submission_received_at = new.received_at
  where org_id = new.org_id and form_id = new.form_id and submission_id is null
    and id::text in (select m[1] from regexp_matches(new.answers::text, '"fileId": "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"', 'g') as m);
  return null;
end
$$;
create trigger submissions_recorded after insert on submissions
  for each row execute function form_submission_recorded();

-- Its rows, indexes, policies and trigger go with it.
drop table form_submissions;
