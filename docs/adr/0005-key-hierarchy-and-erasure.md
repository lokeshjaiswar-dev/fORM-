# ADR-0005: Key hierarchy, and erasure as deletion plus backup expiry

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work package:** WP-1.11 (feature matrix rows CMP-07, CMP-08; CMP-17 for org deletion)

## Context

Sensitive answers, tainted computed values, files in sensitive fields and secrets must be encrypted at field level, in every edition, with a KMS, Vault transit or a keyfile behind the `KeyProvider` port. The first plan claimed that deleting a key "crypto-shreds" data. The compliance review showed that claim was false: the wrapped keys sit inside the 35-day point-in-time backups, and the regional root key can still unwrap them (C-M1, F-31). See [`docs/platform/03-architecture.md` §2.6](../platform/03-architecture.md).

## Decision

1. **Three levels:** KMS root key (one per region on SaaS; Vault transit key or keyfile master key on-prem) → a random 256-bit **org KEK**, stored wrapped in `org_data_keys(purpose = 'kek')` → **DEKs per (org, purpose, version)** for `answers`, `files`, `secrets`, `bidx` (HMAC key) and `statutory`, wrapped with AES-256-GCM in the app. One KMS call unwraps the org KEK (cached 5 minutes); DEKs unwrap locally.
2. **Field encryption:** `EncryptedAnswer { alg: 'A256GCM', kid, iv, ct = AES-GCM(JCS(value)), aad = submissionId:blockId }`; `EncryptedScalar` for tainted derived values.
3. **Erasure is deletion.** A record, field or org is erased by deleting rows and objects, and **erasure completes when the backups that contain the data expire (≤ 35 days)**. This is stated in the DPA, in DSR responses and in the deletion certificate (method and backup-expiry date).
4. **No crypto-shredding claim in P1–P2.** Real crypto-shredding needs a per-org root key held outside Postgres (BYOK, a per-org KMS key or a Vault transit key), offered at Enterprise in P3 (decision D18).
5. Blind indexes are `HMAC-SHA256(bidxKey_org, normalize(value))` truncated to 16 bytes, equality only. Rotation (`kms.rotate`) creates a new DEK version and keeps old versions for decryption.

## Consequences

- WP-1.11's acceptance tests that a backup taken after an erasure holds no recoverable copy and that the restore drill shows earlier backups expire within 35 days, instead of testing a shred.
- Product, DPA and certificate wording avoid "crypto-shred"; schema comments say deleting a DEK is not erasure while backups hold it.
- Every unwrap is metered; KMS audit trails are SOC 2 evidence.

## Links

- Architecture §2.4 (`org_data_keys`, `secrets`), §2.6, §7.6 (backups, PITR 35 days), §8 control 6
- Delivery plan [WP-1.11](../platform/04-delivery-plan.md), decision D18 (§9)
- Review log [C-M1, F-31](../platform/05-review-log.md)
- Related: [ADR-0014](0014-statutory-hold-store.md) (the `statutory` DEK)
