-- Anonymous publish is gone (0014, 0015). guest_publish_form() let anyone with the API address create a form, a
-- draft and a live version, filed under "the first active org" with that org's owner as author: a stranger could fill
-- another customer's org with live forms. Publishing goes through POST /v1/forms/:id/publish only (session,
-- membership of the org, `forms.publish`, row-level security). Revoke first, then drop, so no grant outlives either
-- function; a new migration, because 0014 and 0015 have been applied.
revoke execute on function guest_publish_form(uuid, text, text, jsonb, jsonb, jsonb, text, integer, integer, uuid) from fr_app;
revoke execute on function guest_publish_home(uuid) from fr_app;
drop function guest_publish_form(uuid, text, text, jsonb, jsonb, jsonb, text, integer, integer, uuid);
drop function guest_publish_home(uuid);
