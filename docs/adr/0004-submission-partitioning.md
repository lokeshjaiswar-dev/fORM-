# ADR-0004: Submissions partitioned monthly in an ungranted `parts` schema

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-0.13 (schema `parts`, `create_partitions`), WP-0.14 (`partitions.maintain`), WP-1.12 (submission pipeline)

## Context

Submissions are the largest and most sensitive table. Grid views, exports and retention are time-bounded, and VACUUM and index size must stay manageable. The feasibility review found that partitions created the usual way can be queried directly and bypass the parent's RLS policies (F-2), that imports of historic submissions clash with a time-derived partition key (F-28), and that the submit transaction held the hot per-form counter lock for too long (F-20). See [`docs/platform/03-architecture.md` §2.4 and §2.5](../platform/03-architecture.md).

## Decision

1. **Monthly range partitions on `received_at`**, where `received_at = uuid_v7_ts(id)` (a CHECK constraint): the partition is bound to the uuidv7 id, and lookups by id add `received_at = uuid_v7_ts($id)` (`submissionKey(id)`) to touch one partition.
2. **Partitions live in schema `parts`**, created by the definer function `create_partitions()` (worker cron `partitions.maintain`, three months ahead). `fr_app` has no privileges on `parts`, so partitions are reachable only through the RLS-protected parent; each partition also has RLS enabled and forced as a second guard.
3. **There is never a default partition for data.** A row outside existing partitions fails loudly.
4. **Imports** get a fresh uuidv7 at import time and keep the historic date in `meta.originalSubmittedAt`; no historic partitions are needed.
5. **Idempotency lives in a side table.** The submit transaction inserts into `submission_idempotency` first (`ON CONFLICT DO NOTHING RETURNING`), so a replay returns the stored result before anything is counted.
6. **Counters are updated last.** Work that does not need the transaction (evaluation, validation, encryption, blind indexes) runs outside it; `form_counters` and `form_id_counters` are the final statements before commit, so the per-form row lock is held only for the commit.
7. Time partitioning, not hash by org. Retention never drops whole partitions (retention differs per form); empty partitions older than the longest possible retention plus 30 days are detached and dropped.

## Consequences

- RLS meta-tests fail if any partition (`pg_inherits` child) grants a privilege to a role other than its owner or lacks forced RLS, and a direct `SELECT` on a partition as `fr_app` must fail with "permission denied" (built in WP-0.13).
- The same scheme is used for `submission_search`, `audit_log`, `email_messages`, `webhook_deliveries` (monthly) and `analytics_events` (daily).
- One form sustains roughly 500 to 1,000 submits/s on one primary, to be confirmed by the WP-1.28 load test.

## Links

- Architecture §2.1 (definer functions), §2.3 (meta-tests), §2.4 (submissions, satellite tables), §2.5 (submit path), §5.2 (`partitions.maintain`)
- Delivery plan [WP-0.13, WP-0.14, WP-1.12](../platform/04-delivery-plan.md)
- Review log [F-2, F-20, F-28](../platform/05-review-log.md)
- Related: [ADR-0015](0015-rls-tenancy-and-definer-functions.md)
