-- The pictures a published form uses (image choices, cover, background), keyed by the asset id the definition names.
-- The builder keeps them in the browser; publish now stores the ones the form uses next to the immutable version,
-- so the public page shows them on any device. Written once, with the version row (nullable: older versions have none).
alter table form_versions add column media jsonb;
