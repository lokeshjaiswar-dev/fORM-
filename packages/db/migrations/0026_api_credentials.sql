-- Server-side lookups (founder 25 Nov 2026, "Proxy + DMS port"): org API credentials.
--
-- An API credential is a `secrets` row of the new kind api_credential: the sealed ApiAuth (bearer, api_key or basic) in
-- `enc`, and what the UI may show in `meta` ({ name, type, header?, host, last4 }). A form's lookup, option list or check
-- names it by `credentialRef.secretId`; the API proxy opens it (a system context) and sends it only over https to the
-- exact host in `meta.host`. The respondent never sees the id, the host or the value.
--
-- Who may do what: org.settings creates, rotates and deletes one (a credential is an org-wide asset, like an SMTP login);
-- forms.edit may LIST the public columns so an author can pick one for a lookup, and can never change one or read `enc`.
-- smtp and webhook_hmac keep the rules of 0023. 0023 is applied and never edited, so the one `for all` policy becomes one
-- policy per command: a select rule that adds forms.edit for api_credential, and write rules that do not.

alter table secrets drop constraint secrets_kind_check;
alter table secrets add constraint secrets_kind_check check (kind in ('smtp', 'webhook_hmac', 'api_credential'));

drop policy secrets_access on secrets;

create policy secrets_access_select on secrets as restrictive for select to fr_app
  using (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[]))
    or (kind = 'api_credential' and ('org.settings' = any ((select app_perms())::text[]) or 'forms.edit' = any ((select app_perms())::text[]))));

create policy secrets_access_insert on secrets as restrictive for insert to fr_app
  with check (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[]))
    or (kind = 'api_credential' and 'org.settings' = any ((select app_perms())::text[])));

create policy secrets_access_update on secrets as restrictive for update to fr_app
  using (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[]))
    or (kind = 'api_credential' and 'org.settings' = any ((select app_perms())::text[])))
  with check (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[]))
    or (kind = 'api_credential' and 'org.settings' = any ((select app_perms())::text[])));

create policy secrets_access_delete on secrets as restrictive for delete to fr_app
  using (
       (select app_actor()) = 'system'
    or (kind = 'smtp' and 'org.settings' = any ((select app_perms())::text[]))
    or (kind = 'webhook_hmac' and 'data.route' = any ((select app_perms())::text[]))
    or (kind = 'api_credential' and 'org.settings' = any ((select app_perms())::text[])));
