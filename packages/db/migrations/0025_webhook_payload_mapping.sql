-- Webhook custom body (INT-01 follow-up): a per-webhook body format (JSON by default, or XML) and an optional payload
-- mapping (dotted paths -> answer/meta sources). A webhook with no mapping and format 'json' sends the standard payload
-- exactly as before. The mapping is only a rearrangement of the answers that disclosableFields already allowed for the
-- webhook; the worker applies it after that filter, never before.
--
-- A new migration: 0023 and 0024 have been applied and are never edited.

alter table webhooks
  add column body_format text not null default 'json' check (body_format in ('json', 'xml')),
  add column payload_mapping jsonb check (payload_mapping is null or (jsonb_typeof(payload_mapping) = 'object' and pg_column_size(payload_mapping) <= 65536));

grant update (body_format, payload_mapping) on webhooks to fr_app;
