-- What a respondent uploaded to a published form: who it belongs to, so a download can be checked against the org.
-- The bytes are in the file store (the local filesystem until the StoragePort/S3 adapter, WP-1.14); this row is the
-- ownership record and the only way to find them. The id is the server's (a uuid), never the client's. RLS matches
-- forms: a member of another org sees no row, so cannot ask for the bytes.
create table form_files (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  block_id text not null,
  name text not null,
  mime text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null,
  created_at timestamptz not null default now(),
  constraint form_files_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
create index form_files_form_idx on form_files (org_id, form_id, created_at desc);
alter table form_files enable row level security;
alter table form_files force row level security;
create policy form_files_tenant on form_files for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
-- Files are never edited: no update.
grant select, insert, delete on form_files to fr_app;
