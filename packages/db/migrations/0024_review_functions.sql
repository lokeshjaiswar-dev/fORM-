-- Section-level maker-checker review, the two functions (WP-2.33: WFL-09; architecture §2.4, ADR-0004). Migration 0022 made the
-- tables and left fr_app with SELECT only on submission_reviews and review_decisions, and with a trigger that stops
-- everyone but the table's owner from moving a response into or out of 'pending_review' and 'rejected'. These two
-- SECURITY DEFINER functions run as the owner, so they are the only way to open a review, to decide a unit, and to
-- release (or reject) a held response. Everything a rule needs is checked inside them, in the same transaction as the
-- write, so a route that forgets a check (or a bug in one) cannot skip it.
--
--   review_open()   the submit transaction of a held response writes the round-1 rows.
--   review_decide() a checker approves or rejects one unit; the response completes or is rejected when the rules say so.
--
-- Neither appends an audit event. The audit chain is appended by the API in the same transaction (audit.append, so the
-- catalogue test sees the call site), and a refusal is a denied event written on the separate audit connection (WP-1.04).
--
-- A new migration: 0022 and 0023 have been applied and are never edited.

-- ---------------------------------------------------------------------------------------------------------------
-- review_open()
-- ---------------------------------------------------------------------------------------------------------------

-- Writes the round-1 rows of a response that the submit transaction has just stored with status 'pending_review'.
--
-- p_units is a jsonb array with one element per review unit of the form, composed by the API from the form's review
-- settings and the published definition (never from the respondent): { "unitId": text, "groupId": uuid, "order": int >= 1,
-- "required": bool, "visibility": "own_unit" | "whole_submission", "applicable": bool, "answersHash": 64 hex digits }.
-- A unit that is not applicable (every block of it was hidden or off the respondent's path) is stored 'not_applicable'
-- and is never asked; the others are 'pending'. answersHash is the sha256 of the unit's stored answers, which a decision
-- must name later. p_form_version_id must be the version the response was validated against (a consistency check: the
-- decisions of review_decide() take their version from the response itself).
--
-- p_respondent_emails are the addresses the respondent gave (every email-type answer, not only the principal
-- identifier). They are used for one thing: the members of this org whose VERIFIED address is one of them are written
-- into excluded_user_ids on every unit, so they cannot check a response about themselves (the four-eyes rule). Every
-- membership counts, whatever its status: a member who is suspended (on leave, say) when the response arrives is excluded
-- too, because review_decide() lets them decide again as soon as an admin reactivates them, and by then the exclusion
-- could no longer be made. Excluding someone who cannot decide anyway costs nothing.
-- The addresses are not stored anywhere. The match is made now: a member who joins, or verifies their address, after the
-- response was stored is not excluded (a known limit until the blind index of WP-1.11 can match at decision time).
--
-- Callable from a respondent, user or system context of an org. maker_user_id is the signed-in user for a user context
-- (they filled the response in, so they may not check it) and null for a public respondent or a job.
--
-- Refuses (raises, so the submit transaction is rolled back; a held response with no review rows could never be released):
--   42501  not a respondent, user or system context, or no org;
--   P0002  no such response in this org;
--   55000  the response is not 'pending_review', or already has review rows;
--   22023  the units are malformed, the version is not the response's, or no required unit is applicable (nothing to hold
--          the response for: the caller should have stored it 'complete').
-- Returns how many units it wrote, how many of them are pending, and how many members it excluded.
create function review_open(p_submission_id uuid, p_received_at timestamptz, p_form_version_id uuid, p_units jsonb, p_respondent_emails text[])
returns table (unit_count integer, pending_count integer, excluded_count integer)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_org uuid := app_org();
  v_form uuid;
  v_version uuid;
  v_status text;
  v_total integer;
  v_pending integer;
  v_required_pending integer;
  v_malformed integer;
  v_excluded uuid[];
begin
  if v_org is null or app_actor() not in ('respondent', 'user', 'system') then
    raise exception 'review_open: only a respondent, user or system context of an org may open a review' using errcode = 'insufficient_privilege';
  end if;
  if p_submission_id is null or p_received_at is null or p_form_version_id is null then
    raise exception 'review_open: the submission and the form version are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_units is null or jsonb_typeof(p_units) <> 'array' or jsonb_array_length(p_units) not between 1 and 200 then
    raise exception 'review_open: units must be a jsonb array of 1 to 200 units' using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(p_respondent_emails) > 100 then
    raise exception 'review_open: at most 100 respondent addresses' using errcode = 'invalid_parameter_value';
  end if;

  -- The response, of this org only. NO KEY UPDATE serialises two opens (and an open against a decision) on the response.
  select s.form_id, s.form_version_id, s.status into v_form, v_version, v_status
  from submissions s where s.id = p_submission_id and s.received_at = p_received_at and s.org_id = v_org
  for no key update;
  if not found then
    raise exception 'review_open: no such response in this org' using errcode = 'no_data_found';
  end if;
  if v_status <> 'pending_review' then
    raise exception 'review_open: the response is % and only a pending_review response is opened for review', v_status using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from submission_reviews r where r.submission_id = p_submission_id and r.submission_received_at = p_received_at) then
    raise exception 'review_open: the response already has review rows' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_version <> p_form_version_id then
    raise exception 'review_open: the units were made for another form version than the response''s' using errcode = 'invalid_parameter_value';
  end if;

  select count(*)::integer,
         count(*) filter (where x.applicable)::integer,
         count(*) filter (where x.applicable and x.required)::integer,
         count(*) filter (where x."unitId" is null or x."groupId" is null or x."order" is null or x.required is null
                            or x.visibility is null or x.applicable is null or x."answersHash" is null or x."answersHash" !~ '^[0-9a-f]{64}$')::integer
  into v_total, v_pending, v_required_pending, v_malformed
  from jsonb_to_recordset(p_units) as x("unitId" text, "groupId" uuid, "order" integer, required boolean, visibility text, applicable boolean, "answersHash" text);
  if v_malformed > 0 then
    raise exception 'review_open: every unit needs unitId, groupId, order, required, visibility, applicable and a 64-digit hex answersHash' using errcode = 'invalid_parameter_value';
  end if;
  -- A held response needs at least one required unit that a checker must approve. Without one nothing would ever move
  -- it out of 'pending_review', so the caller must store it 'complete' instead of holding it.
  if v_required_pending = 0 then
    raise exception 'review_open: no required unit is applicable, so the response is not held for review' using errcode = 'invalid_parameter_value';
  end if;

  -- Members of this org, of any membership or account status, whose verified address is one the respondent gave. No status
  -- filter on purpose: a suspended member is not able to decide now, but review_decide() lets them decide once an admin
  -- reactivates them, and they would then approve a response about themselves. email_norm is trimmed and lower-case.
  select coalesce(array_agg(distinct u.id), '{}') into v_excluded
  from users u join memberships m on m.user_id = u.id and m.org_id = v_org
  where u.email_verified_at is not null
    and u.email_norm in (select lower(btrim(e, E' \t\r\n')) from unnest(coalesce(p_respondent_emails, '{}')) as e);

  -- group_id is checked by the foreign key (org_id, group_id): a group of another org fails with 23503. The constraints
  -- of the table check the rest (state, visibility, order, hash length, key length); a repeated unitId fails the primary key.
  insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, round, state, required,
    review_order, group_id, visibility, maker_user_id, excluded_user_ids, answers_hash)
  select v_org, v_form, p_submission_id, p_received_at, x."unitId", 1, case when x.applicable then 'pending' else 'not_applicable' end,
    x.required, x."order", x."groupId", x.visibility, case when app_actor() = 'user' then app_user() end, v_excluded, decode(x."answersHash", 'hex')
  from jsonb_to_recordset(p_units) as x("unitId" text, "groupId" uuid, "order" integer, required boolean, visibility text, applicable boolean, "answersHash" text);

  return query select v_total, v_pending, coalesce(cardinality(v_excluded), 0);
end
$$;
revoke all on function review_open(uuid, timestamptz, uuid, jsonb, text[]) from public;
grant execute on function review_open(uuid, timestamptz, uuid, jsonb, text[]) to fr_app;

-- ---------------------------------------------------------------------------------------------------------------
-- review_decide()
-- ---------------------------------------------------------------------------------------------------------------

-- A checker approves or rejects one review unit of a held response. Everything below happens in one transaction; a
-- refusal returns its outcome and writes nothing (no decision, no state change), so the API can append the denied audit
-- event on its own connection and answer with the matching problem.
--
-- Arguments: p_decision is 'approve' or 'reject'; p_reason_code is one of the fixed catalogue (incomplete, incorrect,
-- missing_document, duplicate, other) for a reject and null for an approve; p_answers_hash is the sha256 of the unit's
-- answers as the checker saw them; p_idempotency_key makes a retry return the first result; p_decision_id is the id the
-- API made for the decision. Malformed arguments raise 22023 (the API validates them first; the function is the guarantee).
--
-- Outcomes, in the order they are decided:
--   permission_denied        not a signed-in user with 'submissions.review' in this org;
--   not_found                no such response or unit in this org;
--   idempotency_key_reused   the key was used for another user, response, unit, decision, reason or hash (a replay of the
--                            same request is not a refusal: it returns the first result);
--   not_in_group             not an active member of the unit's group;
--   mfa_required             the org requires two-factor sign-in for checkers (org_settings.review_checkers_mfa, on by
--                            default) and this user has not enrolled it (users.totp_enabled_at);
--   review_closed            the unit is not pending, or the response is not 'pending_review' any more (someone decided
--                            first, or the response was finalised), or the response is in the trash (trashed_at set);
--   order_blocked            a required unit of a lower order is not yet approved or not_applicable;
--   review_stale             p_answers_hash is not the unit's current answers_hash;
--   four_eyes_violation      the user is the unit's maker or last editor, is a member whose verified address matched the
--                            respondent's when the review was opened, or (form settings: distinctCheckers) has already
--                            decided another unit of this response;
--   decided                  the decision was written.
-- Returns (outcome, decision_id, unit_state, submission_status, replayed). decision_id is null unless the outcome is
-- 'decided'. The two states are filled once the caller is known to be a reviewer of the unit (null before that).
-- replayed is true when the outcome is the first result of a retried key: the same decision_id and outcome come back and
-- nothing was written, so the API must not append its audit event or enqueue the fan-out a second time.
--
-- Concurrency: the response row is locked first (FOR NO KEY UPDATE), so every decision of one response runs one after the
-- other and each sees the committed result of the one before. Two checkers on one unit: the second finds the unit decided
-- (review_closed). Two checkers on the last two units: the second sees the first's approval and completes the response;
-- without the lock each would see the other's unit still pending and the response would be stuck in 'pending_review'.
-- The unit row is then locked too (FOR UPDATE), as the plan states.
--
-- On the first required unit rejected the response becomes 'rejected'; on the last required applicable unit approved
-- (against the unit's current answers_hash) it becomes 'complete'. Either way the units still pending are 'closed' and
-- the response's revision is bumped, so an owner's concurrent edit fails its compare-and-swap.
--
-- distinctCheckers is read from the form's live review settings at decision time: the group, order, required and
-- visibility of a unit are copies taken when the review was opened, but this one flag has no column to copy it to.
create function review_decide(p_submission_id uuid, p_received_at timestamptz, p_unit_id text, p_decision text, p_reason_code text,
  p_answers_hash bytea, p_idempotency_key text, p_decision_id uuid)
returns table (outcome text, decision_id uuid, unit_state text, submission_status text, replayed boolean)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_org uuid := app_org();
  v_user uuid := app_user();
  v_form uuid;
  v_version uuid;
  v_status text;
  v_trashed timestamptz;
  r submission_reviews%rowtype;
  d review_decisions%rowtype;
  v_distinct boolean;
  v_state text;
  v_final text;
begin
  if app_actor() <> 'user' or v_user is null or v_org is null or not ('submissions.review' = any (app_perms())) then
    return query select 'permission_denied'::text, null::uuid, null::text, null::text, false;
    return;
  end if;
  if p_submission_id is null or p_received_at is null or p_unit_id is null or p_decision_id is null then
    raise exception 'review_decide: the submission, the unit and the decision id are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'review_decide: the decision is approve or reject' using errcode = 'invalid_parameter_value';
  end if;
  -- The fixed catalogue of 0022: required for a reject, never given for an approve.
  if p_decision = 'reject' and (p_reason_code is null or p_reason_code not in ('incomplete', 'incorrect', 'missing_document', 'duplicate', 'other')) then
    raise exception 'review_decide: a reject needs a reason code from the catalogue' using errcode = 'invalid_parameter_value';
  end if;
  if p_decision = 'approve' and p_reason_code is not null then
    raise exception 'review_decide: an approve has no reason code' using errcode = 'invalid_parameter_value';
  end if;
  if p_answers_hash is null or length(p_answers_hash) <> 32 then
    raise exception 'review_decide: the answers hash is 32 bytes' using errcode = 'invalid_parameter_value';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 255 then
    raise exception 'review_decide: the idempotency key is 1 to 255 characters' using errcode = 'invalid_parameter_value';
  end if;

  -- The response, of this org only, locked: decisions of one response run one after the other.
  select s.form_id, s.form_version_id, s.status, s.trashed_at into v_form, v_version, v_status, v_trashed
  from submissions s where s.id = p_submission_id and s.received_at = p_received_at and s.org_id = v_org
  for no key update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, false;
    return;
  end if;

  -- A retry of a request that was decided: the first result, nothing written. Looked up after the lock, so a retry that
  -- raced the original waits for it and then finds it. The key is scoped to the response's month by the table's unique
  -- key; a key used for anything else is refused, not replayed.
  select * into d from review_decisions x
  where x.org_id = v_org and x.idempotency_key = p_idempotency_key and x.submission_received_at = p_received_at;
  if found then
    if d.submission_id = p_submission_id and d.unit_id = p_unit_id and d.decided_by = v_user and d.decision = p_decision
       and d.reason_code is not distinct from p_reason_code and d.answers_hash = p_answers_hash then
      return query select 'decided'::text, d.id, case d.decision when 'approve' then 'approved' else 'rejected' end::text, v_status, true;
    else
      return query select 'idempotency_key_reused'::text, null::uuid, null::text, null::text, false;
    end if;
    return;
  end if;

  select * into r from submission_reviews x
  where x.submission_id = p_submission_id and x.submission_received_at = p_received_at and x.unit_id = p_unit_id and x.org_id = v_org
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, false;
    return;
  end if;

  -- An active member of the unit's group (the foreign key of 0022 ties the row to a membership of this org; the status
  -- of that membership and of the account are checked now). The permission itself came from the role, above.
  if not exists (
    select 1 from review_group_members g
    join memberships m on m.org_id = g.org_id and m.user_id = g.user_id
    join users u on u.id = g.user_id
    where g.org_id = v_org and g.group_id = r.group_id and g.user_id = v_user and m.status = 'active' and u.status = 'active'
  ) then
    return query select 'not_in_group'::text, null::uuid, null::text, null::text, false;
    return;
  end if;

  -- No settings row means the default: on.
  if coalesce((select o.review_checkers_mfa from org_settings o where o.org_id = v_org), true)
     and not exists (select 1 from users u where u.id = v_user and u.totp_enabled_at is not null) then
    return query select 'mfa_required'::text, null::uuid, null::text, null::text, false;
    return;
  end if;

  -- A trashed response is out of circulation (the grid trashes by setting trashed_at and leaves the status alone): an
  -- approval must not release it to the fan-out, even through a direct call that the queue's filter never sees.
  if r.state <> 'pending' or v_status <> 'pending_review' or v_trashed is not null then
    return query select 'review_closed'::text, null::uuid, r.state, v_status, false;
    return;
  end if;

  -- A lower order waits for nothing but a required unit: an optional one that is still pending does not block.
  if exists (
    select 1 from submission_reviews o
    where o.submission_id = p_submission_id and o.submission_received_at = p_received_at
      and o.required and o.review_order < r.review_order and o.state not in ('approved', 'not_applicable')
  ) then
    return query select 'order_blocked'::text, null::uuid, r.state, v_status, false;
    return;
  end if;

  if r.answers_hash <> p_answers_hash then
    return query select 'review_stale'::text, null::uuid, r.state, v_status, false;
    return;
  end if;

  -- The four-eyes rule. `settings -> 'distinctCheckers' = 'true'` is false for a missing key and never a cast error.
  select coalesce(f.settings -> 'distinctCheckers' = 'true'::jsonb, false) into v_distinct
  from form_review_settings f where f.form_id = v_form and f.org_id = v_org;
  if v_user = r.maker_user_id or v_user = r.last_editor_id or v_user = any (r.excluded_user_ids)
     or (coalesce(v_distinct, false) and exists (
           select 1 from review_decisions x
           where x.submission_id = p_submission_id and x.submission_received_at = p_received_at and x.decided_by = v_user and x.unit_id <> p_unit_id)) then
    return query select 'four_eyes_violation'::text, null::uuid, r.state, v_status, false;
    return;
  end if;

  -- Past every check: write the decision and move the unit. A repeated p_decision_id fails the primary key (23505) and
  -- rolls everything back.
  insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, reason_code,
    decided_by, answers_hash, form_version_id, idempotency_key)
  values (p_decision_id, v_org, v_form, p_submission_id, p_received_at, p_unit_id, r.round, p_decision, p_reason_code,
    v_user, p_answers_hash, v_version, p_idempotency_key);
  v_state := case p_decision when 'approve' then 'approved' else 'rejected' end;
  update submission_reviews x set state = v_state, rev = x.rev + 1, updated_at = now()
  where x.submission_id = p_submission_id and x.submission_received_at = p_received_at and x.unit_id = p_unit_id;

  -- The response is final when a required unit is rejected, or when every required applicable unit is approved AND an
  -- approval of the current round names the unit's current answers_hash (a unit whose answers changed since is not approved).
  if p_decision = 'reject' and r.required then
    v_final := 'rejected';
  elsif not exists (
    select 1 from submission_reviews x
    where x.submission_id = p_submission_id and x.submission_received_at = p_received_at and x.required and x.state <> 'not_applicable'
      and not (x.state = 'approved' and exists (
        select 1 from review_decisions y
        where y.submission_id = x.submission_id and y.submission_received_at = x.submission_received_at and y.unit_id = x.unit_id
          and y.round = x.round and y.decision = 'approve' and y.answers_hash = x.answers_hash))
  ) then
    v_final := 'complete';
  end if;

  if v_final is not null then
    -- Nobody is asked about what is left: the units of a rejected response, and the optional ones of a completed one.
    update submission_reviews x set state = 'closed', rev = x.rev + 1, updated_at = now()
    where x.submission_id = p_submission_id and x.submission_received_at = p_received_at and x.state = 'pending';
    -- The trigger of 0022 lets this through because the function runs as the table's owner.
    update submissions s set status = v_final, revision = s.revision + 1, updated_at = now()
    where s.id = p_submission_id and s.received_at = p_received_at and s.status = 'pending_review';
  end if;

  return query select 'decided'::text, p_decision_id, v_state, coalesce(v_final, v_status), false;
end
$$;
revoke all on function review_decide(uuid, timestamptz, text, text, text, bytea, text, uuid) from public;
grant execute on function review_decide(uuid, timestamptz, text, text, text, bytea, text, uuid) to fr_app;
