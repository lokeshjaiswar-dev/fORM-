-- Section-level maker-checker review: the tables (WP-2.33: WFL-09; architecture §2.4, ADR-0004). Storage only: the
-- functions that open and decide a review (review_open(), review_decide()) are migration 0024, and every write to the
-- two review tables goes through them.
--
-- 1. submissions.status: two new values, 'pending_review' (held until every required unit is approved) and 'rejected'
--    (a required unit was rejected, final).
-- 2. org_settings.review_checkers_mfa: "checkers must use 2FA", on by default.
-- 3. review_groups and review_group_members: who may check. Managed with members.manage.
-- 4. form_review_settings: which units of a form are reviewed, by which group, in which order (FormOps-like, revisioned).
-- 5. submission_reviews (current state per unit per submission) and review_decisions (append-only log), both
--    partitioned by month on the submission's received_at, so a submission's review rows sit beside it and go with it.
--
-- A new migration: 0021 has been applied and is never edited.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. submissions.status
-- ---------------------------------------------------------------------------------------------------------------

-- The check of 0021 lists the status values, so two more need a new check; there is no way to widen it in place. The
-- list only grows, so every row that exists already passes. On a partitioned table the new check is applied to every
-- partition, and the partitions to come inherit it.
alter table submissions
  drop constraint submissions_status_check,
  add constraint submissions_status_check check (status in (
    'complete', 'pending_payment', 'payment_failed', 'pending_scan', 'pending_guardian_consent', 'spam', 'archived', 'trashed',
    'pending_review', 'rejected'));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. org_settings.review_checkers_mfa
-- ---------------------------------------------------------------------------------------------------------------

-- When on, review_decide() refuses a checker who has not enrolled two-factor sign-in (users.totp_enabled_at). Default
-- on: segregation of duties is only worth something if the checker's account is hard to borrow. Changing it needs
-- org.settings, as for the other settings (policies of 0008). The column grants are widened to match: Drizzle's own
-- INSERT names every column of the table, so INSERT on the new column is needed even for a row that leaves it at its default.
alter table org_settings add column review_checkers_mfa boolean not null default true;
grant insert (review_checkers_mfa) on org_settings to fr_app;
grant update (review_checkers_mfa) on org_settings to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. review_groups and review_group_members
-- ---------------------------------------------------------------------------------------------------------------

-- A group is a named set of checkers that units are assigned to. Groups are archived, never deleted: a review row and a
-- decision name the group that was asked, and that must stay readable. (org_id, id) is unique so a child can name the
-- group and the org in one foreign key, and a row can never point at another org's group.
create table review_groups (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint review_groups_org_id_id_key unique (org_id, id)
);
alter table review_groups enable row level security;
alter table review_groups force row level security;
create policy review_groups_tenant on review_groups for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Nobody but members of the org (and server jobs) has a reason to see who checks: a respondent context never reads a group.
create policy review_groups_no_respondent_read on review_groups as restrictive for select to fr_app
  using ((select app_actor()) <> 'respondent');
-- Managing groups needs members.manage (the same permission as managing members), so a route that forgets its own check
-- is still stopped.
create policy review_groups_manage_insert on review_groups as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
create policy review_groups_manage_update on review_groups as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
-- Rename and archive only; no delete.
grant select, insert on review_groups to fr_app;
grant update (name, archived_at) on review_groups to fr_app;

-- The checkers of a group. The foreign key to memberships makes "a checker is a member of the org" a fact of the data,
-- not a check some route has to remember, and cascades: a member who leaves the org (or whose account is deleted, which
-- deletes the memberships) leaves every group with them. Whether the member may review at all is `submissions.review`,
-- which comes from their role at the time they decide, never from this row.
create table review_group_members (
  org_id uuid not null,
  group_id uuid not null,
  user_id uuid not null,
  added_by uuid not null references users (id),
  added_at timestamptz not null default now(),
  primary key (group_id, user_id),
  constraint review_group_members_group_fkey foreign key (org_id, group_id) references review_groups (org_id, id),
  constraint review_group_members_member_fkey foreign key (org_id, user_id) references memberships (org_id, user_id) on delete cascade
);
-- "Which groups is this user in" (the reviewer's scope, and the queue).
create index review_group_members_user_idx on review_group_members (org_id, user_id, group_id);
alter table review_group_members enable row level security;
alter table review_group_members force row level security;
create policy review_group_members_tenant on review_group_members for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy review_group_members_no_respondent_read on review_group_members as restrictive for select to fr_app
  using ((select app_actor()) <> 'respondent');
create policy review_group_members_manage_insert on review_group_members as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
create policy review_group_members_manage_delete on review_group_members as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'members.manage' = any ((select app_perms())::text[]));
-- Add and remove; a row is never edited (who added whom, and when, is what it records).
grant select, insert, delete on review_group_members to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. form_review_settings
-- ---------------------------------------------------------------------------------------------------------------

-- One row per form that has been set up for review; a form without a row is not reviewed. `settings` is the
-- server-stored assignment (ReviewSettings in @form/schema: for each review unit its group, order, required and
-- visibility, and distinctCheckers). It is not part of the form definition: the units (what is reviewed) are versioned
-- with the form, the assignment (who reviews it) is live, like the access rules. A table of its own, because
-- form_access (0020) is access-only and column-granted around its password hash; folding review into it would widen those grants.
-- `rev` is the compare-and-swap revision of PUT .../review (If-Match). Changing the settings of a form changes who
-- reviews the responses that arrive after it; a response already under review keeps the group and order it was opened with.
create table form_review_settings (
  form_id uuid primary key,
  org_id uuid not null,
  rev integer not null default 1 check (rev >= 1),
  enabled boolean not null default false,
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  updated_by uuid references users (id),
  updated_at timestamptz not null default now(),
  constraint form_review_settings_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
alter table form_review_settings enable row level security;
alter table form_review_settings force row level security;
create policy form_review_settings_tenant on form_review_settings for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Read by every context of the org, a respondent's too: the submit transaction asks whether the form is reviewed before
-- it chooses the status of the response. Written only with ops.manage (the permission of the other FormOps settings) or by a system job.
create policy form_review_settings_ops_insert on form_review_settings as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'ops.manage' = any ((select app_perms())::text[]));
create policy form_review_settings_ops_update on form_review_settings as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'ops.manage' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'ops.manage' = any ((select app_perms())::text[]));
-- The row lives with the form: no delete; "not reviewed" is enabled = false.
grant select, insert on form_review_settings to fr_app;
grant update (rev, enabled, settings, updated_by, updated_at) on form_review_settings to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. submission_reviews and review_decisions
-- ---------------------------------------------------------------------------------------------------------------

-- submission_reviews: the current state of each review unit of a submission, one row per unit. It is a copy taken when
-- the review is opened (group, order, required and visibility as the form's settings said then), so editing the
-- settings later never changes a review that is under way.
--   * state: pending (waiting for a checker), approved, rejected, not_applicable (every block of the unit was hidden or
--     off the respondent's path), closed (another unit was rejected, so this one is no longer asked).
--   * round: 1, and one more each time a unit is sent back and corrected (WP-2.18); earlier decisions stay readable.
--   * maker_user_id: who filled the unit in when that is a signed-in user (null for a public respondent, who has no
--     user id); last_editor_id: the last member who edited its answers (SUB-09). Neither may check the unit.
--   * excluded_user_ids: active members whose verified email matches an email the respondent gave, found when the review
--     was opened. They may not check it either. No email is stored: the ids are what the four-eyes rule needs, and the
--     blind-index column that would replace them waits for WP-1.11.
--   * answers_hash: sha256 of the unit's stored answers, which a decision names, so a checker approves exactly what they saw
--     and a later change makes the decision stale (409 review_stale).
--   * rev: bumped on every change, for the compare-and-swap of a concurrent decision.
-- Partitioned like submissions: the key carries the submission's own received_at, and the foreign key below
-- cascades, so deleting a submission (the trash purge, retention, erasure) deletes its reviews. The primary key leads
-- with the submission id (the partition column is part of every key of a partitioned table).
create table submission_reviews (
  org_id uuid not null,
  form_id uuid not null,
  submission_id uuid not null,
  submission_received_at timestamptz not null,
  unit_id text not null check (unit_id <> '' and length(unit_id) <= 64),
  round integer not null default 1 check (round >= 1),
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'not_applicable', 'closed')),
  required boolean not null,
  review_order integer not null check (review_order >= 1),
  group_id uuid not null,
  visibility text not null check (visibility in ('own_unit', 'whole_submission')),
  maker_user_id uuid,
  excluded_user_ids uuid[] not null default '{}',
  last_editor_id uuid,
  answers_hash bytea not null check (length(answers_hash) = 32),
  rev integer not null default 1 check (rev >= 1),
  updated_at timestamptz not null default now(),
  primary key (submission_id, submission_received_at, unit_id),
  constraint submission_reviews_submission_fkey foreign key (submission_id, submission_received_at)
    references submissions (id, received_at) on delete cascade,
  constraint submission_reviews_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint submission_reviews_group_fkey foreign key (org_id, group_id) references review_groups (org_id, id)
) partition by range (submission_received_at);
-- The review queue: what is waiting for the groups a checker belongs to, newest first.
create index submission_reviews_queue on submission_reviews (org_id, group_id, submission_received_at desc) where state = 'pending';

-- review_decisions: every approve and reject ever made, never changed. A decision names the unit, the round and the
-- hash of the answers the checker saw, and the form version those answers were validated against. reason_code is the
-- fixed catalogue (no free text in this slice: a note must be encrypted with the submission's key, WP-1.11, and a return
-- to the respondent is WP-2.18), required for a reject. idempotency_key makes a retried request return the first
-- decision instead of a second one: unique per org, and the partition column is part of every unique key.
create table review_decisions (
  id uuid not null,
  org_id uuid not null,
  form_id uuid not null,
  submission_id uuid not null,
  submission_received_at timestamptz not null,
  unit_id text not null check (unit_id <> '' and length(unit_id) <= 64),
  round integer not null check (round >= 1),
  decision text not null check (decision in ('approve', 'reject')),
  reason_code text check (reason_code is null or reason_code in ('incomplete', 'incorrect', 'missing_document', 'duplicate', 'other')),
  decided_by uuid not null references users (id),
  decided_at timestamptz not null default now(),
  answers_hash bytea not null check (length(answers_hash) = 32),
  form_version_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  primary key (id, submission_received_at),
  constraint review_decisions_idempotency_key unique (org_id, idempotency_key, submission_received_at),
  constraint review_decisions_reject_reason check (decision <> 'reject' or reason_code is not null),
  constraint review_decisions_submission_fkey foreign key (submission_id, submission_received_at)
    references submissions (id, received_at) on delete cascade,
  -- The version names its org and form (0020), so this one key also ties the row to its org and form.
  constraint review_decisions_version_fkey foreign key (org_id, form_id, form_version_id) references form_versions (org_id, form_id, id)
) partition by range (submission_received_at);
-- A submission's decisions (the log of a unit, "has this checker decided another unit"), and the way the cascade of the
-- foreign key above finds the rows of a deleted submission without scanning every partition.
create index review_decisions_submission_idx on review_decisions (submission_id, submission_received_at, unit_id, round);

-- Append-only. fr_app has no UPDATE or DELETE privilege on the table at all, so its refusal is a plain "permission
-- denied" before this trigger is reached; the trigger stops every other role that is not the table's owner. The owner
-- passes because two legitimate paths run as the owner: the SECURITY DEFINER functions of 0024 (and the erasure that
-- will clear a respondent's message, WP-2.18), and the ON DELETE CASCADE of the foreign key to submissions, which
-- PostgreSQL runs as the owner of the table it deletes from. Without that the trash purge could never delete a
-- submission that has a decision.
create function review_decisions_append_only() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception 'review_decisions is append-only (% refused)', tg_op using errcode = 'insufficient_privilege';
end
$$;
create trigger review_decisions_append_only before update or delete on review_decisions
  for each row execute function review_decisions_append_only();

-- Tenant policy and forced RLS on the parents (the partitions are made below). Both tables hold what a person decided
-- about a response, so reading needs what reading the response needs, or the review permission itself: a system
-- job, `submissions.read`, or `submissions.review`. The restrictive policy narrows the tenant one, like
-- submissions_data_access does for the answers.
alter table submission_reviews enable row level security;
alter table submission_reviews force row level security;
create policy submission_reviews_tenant on submission_reviews for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy submission_reviews_data_access on submission_reviews as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or 'submissions.read' = any ((select app_perms())::text[])
  or 'submissions.review' = any ((select app_perms())::text[]));

alter table review_decisions enable row level security;
alter table review_decisions force row level security;
create policy review_decisions_tenant on review_decisions for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy review_decisions_data_access on review_decisions as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or 'submissions.read' = any ((select app_perms())::text[])
  or 'submissions.review' = any ((select app_perms())::text[]));

-- fr_app reads and nothing else: a row is made, moved and closed only by review_open() and review_decide() (0024),
-- which check the permission, the group, the order, the answers' hash and the four-eyes rule in the same transaction as
-- the write. A route (or a bug in one) that tried to write a decision itself would be refused here.
grant select on submission_reviews to fr_app;
grant select on review_decisions to fr_app;

-- The current month and three ahead, in schema parts with forced RLS and no privilege for anyone but the owner
-- (F-2); partitions.maintain carries on from here. There is no default partition and no history to move: no
-- submission has been under review before this migration.
select create_partitions('public.submission_reviews'::regclass, 3);
select create_partitions('public.review_decisions'::regclass, 3);
