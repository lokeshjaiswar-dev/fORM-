-- Notifications, webhooks, exports and the ledger of what left the system
-- (WP-1.16 NOT-01..05, WP-1.17 EXP-01, WP-1.18 INT-01; architecture §2.2, §2.4, §5.1).
--
-- Everything the "send the answers somewhere" features keep in the database, in one migration so the three work
-- packages share one set of tables, one RLS review and one numbering slot:
--
--   1. secrets            sealed SMTP credentials and webhook signing secrets. fr_app can write `enc` and can never read
--                         it back: a system context reads it through secret_enc().
--   2. email_senders      an org's own "from" mailboxes, each pointing at an SMTP secret.
--   3. notifications      owner notifications and autoresponders of a form (live, not part of a published version).
--   4. email_messages     the delivery log of every message (365 days): who it went to (masked), the state, no body.
--   5. webhooks           where a form's answers are posted, with a signing secret.
--   6. webhook_deliveries the delivery log of every attempt (365 days, snippet 30 days).
--   7. exports            CSV and XLSX export jobs.
--   8. disclosures        the append-only ledger of who received which fields of which response (DPDP s.11(1)(b)).
--   9. resolve_job_org()  learns the three job resources the fan-out children name.
--
-- A new migration: 0001..0021 have been applied and are never edited. (0022 belongs to the review tables.)
--
-- Conventions repeated from 0008, 0019, 0020 and 0021 (read those first):
--   * every table forces RLS and has the `<table>_tenant` policy (org_id = app_org()), which is all a respondent or
--     an API key would otherwise be held to;
--   * a restrictive policy narrows that per command, so a route that forgets its own permission check is still stopped;
--     `system` is the worker's job context;
--   * a child names its org as well as its parent ((org_id, form_id) -> forms, (org_id, secret_id) -> secrets), so a
--     row can never point at another org's form or secret, whatever id a client sent;
--   * INSERT is granted on the whole table (Drizzle's INSERT lists every column, and a column it names without the
--     privilege fails the statement); the restrictive WITH CHECK policies say who may insert what. UPDATE is granted
--     per column, so a bug cannot move a row to another org or form.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. secrets
-- ---------------------------------------------------------------------------------------------------------------

-- `enc` is the sealed value (@form/adapters sealOrgSecret: AES-256-GCM under a per-secret key that the org's KMS key
-- wraps; the id, kind and org are the associated data, so a sealed value pasted into another row does not open).
-- `meta` is what the UI may show: for smtp the host, port and user name, for webhook_hmac the last four characters of
-- the secret. Never the secret itself.
create table secrets (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  kind text not null check (kind in ('smtp', 'webhook_hmac')),
  enc jsonb not null check (jsonb_typeof(enc) = 'object'),
  meta jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  constraint secrets_org_id_id_key unique (org_id, id)
);
alter table secrets enable row level security;
alter table secrets force row level security;
create policy secrets_tenant on secrets for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Who may see or change which kind. A system job (the worker sending a mail or signing a delivery) may touch any; a
-- member needs the permission that owns the feature: org.settings for an SMTP credential, data.route for a webhook
-- secret. Without it the table is empty for them, and an insert or update is refused. One policy for every command.
create policy secrets_access on secrets as restrictive for all to fr_app
  using (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[])))
  with check (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[])));
-- The sealed value goes in and never comes out through a SELECT: `select *` and `returning *` fail with "permission
-- denied", so a query that names its columns (`secretPublicColumns`) cannot leak it into a response by accident.
grant select (id, org_id, kind, meta, created_at, rotated_at) on secrets to fr_app;
grant insert on secrets to fr_app;
grant update (enc, meta, rotated_at) on secrets to fr_app;
grant delete on secrets to fr_app;

-- The one reader of `enc`, for the code that must open a secret to use it: the worker sending a message or a webhook,
-- and the API's test send, which opens a system context for the one read. It answers inside a tenant context for that
-- context's own org, and only for the system actor (a member, an API key or a respondent gets "permission denied",
-- the same answer the column grant gives); an id of another org, or of no secret, answers null.
create function secret_enc(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if app_actor() <> 'system' then
    raise exception 'secret_enc: only a system context may read a sealed secret' using errcode = 'insufficient_privilege';
  end if;
  return (select s.enc from secrets s where s.id = p_id and s.org_id = app_org());
end
$$;
revoke all on function secret_enc(uuid) from public;
grant execute on function secret_enc(uuid) to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. email_senders
-- ---------------------------------------------------------------------------------------------------------------

-- An org's own sending identity (NOT-01). A notification without a sender goes out through the platform mailer. The
-- SMTP secret is a foreign key by (org, id), so a sender can only use its own org's credentials. Deleting a sender that
-- a notification uses, or a secret that a sender uses, is refused (the API says "in use"): a notification must not
-- silently change the address it is sent from.
create table email_senders (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  name text not null check (char_length(name) between 1 and 120),
  from_address text not null check (char_length(from_address) between 3 and 254 and position('@' in from_address) > 1),
  from_name text check (from_name is null or char_length(from_name) <= 120),
  smtp_secret_id uuid not null,
  -- Set by the test send when the server accepted a message; cleared when the credentials change.
  verified_at timestamptz,
  -- What the last failed test send said, scrubbed of the URL and credentials by the API.
  last_test_error text check (last_test_error is null or char_length(last_test_error) <= 1000),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_senders_org_id_id_key unique (org_id, id),
  constraint email_senders_secret_fkey foreign key (org_id, smtp_secret_id) references secrets (org_id, id)
);
-- At most one default per org.
create unique index email_senders_default_key on email_senders (org_id) where is_default;
create index email_senders_secret_idx on email_senders (org_id, smtp_secret_id);
alter table email_senders enable row level security;
alter table email_senders force row level security;
create policy email_senders_tenant on email_senders for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- A public (respondent) context has no business with the org's mailboxes.
create policy email_senders_no_respondent_read on email_senders as restrictive for select to fr_app
  using ((select app_actor()) <> 'respondent');
-- Writes need org.settings, or a system job.
create policy email_senders_write_insert on email_senders as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]));
create policy email_senders_write_update on email_senders as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]));
create policy email_senders_write_delete on email_senders as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'org.settings' = any ((select app_perms())::text[]));
grant select, insert, delete on email_senders to fr_app;
grant update (name, from_address, from_name, smtp_secret_id, verified_at, last_test_error, is_default, updated_at) on email_senders to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. notifications
-- ---------------------------------------------------------------------------------------------------------------

-- Live and unversioned (architecture §2.4): a published version freezes the form, a notification can change after it.
-- `config` is the NotificationConfig of @form/schema (recipients, subject, body, variants, attachments); the columns
-- beside it are what the worker queries or the database enforces. `purpose_ids` is required and non-empty (WP-1.16): a
-- notification that names no purpose would send every field, which the purpose filter exists to stop. `rev` is the
-- compare-and-swap revision of PUT (If-Match).
create table notifications (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  kind text not null check (kind in ('owner', 'autoresponder')),
  enabled boolean not null default true,
  trigger text not null check (trigger in ('submitted', 'edited', 'payment_confirmed', 'appointment_reminder', 'workflow_step', 'draft_saved')),
  sender_id uuid,
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  purpose_ids text[] not null,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint notifications_purpose_ids_check check (cardinality(purpose_ids) > 0 and array_position(purpose_ids, null) is null and '' <> all (purpose_ids)),
  constraint notifications_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint notifications_sender_fkey foreign key (org_id, sender_id) references email_senders (org_id, id)
);
create index notifications_form_idx on notifications (org_id, form_id);
create index notifications_sender_idx on notifications (org_id, sender_id) where sender_id is not null;
alter table notifications enable row level security;
alter table notifications force row level security;
create policy notifications_tenant on notifications for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy notifications_no_respondent_read on notifications as restrictive for select to fr_app
  using ((select app_actor()) <> 'respondent');
-- Editing a form's emails needs forms.edit (as its draft does), or a system job.
create policy notifications_write_insert on notifications as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]));
create policy notifications_write_update on notifications as restrictive for update to fr_app
  using ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]));
create policy notifications_write_delete on notifications as restrictive for delete to fr_app
  using ((select app_actor()) = 'system' or 'forms.edit' = any ((select app_perms())::text[]));
grant select, insert, delete on notifications to fr_app;
grant update (kind, enabled, trigger, sender_id, config, purpose_ids, rev, updated_at, updated_by) on notifications to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. email_messages
-- ---------------------------------------------------------------------------------------------------------------

-- One row per message the dispatcher decides to send (NOT-04): the log the "Email log" tab reads. No body is stored: the
-- message is rendered again at send time, from the current form and answers. `to_display_masked` is what a person may
-- see ("a***@example.com"), `to_bidx` the blind indexes for a DSR lookup (null until WP-1.11 makes the key). `message_id`
-- is the RFC 5322 Message-ID, made once and reused on every retry, so a message delivered twice (at-least-once) is one
-- message to the mail server. `org_profile_updated_at` and `brand_tokens_hash` record which org profile and brand kit
-- the live variables were resolved from (F-44).
--
-- Monthly range partitions on created_at, in schema `parts` like submissions (no default partition). Deleted with the
-- response it is about (the FK cascades, run by the table owner); the rest goes at 365 days (WP-1.22 retention.sweep).
-- fr_app reads with submissions.read and a system job writes everything: a member cannot forge or edit the log.
create table email_messages (
  id uuid not null,
  created_at timestamptz not null default now(),
  org_id uuid not null,
  form_id uuid not null,
  submission_id uuid not null,
  submission_received_at timestamptz not null,
  notification_id uuid not null,
  role text not null check (char_length(role) between 1 and 32),
  to_display_masked text[] not null check (cardinality(to_display_masked) > 0),
  to_bidx bytea[],
  subject_hash bytea not null check (length(subject_hash) = 32),
  message_id text not null check (char_length(message_id) between 1 and 255),
  status text not null default 'queued' check (status in ('queued', 'sending', 'retrying', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 255),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  org_profile_updated_at timestamptz,
  brand_tokens_hash bytea check (brand_tokens_hash is null or length(brand_tokens_hash) = 32),
  sent_at timestamptz,
  primary key (id, created_at),
  constraint email_messages_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint email_messages_submission_fkey foreign key (submission_id, submission_received_at)
    references submissions (id, received_at) on delete cascade
) partition by range (created_at);
create index email_messages_form_idx on email_messages (org_id, form_id, created_at desc, id desc);
-- The key the cascade above finds a deleted response's messages by.
create index email_messages_submission_idx on email_messages (submission_id, submission_received_at);
alter table email_messages enable row level security;
alter table email_messages force row level security;
create policy email_messages_tenant on email_messages for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy email_messages_read on email_messages as restrictive for select to fr_app
  using ((select app_actor()) = 'system' or 'submissions.read' = any ((select app_perms())::text[]));
create policy email_messages_write_insert on email_messages as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system');
create policy email_messages_write_update on email_messages as restrictive for update to fr_app
  using ((select app_actor()) = 'system') with check ((select app_actor()) = 'system');
create policy email_messages_write_delete on email_messages as restrictive for delete to fr_app
  using ((select app_actor()) = 'system');
grant select, insert, delete on email_messages to fr_app;
grant update (status, attempts, provider_message_id, last_error, sent_at, subject_hash, to_display_masked, to_bidx, org_profile_updated_at, brand_tokens_hash)
  on email_messages to fr_app;
select create_partitions('public.email_messages'::regclass, 3);

-- ---------------------------------------------------------------------------------------------------------------
-- 5. webhooks
-- ---------------------------------------------------------------------------------------------------------------

-- A form's outgoing webhooks (INT-01). Sending answers to an outside address is a disclosure (CONTRIBUTING §5, rule 6):
-- `purpose_ids` is required and non-empty, and every command needs `data.route` (architecture §2.4: it closes the path
-- where a Creator, who may not read answers, routes future answers to themselves). `secret_id` names the signing secret
-- (secrets, kind webhook_hmac), made by the server and shown once. `field_keys` is either the string "all_in_purposes" or
-- an array of field keys that narrows the purpose filter further. `consecutive_failures` and `disabled_reason` are the
-- auto-disable after 50 failures. `rev` is the CAS revision of PUT. A webhook filter (a condition group) is not stored
-- yet; it arrives with its own column when the delivery worker evaluates one.
create table webhooks (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  url text not null check (char_length(url) between 8 and 2048 and url ~ '^https?://'),
  enabled boolean not null default true,
  secret_id uuid not null,
  events text[] not null,
  key_by text not null default 'key' check (key_by in ('key', 'id')),
  field_keys jsonb not null default '"all_in_purposes"'::jsonb,
  purpose_ids text[] not null,
  files text not null default 'none' check (files in ('signed_urls', 'none')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 500),
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint webhooks_org_id_id_key unique (org_id, id),
  constraint webhooks_events_check check (cardinality(events) > 0
    and events <@ array['submission.created', 'submission.updated', 'submission.deleted', 'payment.succeeded', 'consent.withdrawn']::text[]),
  constraint webhooks_field_keys_check check (field_keys = '"all_in_purposes"'::jsonb or jsonb_typeof(field_keys) = 'array'),
  constraint webhooks_purpose_ids_check check (cardinality(purpose_ids) > 0 and array_position(purpose_ids, null) is null and '' <> all (purpose_ids)),
  constraint webhooks_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint webhooks_secret_fkey foreign key (org_id, secret_id) references secrets (org_id, id)
);
create index webhooks_form_idx on webhooks (org_id, form_id);
create index webhooks_secret_idx on webhooks (org_id, secret_id);
alter table webhooks enable row level security;
alter table webhooks force row level security;
create policy webhooks_tenant on webhooks for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Every command: data.route, or a system job (the worker reads the webhooks to fan out and counts failures).
create policy webhooks_data_route on webhooks as restrictive for all to fr_app
  using ((select app_actor()) = 'system' or 'data.route' = any ((select app_perms())::text[]))
  with check ((select app_actor()) = 'system' or 'data.route' = any ((select app_perms())::text[]));
grant select, insert, delete on webhooks to fr_app;
grant update (url, enabled, secret_id, events, key_by, field_keys, purpose_ids, files, consecutive_failures, disabled_reason, rev, updated_at, updated_by)
  on webhooks to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. webhook_deliveries
-- ---------------------------------------------------------------------------------------------------------------

-- One row per delivery of one event, updated as it is tried (attempt, status, http_status, next_attempt_at), and a new
-- row for a replay (`replay_of` names the original). The body is not stored: `request_hash` is the sha256 of what was
-- sent, so a replay can be shown to carry the same answers. `response_snippet` is at most 1 KB of the receiver's
-- answer, scrubbed of addresses and long digit runs by the worker, and nulled after 30 days (WP-1.22). The response
-- may not outlive its webhook: deleting a webhook deletes its deliveries. The submission is not a foreign key: a
-- `submission.deleted` event is delivered after the response is gone, and must not be deleted along with it; the
-- columns are both set or both null.
--
-- Monthly range partitions on created_at, like email_messages. A member with data.route reads and replays; only a
-- system job updates or deletes.
create table webhook_deliveries (
  id uuid not null,
  created_at timestamptz not null default now(),
  org_id uuid not null,
  webhook_id uuid not null,
  event text not null check (event in ('submission.created', 'submission.updated', 'submission.deleted', 'payment.succeeded', 'consent.withdrawn')),
  submission_id uuid,
  submission_received_at timestamptz,
  attempt integer not null default 0 check (attempt >= 0),
  status text not null default 'pending' check (status in ('pending', 'retrying', 'succeeded', 'failed', 'dead')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  request_hash bytea check (request_hash is null or length(request_hash) = 32),
  response_snippet text check (response_snippet is null or char_length(response_snippet) <= 1024),
  replay_of uuid,
  next_attempt_at timestamptz,
  primary key (id, created_at),
  constraint webhook_deliveries_submission_pair check ((submission_id is null) = (submission_received_at is null)),
  constraint webhook_deliveries_webhook_fkey foreign key (org_id, webhook_id) references webhooks (org_id, id) on delete cascade
) partition by range (created_at);
create index webhook_deliveries_webhook_idx on webhook_deliveries (org_id, webhook_id, created_at desc, id desc);
alter table webhook_deliveries enable row level security;
alter table webhook_deliveries force row level security;
create policy webhook_deliveries_tenant on webhook_deliveries for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy webhook_deliveries_read on webhook_deliveries as restrictive for select to fr_app
  using ((select app_actor()) = 'system' or 'data.route' = any ((select app_perms())::text[]));
-- The replay route inserts a pending row as the member; the worker does the rest.
create policy webhook_deliveries_write_insert on webhook_deliveries as restrictive for insert to fr_app
  with check ((select app_actor()) = 'system' or 'data.route' = any ((select app_perms())::text[]));
create policy webhook_deliveries_write_update on webhook_deliveries as restrictive for update to fr_app
  using ((select app_actor()) = 'system') with check ((select app_actor()) = 'system');
create policy webhook_deliveries_write_delete on webhook_deliveries as restrictive for delete to fr_app
  using ((select app_actor()) = 'system');
grant select, insert, delete on webhook_deliveries to fr_app;
grant update (attempt, status, http_status, duration_ms, request_hash, response_snippet, next_attempt_at) on webhook_deliveries to fr_app;
select create_partitions('public.webhook_deliveries'::regclass, 3);

-- ---------------------------------------------------------------------------------------------------------------
-- 7. exports
-- ---------------------------------------------------------------------------------------------------------------

-- An export job (EXP-01): the API inserts a `queued` row and the `export.build` job takes it from there. `scope` is
-- {kind:'all'} | {kind:'selected', ids} | {kind:'filtered', from?, to?}. `include_sensitive` needs a reason (the
-- audit event carries it). `idempotency_key` is the client's Idempotency-Key: a repeat finds the same export. The file
-- itself is in the `exports` bucket at `object_key` and expires with `expires_at` (24 hours after it is built).
--
-- A member needs submissions.export to ask for one and to read the list, and may insert only a queued row with no
-- object: the file's key, size and state are the worker's to write (otherwise a crafted object_key would make the
-- download route stream another org's file). Only a system job updates or deletes.
create table exports (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  requested_by uuid not null,
  format text not null check (format in ('csv', 'xlsx')),
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),
  include_sensitive boolean not null default false,
  reason text check (reason is null or char_length(reason) <= 1000),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 255),
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  row_count bigint check (row_count is null or row_count >= 0),
  object_key text check (object_key is null or char_length(object_key) <= 512),
  bytes bigint check (bytes is null or bytes >= 0),
  error text check (error is null or char_length(error) <= 1000),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  expires_at timestamptz,
  constraint exports_idempotency_key unique (org_id, idempotency_key),
  constraint exports_sensitive_reason_check check (not include_sensitive or (reason is not null and reason ~ '[^[:space:]]')),
  constraint exports_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
create index exports_form_idx on exports (org_id, form_id, created_at desc);
-- The concurrency quota (10 queued or running per org) and the daily one (100) are counted from these.
create index exports_active_idx on exports (org_id) where status in ('queued', 'running');
create index exports_created_idx on exports (org_id, created_at desc);
-- The sweep that expires files finds them by date.
create index exports_expiry_idx on exports (expires_at) where status = 'ready';
alter table exports enable row level security;
alter table exports force row level security;
create policy exports_tenant on exports for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy exports_read on exports as restrictive for select to fr_app
  using ((select app_actor()) = 'system' or 'submissions.export' = any ((select app_perms())::text[]));
create policy exports_write_insert on exports as restrictive for insert to fr_app
  with check (
       (select app_actor()) = 'system'
    or ('submissions.export' = any ((select app_perms())::text[])
        and status = 'queued' and object_key is null and row_count is null and bytes is null and error is null
        and finished_at is null and expires_at is null));
create policy exports_write_update on exports as restrictive for update to fr_app
  using ((select app_actor()) = 'system') with check ((select app_actor()) = 'system');
create policy exports_write_delete on exports as restrictive for delete to fr_app
  using ((select app_actor()) = 'system');
grant select, insert, delete on exports to fr_app;
grant update (status, row_count, object_key, bytes, error, finished_at, expires_at) on exports to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. disclosures
-- ---------------------------------------------------------------------------------------------------------------

-- The ledger of who received data (DPDP s.11(1)(b), architecture §2.4): one row per recipient and response, naming the
-- fields that were sent (`field_keys`, never values). Written by the notification, webhook and export paths in the
-- transaction that sends or builds, so there is no send without a row. Append-only for fr_app: it can SELECT and INSERT
-- and nothing else (no UPDATE or DELETE privilege, so "permission denied", whoever asks). The row lives as long as its
-- response: deleting the response deletes its ledger rows (the FK cascade runs as the table owner, so no extra delete
-- path is opened), and a data principal's export includes them (C-M6). Anyone in the org's context may add a row (the
-- submit transaction runs as a respondent and records owner notifications with fixed recipients); reading needs
-- submissions.read or compliance.dsr, or a system job.
create table disclosures (
  id uuid primary key,
  org_id uuid not null references orgs (id),
  submission_id uuid not null,
  submission_received_at timestamptz not null,
  recipient_kind text not null check (recipient_kind in ('notification', 'webhook', 'export')),
  recipient_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 320),
  field_keys text[] not null default '{}',
  at timestamptz not null default now(),
  constraint disclosures_submission_fkey foreign key (submission_id, submission_received_at)
    references submissions (id, received_at) on delete cascade
);
create index disclosures_submission_idx on disclosures (submission_id, submission_received_at);
create index disclosures_recipient_idx on disclosures (org_id, recipient_kind, recipient_id, at desc);
alter table disclosures enable row level security;
alter table disclosures force row level security;
create policy disclosures_tenant on disclosures for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy disclosures_read on disclosures as restrictive for select to fr_app
  using ((select app_actor()) = 'system'
      or 'submissions.read' = any ((select app_perms())::text[])
      or 'compliance.dsr' = any ((select app_perms())::text[]));
grant select, insert on disclosures to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- 9. resolve_job_org
-- ---------------------------------------------------------------------------------------------------------------

-- The three child jobs the fan-out enqueues name their own row (email.send -> email_message, webhook.deliver ->
-- webhook_delivery, export.build -> export), and the worker re-derives the org from it before running (ADR-0016). The
-- parents (notification.dispatch, webhook.fanout) name the form, which was already resolvable. A partitioned log row is
-- found by id alone: the primary key (id, created_at) leads with id, so each partition answers from its index, and the
-- few partitions that exist (the retention window plus three months) keep that cheap. Same signature, owner and grant
-- as 0003 and 0005; the four existing cases are unchanged.
create or replace function resolve_job_org(p_resource_type text, p_resource_id uuid)
returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  case p_resource_type
    when 'org' then return (select o.id from orgs o where o.id = p_resource_id);
    when 'form' then return (select f.org_id from forms f where f.id = p_resource_id);
    when 'form_draft' then return (select d.org_id from form_drafts d where d.form_id = p_resource_id);
    when 'audit_chain' then return (
      select p_resource_id
      where exists (select 1 from audit_pending p where p.org_key = p_resource_id)
         or exists (select 1 from audit_heads h where h.org_key = p_resource_id));
    when 'email_message' then return (select m.org_id from email_messages m where m.id = p_resource_id limit 1);
    when 'webhook_delivery' then return (select d.org_id from webhook_deliveries d where d.id = p_resource_id limit 1);
    when 'export' then return (select e.org_id from exports e where e.id = p_resource_id);
    else raise exception 'resolve_job_org: unknown resource type %', p_resource_type using errcode = 'invalid_parameter_value';
  end case;
end
$$;
