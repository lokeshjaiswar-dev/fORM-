# ADR-0015: RLS tenancy model; cross-org work only through named definer functions and `fr_system_agg`

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-0.13 (built: roles, helpers, `withTenant`, `parts`, definer functions, meta-tests; feature matrix rows FND-15, CMP-01), WP-1.02 (RLS on every new table, isolation-suite generator)

## Context

Tenant isolation is enforced by the database: every tenant table has `org_id` and an RLS policy, and the app role cannot bypass RLS. The feasibility review found that this alone made some work impossible and some policies unsafe:

- org-spanning jobs (retention sweeps, rollups, partition maintenance) and "list my orgs" cannot run inside one tenant context (F-1);
- partitions created the usual way bypass the parent's policies (F-2);
- policies that cast `current_setting('app.user_id')::uuid` raise for actors without a user id (API keys, jobs, respondents), and unset settings raise without `missing_ok` (F-3);
- a respondent context could read every submission in the org (C-M8, F-22).

See [`docs/platform/03-architecture.md` §0 principle 3 and §2.1–2.3](../platform/03-architecture.md).

## Decision

1. **Roles.** `fr_migrator` owns the schema and the definer functions and is never used by request traffic. `fr_app` (api, worker, runtime) is `NOBYPASSRLS`, with DML on tenant tables and no `UPDATE`/`DELETE` on append-only tables. `fr_template_seeder` writes only `org_id IS NULL` template rows. `fr_system_agg` (separate secret and pool) is `BYPASSRLS` with **SELECT only** on rollup sources and INSERT on rollup tables, and no access to answers. `fr_platform` exists only while a break-glass grant is active.
2. **Tenant context per transaction.** `withTenant(db, ctx, fn)` opens a transaction and sets `app.org_id`, `app.user_id`, `app.team_ids`, `app.perms`, `app.actor_kind` (`user | api_key | respondent | system | platform`), `app.subject_ids` and `app.request_id` with `set_config(…, true)`, which is transaction-scoped and safe behind PgBouncer in transaction mode. A query outside `withTenant()` sees zero rows.
3. **Null-safe helpers in every policy.** Policies use `app_org()`, `app_user()`, `app_perms()`, `app_teams()`, `app_actor()` and `app_subject_ids()`, wrapped in sub-selects (`(select app_org())`), never `current_setting(…)::uuid` directly. `FORCE ROW LEVEL SECURITY` on every tenant table; the standard policy is `org_id = (select app_org())` for USING and WITH CHECK.
4. **Respondent subject scoping.** Submission data has an extra restrictive policy: `system` actors, holders of `submissions.read`, or a respondent context whose `app.subject_ids` (set only after a signed token was verified) contains the row id. By default a respondent can only INSERT. The same pattern applies to `partial_submissions`, `consent_records` and `submission_files`.
5. **Partitions in schema `parts`** with no grants to `fr_app` and forced RLS on each partition ([ADR-0004](0004-submission-partitioning.md)).
6. **Cross-org work only through named `SECURITY DEFINER` functions** owned by `fr_migrator`, with `SET search_path = pg_catalog, public`, EXECUTE granted narrowly and each data-touching call audited: `resolve_slug`, `auth_user_by_email`, `auth_session`, `api_key_lookup`, `invite_by_token`, `list_user_orgs`, `membership_for`, `orgs_due_for`, `resolve_job_org`, `create_partitions`, `consent_pseudonymise`, `org_purge`, `statutory_hold_move` / `statutory_hold_purge` and `template_for_binding`. Org-spanning jobs call `orgs_due_for(job)` and then run one `withTenant` per org.
7. **Cross-tenant aggregates only through `fr_system_agg`** (for example `templates.stats`, with at least 5 distinct orgs before a system template's stats are shown).
8. **Meta-tests** read the catalogue and fail if a `public` table with `org_id` lacks forced RLS or a `*_tenant` policy, if a partition grants anything to a role other than its owner or lacks forced RLS, or if any policy text contains `current_setting(` outside the helpers. Isolation tests run for every actor kind.

## Consequences

- Authorisation inside a tenant (roles, teams, per-form sharing) stays in the app layer, with RLS as a second check for data access.
- Foreign ids return 404, never 403.
- A new cross-org need means a new, reviewed definer function, not a new privileged connection.
- WP-1.02 as built (migration `0008_orgs.sql`): `create_org`, `invite_by_token`, `invite_accept`, `member_sessions_revoke` and `member_access_token`; `membership_for` returns the role with the permissions org settings grant on top of it. Restrictive policies repeat the API's role checks for member changes, org settings and draft writes. The isolation suite is generated per table and actor kind from one registry (`packages/db/test/rls.int.test.ts`), which must list every table in `public`.
- Phase 0 as built (WP-0.13, migrations `0001_foundation.sql` to `0004_audit.sql`): the helpers, roles, `withTenant`, schema `parts`, `list_user_orgs`, `membership_for`, `orgs_due_for`, `resolve_job_org`, `create_partitions` and the RLS meta-tests; `pnpm test:int` runs them against Postgres 18 in Testcontainers (CI job `db`). The other functions arrive with the WPs that need them.

## Links

- Architecture §0 principle 3, §2.1, §2.2, §2.3, §5.1 (org-spanning jobs), §8 controls 1 and 2
- Templates spec [§5.2](../platform/06-templates.md) (template policies, `template_for_binding`, `fr_system_agg` stats)
- Delivery plan [WP-0.13, WP-1.02](../platform/04-delivery-plan.md)
- Review log [F-1, F-2, F-3, C-M8, F-22](../platform/05-review-log.md)
- Related: [ADR-0016](0016-signed-job-envelope.md) (jobs re-derive their org)
