-- Respondent answers for a form (builder preview and signed-in submit). RLS matches forms.
create table form_submissions (
  id uuid primary key,
  org_id uuid not null,
  form_id uuid not null,
  answers jsonb not null,
  fields jsonb not null default '[]'::jsonb,
  locale text not null default 'en-IN',
  submitted_at timestamptz not null default now(),
  constraint form_submissions_form_fkey foreign key (org_id, form_id) references forms (org_id, id)
);
create index form_submissions_form_idx on form_submissions (org_id, form_id, submitted_at desc);
alter table form_submissions enable row level security;
alter table form_submissions force row level security;
create policy form_submissions_tenant on form_submissions for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, update, delete on form_submissions to fr_app;
