# ADR-0014: Statutory retention floor through a restricted hold store with its own DEK

- **Status:** Accepted (the floor default and sectoral minimums are decision D17, with counsel)
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work package:** WP-1.22 (feature matrix rows CMP-06, CMP-23)

## Context

Purpose-based retention and erasure requests can delete data earlier than the law allows: the DPDP Rules and sectoral rules set minimum retention for data, traffic data and logs (one year by default, longer for some sectors, for example PMLA's five years). Keeping that data in the normal tables would leave it searchable, exportable and processable after the principal asked for erasure (C-B3). See [`docs/platform/03-architecture.md` §2.4](../platform/03-architecture.md).

## Decision

1. A **platform statutory floor** (`STATUTORY_RETENTION_FLOOR_DAYS`, default 365, configurable on-prem) applies on top of every retention rule; `RetentionRule` adds `statutory` (may extend) and `inactivity` kinds.
2. Data that is erased or expires within the floor **moves into the `statutory_hold` table** (`payload_enc` under a separate **statutory DEK**, `hold_until`, `reason`) through the definer function `statutory_hold_move()`.
3. Held data has **no search, no export and no processing**. It is readable only with the permission `compliance.statutory_access`, and every read is audited.
4. `statutory_hold_purge()` (daily `statutory.purge`) deletes it at the floor date.
5. Erasure responses state what is restricted and until when.

## Consequences

- `retention.sweep`, `consent.withdrawn` and `dsr.execute` move data into the hold store instead of deleting it when the floor applies.
- The hold store has its own DEK purpose (`statutory`) in the key hierarchy ([ADR-0005](0005-key-hierarchy-and-erasure.md)).
- WP-1.22's acceptance: data erased within the floor lands in the hold store and is unreadable to normal roles, and the floor purge happens on the right date.

## Links

- Architecture §2.1 (`statutory_hold_move` / `statutory_hold_purge`), §2.4 (`statutory_hold`), §5.2 (`retention.sweep`, `statutory.purge`), §8 control 11
- Delivery plan [WP-1.22](../platform/04-delivery-plan.md), decision D17 (§9)
- Review log [C-B3](../platform/05-review-log.md)
