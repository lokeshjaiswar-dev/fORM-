# ADR-0006: Audit through `audit_pending`, denied events on a separate connection, a per-org chain worker

- **Status:** Accepted (revised in the v1.1 planning set)
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-1.04 (feature matrix row CMP-02); placeholders in WP-0.13, denied job records in WP-0.14

## Context

The audit log must be append-only, tamper-evident and complete, including every submission read and every denied or failed attempt (SOC 2 CC7.2, DPDP Rule 6). The first design wrote a hash-chained row inside the business transaction. Reviews found two problems: denied and failed actions roll back with the transaction and are never recorded (C-M7), and a per-org chain head locked inside every business transaction serialises all audited work in one org and cannot be written from read-only GETs (F-21). See [`docs/platform/03-architecture.md` §2.7](../platform/03-architecture.md).

## Decision

1. **Successful actions insert into `audit_pending` inside the business transaction**, so the record commits or rolls back with the change. Audited reads open read-write transactions for this one insert.
2. **Denied and failed actions are written through a separate connection** in their own transaction, so they survive the rollback of the business transaction. A test asserts that a 403 produces an audit row.
3. **A per-org chain worker** (`audit.chain`, one singleton consumer per org key) moves pending rows into `audit_log` within seconds: it locks the head, computes `hash = sha256(prev_hash ‖ JCS(event ∪ {seq, occurred_at}))`, inserts and advances the head. A `BEFORE INSERT` trigger rejects rows that do not continue the head. Business transactions never hold the head lock.
4. **Signed checkpoints:** hourly `audit.checkpoint` signs each org head with the platform audit key (app-held Ed25519 wrapped by the KMS, or ES256 where a KMS-native signature is required) and writes it to `audit_checkpoints` and to the `audit` bucket with Object Lock when the store supports it; otherwise checkpoints are forwarded to the customer's syslog or SIEM (`AuditSink`). `audit.verify` runs daily.
5. **Immutability:** `REVOKE UPDATE, DELETE, TRUNCATE` on `audit_log` and `audit_pending` (except the chain worker's delete of moved rows through a definer function) plus raise-on-update triggers. No answer values ever enter `metadata`.

## Consequences

- Audited actions in one org do not serialise; chain lag is a metric with an alert at 1 minute.
- WP-0.14 already uses the separate-connection rule: a rejected job envelope gets a `job.rejected` denied record on its own connection.
- Retention is 13 months online, then NDJSON.zst exports with checkpoints into the WORM bucket (7 years by default).

## Links

- Architecture §2.7, §5.2 (`audit.*` queues), §6 (`AuditSink`), §8 control 14
- Delivery plan [WP-1.04](../platform/04-delivery-plan.md)
- Review log [C-M7, C-M9, F-21](../platform/05-review-log.md)
