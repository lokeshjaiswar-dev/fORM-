-- In-house authentication (ADR-0017, WP-1.01): server-side sessions, OAuth identities, single-use auth tokens
-- (email verification, magic links, password resets, MFA tickets) and the auth throttle. Identity rows are
-- the user's own, not an org's: the policies key on app_user() for a user actor. Lookups before a session
-- exists (login, token redemption, session lookup) go through the narrow definer functions below.

-- The last TOTP time step accepted, so a code cannot be replayed within its window.
alter table users add column totp_last_step bigint;
grant select (totp_enabled_at, totp_last_step) on users to fr_app;
grant update (password_hash, totp_secret_enc, totp_enabled_at, totp_last_step, recovery_code_hashes, email_verified_at, last_login_at)
  on users to fr_app;

-- The credential columns change only in the user's own context (withUser, no org) or inside a definer function, never
-- from an org-scoped transaction: a bug in a business route cannot turn TOTP off or mark an address verified.
create function users_credentials_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if current_user = 'fr_app' and app_org() is not null and (
    new.password_hash is distinct from old.password_hash or new.totp_secret_enc is distinct from old.totp_secret_enc
    or new.totp_enabled_at is distinct from old.totp_enabled_at or new.totp_last_step is distinct from old.totp_last_step
    or new.recovery_code_hashes is distinct from old.recovery_code_hashes or new.email_verified_at is distinct from old.email_verified_at
  ) then
    raise exception 'users: credential columns cannot change in an org context' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger users_credentials_guard before update on users for each row execute function users_credentials_guard();

-- Opaque tokens in the __Host-fr_sess cookie; only their SHA-256 is stored. 12 h idle, 14 d absolute.
create table sessions (
  id uuid primary key,
  token_hash bytea not null unique check (length(token_hash) = 32),
  user_id uuid not null references users (id),
  active_org_id uuid references orgs (id),
  mfa_level text not null check (mfa_level ~ '^(pwd|link|oauth|sso)(\+(totp|recovery))?$'),
  ip_hash bytea,
  ua_summary text check (length(ua_summary) <= 200),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('logout', 'rotated', 'revoked', 'password_reset', 'mfa_enabled', 'mfa_disabled')),
  check (idle_expires_at <= absolute_expires_at)
);
create index sessions_user_id_idx on sessions (user_id);
alter table sessions enable row level security;
alter table sessions force row level security;
create policy sessions_self on sessions for all to fr_app
  using (user_id = (select app_user()) and (select app_actor()) = 'user')
  with check (user_id = (select app_user()) and (select app_actor()) = 'user');
grant select (id, user_id, active_org_id, mfa_level, ua_summary, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoked_reason)
  on sessions to fr_app;
grant insert on sessions to fr_app;
grant update (revoked_at, revoked_reason) on sessions to fr_app;

-- Revocation and redemption are final, for every role: a bug cannot bring back a signed-out session or a used link.
create function sessions_revoked_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason) then
    raise exception 'sessions: a revoked session stays revoked' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger sessions_revoked_guard before update on sessions for each row execute function sessions_revoked_guard();

-- Google and Microsoft accounts linked to a user (P1; SSO through Jackson and LDAP arrive in P3).
create table user_identities (
  id uuid primary key,
  user_id uuid not null references users (id),
  provider text not null check (provider in ('google', 'microsoft')),
  subject text not null check (length(subject) between 1 and 255),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (provider, subject)
);
create index user_identities_user_id_idx on user_identities (user_id);
alter table user_identities enable row level security;
alter table user_identities force row level security;
create policy user_identities_self on user_identities for all to fr_app
  using (user_id = (select app_user()) and (select app_actor()) = 'user')
  with check (user_id = (select app_user()) and (select app_actor()) = 'user');
grant select, insert, delete on user_identities to fr_app;
grant update (last_used_at) on user_identities to fr_app;

-- Single-use tokens sent by email, and the 5-minute ticket between the first factor and TOTP. SHA-256 only.
create table auth_tokens (
  id uuid primary key,
  token_hash bytea not null unique check (length(token_hash) = 32),
  purpose text not null check (purpose in ('verify_email', 'magic_link', 'password_reset', 'mfa')),
  user_id uuid not null references users (id),
  data jsonb not null default '{}',
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_user_purpose on auth_tokens (user_id, purpose);
alter table auth_tokens enable row level security;
alter table auth_tokens force row level security;
create policy auth_tokens_self on auth_tokens for all to fr_app
  using (user_id = (select app_user()) and (select app_actor()) = 'user')
  with check (user_id = (select app_user()) and (select app_actor()) = 'user');
grant select (id, purpose, user_id, expires_at, consumed_at, created_at) on auth_tokens to fr_app;
grant insert on auth_tokens to fr_app;
grant update (consumed_at) on auth_tokens to fr_app;
create function auth_tokens_consumed_guard() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'auth_tokens: a used token stays used' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger auth_tokens_consumed_guard before update on auth_tokens for each row execute function auth_tokens_consumed_guard();

-- Fixed-window counters for the auth_* buckets (architecture §3.5), keyed by a keyed hash, never an IP or address.
-- fr_app has no privilege on the table: auth_throttle_hit() is the only way in.
create unlogged table auth_throttle (
  bucket text not null,
  key bytea not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (bucket, key, window_start)
);
alter table auth_throttle enable row level security;
alter table auth_throttle force row level security;
create policy auth_throttle_none on auth_throttle for all to fr_app using (false) with check (false);

-- Login, sign-up and reset: the user behind an address, with what the first factor needs. Never the TOTP secret.
create function auth_user_by_email(p_email_norm text)
returns table (id uuid, email text, name text, status text, email_verified_at timestamptz, password_hash text, totp_enabled_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public as $$
  select u.id, u.email, u.name, u.status, u.email_verified_at, u.password_hash, u.totp_enabled_at
  from users u where u.email_norm = p_email_norm
$$;

-- The second factor and credential changes, once the first factor or a session named the user.
create function auth_user_credentials(p_user_id uuid)
returns table (id uuid, email text, name text, status text, email_verified_at timestamptz, password_hash text,
  totp_secret_enc jsonb, totp_enabled_at timestamptz, totp_last_step bigint, recovery_codes_left integer)
language sql stable security definer set search_path = pg_catalog, public as $$
  select u.id, u.email, u.name, u.status, u.email_verified_at, u.password_hash, u.totp_secret_enc, u.totp_enabled_at,
    u.totp_last_step, coalesce(cardinality(u.recovery_code_hashes), 0)
  from users u where u.id = p_user_id
$$;

-- Sign-up and first OAuth sign-in. False when the address is taken; the caller answers the same either way.
create function auth_create_user(p_id uuid, p_email text, p_email_norm text, p_name text, p_locale text,
  p_password_hash text, p_email_verified boolean)
returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
begin
  if p_email_norm is null or p_email_norm <> lower(p_email_norm) or position('@' in p_email_norm) < 2 then
    raise exception 'auth_create_user: email_norm must be a lower-case address' using errcode = 'invalid_parameter_value';
  end if;
  insert into users (id, email, email_norm, name, locale, password_hash, email_verified_at)
  values (p_id, p_email, p_email_norm, p_name, p_locale, p_password_hash, case when p_email_verified then now() end)
  on conflict (email_norm) do nothing;
  return found;
end
$$;

-- A recovery code is good once: removed when it matches. Null when it does not, or when TOTP is off.
create function auth_recovery_code_use(p_user_id uuid, p_code_hash text)
returns integer
language sql volatile security definer set search_path = pg_catalog, public as $$
  update users u set recovery_code_hashes = array_remove(u.recovery_code_hashes, p_code_hash)
  where u.id = p_user_id and u.totp_enabled_at is not null and p_code_hash = any (u.recovery_code_hashes)
  returning coalesce(cardinality(u.recovery_code_hashes), 0)
$$;

-- The user an OAuth account is linked to, or no row.
create function auth_identity_user(p_provider text, p_subject text)
returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select i.user_id from user_identities i where i.provider = p_provider and i.subject = p_subject
$$;

-- Redeems a single-use token: no row when it is unknown, used, expired or for another purpose.
create function auth_token_take(p_token_hash bytea, p_purpose text)
returns table (user_id uuid, data jsonb)
language sql volatile security definer set search_path = pg_catalog, public as $$
  update auth_tokens t set consumed_at = now()
  where t.token_hash = p_token_hash and t.purpose = p_purpose and t.consumed_at is null and t.expires_at > now()
  returning t.user_id, t.data
$$;

-- Who an emailed link is for, without using it up: the builder shows the address before the click that redeems it.
create function auth_token_peek(p_token_hash bytea, p_purpose text)
returns table (user_id uuid, email text, email_verified boolean, has_password boolean)
language sql stable security definer set search_path = pg_catalog, public as $$
  select u.id, u.email, u.email_verified_at is not null, u.password_hash is not null
  from auth_tokens t join users u on u.id = t.user_id
  where t.token_hash = p_token_hash and t.purpose = p_purpose and p_purpose in ('verify_email', 'magic_link')
    and t.consumed_at is null and t.expires_at > now() and u.status = 'active'
$$;

-- One attempt at an MFA ticket; five per ticket. The ticket is consumed with auth_token_take() on success.
create function auth_mfa_ticket(p_token_hash bytea)
returns table (user_id uuid, data jsonb, attempts integer)
language sql volatile security definer set search_path = pg_catalog, public as $$
  update auth_tokens t set attempts = t.attempts + 1
  where t.token_hash = p_token_hash and t.purpose = 'mfa' and t.consumed_at is null and t.expires_at > now() and t.attempts < 5
  returning t.user_id, t.data, t.attempts
$$;

-- The session behind a cookie and its state. An active session slides its idle expiry at most once a minute.
create function auth_session(p_token_hash bytea, p_idle_seconds integer)
returns table (session_id uuid, user_id uuid, state text, mfa_level text, active_org_id uuid, created_at timestamptz,
  idle_expires_at timestamptz, absolute_expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  s sessions%rowtype;
  v_state text;
  v_user_status text;
begin
  if p_idle_seconds is null or p_idle_seconds < 60 or p_idle_seconds > 86400 then
    raise exception 'auth_session: idle seconds must be between 60 and 86400' using errcode = 'invalid_parameter_value';
  end if;
  select * into s from sessions where token_hash = p_token_hash;
  if not found then
    return;
  end if;
  select u.status into v_user_status from users u where u.id = s.user_id;
  v_state := case
    when s.revoked_at is not null then 'revoked'
    when s.absolute_expires_at <= now() or s.idle_expires_at <= now() then 'expired'
    when v_user_status is distinct from 'active' then 'user_inactive'
    else 'active' end;
  if v_state = 'active' and s.last_seen_at < now() - interval '1 minute' then
    update sessions set last_seen_at = now(), idle_expires_at = least(now() + make_interval(secs => p_idle_seconds), absolute_expires_at)
    where id = s.id returning * into s;
  end if;
  return query select s.id, s.user_id, v_state, s.mfa_level, s.active_org_id, s.created_at, s.idle_expires_at, s.absolute_expires_at;
end
$$;

-- Counts one hit in the current fixed window and returns the window's total; earlier windows of the key go.
create function auth_throttle_hit(p_bucket text, p_key bytea, p_window_seconds integer)
returns table (hits integer, window_ends timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, public as $$
#variable_conflict use_column
declare
  v_start timestamptz;
begin
  if p_bucket is null or p_bucket !~ '^auth_[a-z_]+$' then
    raise exception 'auth_throttle_hit: unknown bucket %', p_bucket using errcode = 'invalid_parameter_value';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'auth_throttle_hit: window must be between 1 and 86400 seconds' using errcode = 'invalid_parameter_value';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  delete from auth_throttle t where t.bucket = p_bucket and t.key = p_key and t.window_start < v_start;
  return query
    insert into auth_throttle as t (bucket, key, window_start, hits) values (p_bucket, p_key, v_start, 1)
    on conflict (bucket, key, window_start) do update set hits = t.hits + 1
    returning t.hits, t.window_start + make_interval(secs => p_window_seconds);
end
$$;

grant execute on function auth_user_by_email(text), auth_user_credentials(uuid),
  auth_create_user(uuid, text, text, text, text, text, boolean), auth_recovery_code_use(uuid, text),
  auth_identity_user(text, text), auth_token_take(bytea, text), auth_token_peek(bytea, text), auth_mfa_ticket(bytea), auth_session(bytea, integer),
  auth_throttle_hit(text, bytea, integer) to fr_app;
