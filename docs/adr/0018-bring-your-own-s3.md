# ADR-0018: On-prem storage is bring-your-own S3; no AGPL object store in the bundle

- **Status:** Accepted (whether to bundle any store is decision D14, default none)
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-1.03 (S3 adapter with `capabilities()`), WP-1.27 (Helm and air-gapped bundle); feature matrix rows FND-17, FND-18

## Context

Object storage sits behind the `Storage` port (S3 API). The first plan bundled MinIO for on-prem. MinIO is AGPL and its community distribution has changed, which puts the on-prem bundle at licensing and supply risk (C-M19, risk R20). Customers also differ in whether their store supports Object Lock, which the audit checkpoints rely on. See [`docs/platform/03-architecture.md` §6 and §7](../platform/03-architecture.md).

## Decision

1. **On-prem, the customer brings an S3-compatible store** (Ceph RGW, NetApp StorageGRID, Dell ECS, cloud S3, or MinIO the customer licenses). External Postgres and external S3 are the Helm chart's default profile.
2. **MinIO is not bundled.** A bundled store stays optional and subject to decision D14 (Apache-2.0 SeaweedFS or Ceph RGW after a licence review).
3. **WORM is a capability check, not an assumption:** `Storage.capabilities()` reports Object Lock, versioning and SSE; without Object Lock, audit checkpoints also go to the customer's syslog or SIEM through `AuditSink`.
4. Images and bundles ship **third-party notices and source offers** for GPL/AGPL components they do contain (ClamAV; any store bundled under D14).

## Consequences

- Dev and CI use SeaweedFS (Apache-2.0) for the S3 API instead of MinIO ([ADR-0002 §5](0002-phase0-batch2-decisions.md)); that does not decide D14 and is not bundled.
- Storage contract tests run against SeaweedFS; the S3 adapter must work with any compliant store.
- Air-gapped installs run the customer's store in-cluster; WP-1.27 tests the bundle under deny-all egress.

## Links

- Architecture §1.4 (supply chain), §6 (port table: Storage, AuditSink), §7.1, §7.3 (Helm state profile), §7.4
- Delivery plan [WP-1.03, WP-1.27](../platform/04-delivery-plan.md), decision D14 and risk R20
- Review log [C-M19](../platform/05-review-log.md)
