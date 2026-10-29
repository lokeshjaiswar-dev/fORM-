-- Tables behind two production adapters (WP-1.03): redeemed proof-of-work challenges, and the submission search
-- index of the Postgres FTS SearchIndex (architecture §2.4, §6). Both are tenant tables under the WP-0.13 model.

-- A proof-of-work solution passes once (ADR-0011): the challenge hash is recorded until the challenge expires, so every
-- API replica refuses a replay. The respondent's submit transaction inserts it; purgeExpired deletes expired rows,
-- and the drafts.expire sweep will call it once WP-1.13 wires proof of work into submit (BL-258).
create table captcha_redemptions (
  org_id uuid not null references orgs (id),
  challenge_hash bytea not null check (length(challenge_hash) = 32),
  expires_at timestamptz not null,
  redeemed_at timestamptz not null default now(),
  primary key (org_id, challenge_hash)
);
create index captcha_redemptions_expires_idx on captcha_redemptions (org_id, expires_at);
alter table captcha_redemptions enable row level security;
alter table captcha_redemptions force row level security;
create policy captcha_redemptions_tenant on captcha_redemptions for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, delete on captcha_redemptions to fr_app;

-- Text of non-sensitive, non-tainted answers only (sensitive fields are searchable through blind indexes), `simple`
-- configuration plus unaccent, so Hindi, Tamil or Urdu words are matched as written. Partitioned by month like
-- submissions; the btree_gin index leads with form_id, so a search never scans another form's documents.
create table submission_search (
  submission_id uuid not null,
  received_at timestamptz not null,
  org_id uuid not null,
  form_id uuid not null,
  locale text not null check (length(locale) between 2 and 35),
  doc tsvector not null,
  updated_at timestamptz not null default now(),
  primary key (submission_id, received_at)
) partition by range (received_at);
create index submission_search_form_doc_idx on submission_search using gin (form_id, doc);
create index submission_search_org_idx on submission_search (org_id, form_id, received_at desc);
alter table submission_search enable row level security;
alter table submission_search force row level security;
create policy submission_search_tenant on submission_search for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- The documents are answer text, so they carry the submissions_data_access rule (architecture §2.2, C-M8, F-22): the
-- respondent's submit transaction may INSERT, but reading, changing or deleting a document needs a system job,
-- `submissions.read`, or a respondent holding that submission's verified token.
create policy submission_search_data_access on submission_search as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or ((select app_actor()) = 'respondent' and submission_id = any ((select app_subject_ids())::uuid[]))
  or 'submissions.read' = any ((select app_perms())::text[]));
create policy submission_search_data_update on submission_search as restrictive for update to fr_app using (
     (select app_actor()) = 'system'
  or ((select app_actor()) = 'respondent' and submission_id = any ((select app_subject_ids())::uuid[]))
  or 'submissions.read' = any ((select app_perms())::text[]));
create policy submission_search_data_delete on submission_search as restrictive for delete to fr_app using (
     (select app_actor()) = 'system'
  or 'submissions.read' = any ((select app_perms())::text[]));
grant select, insert, update, delete on submission_search to fr_app;

select create_partitions('public.submission_search'::regclass, 3);
