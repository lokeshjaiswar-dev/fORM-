-- Server-assigned serials for unique_id fields (FLD-32): one counter per form, field and reset period.
-- `period` is '' when the field never resets, 'YYYY' when it resets every year and 'YYYY-MM' every month, read in
-- the form's time zone. A new period starts a new row, so a reset needs no clean-up job.
create table form_serial_counters (
  org_id uuid not null,
  form_id uuid not null,
  block_id text not null,
  period text not null,
  last_value bigint not null,
  updated_at timestamptz not null default now(),
  constraint form_serial_counters_pkey primary key (org_id, form_id, block_id, period),
  constraint form_serial_counters_form_fkey foreign key (org_id, form_id) references forms (org_id, id),
  constraint form_serial_counters_value_check check (last_value >= 0),
  constraint form_serial_counters_period_check check (period ~ '^([0-9]{4}(-[0-9]{2})?)?$')
);
alter table form_serial_counters enable row level security;
alter table form_serial_counters force row level security;
create policy form_serial_counters_tenant on form_serial_counters for all to fr_app
  using (org_id = (select app_org())) with check (org_id = (select app_org()));
grant select, insert, update, delete on form_serial_counters to fr_app;
