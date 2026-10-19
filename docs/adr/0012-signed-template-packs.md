# ADR-0012: Template packs are signed `.formpack` files baked into the image and seeded by a dedicated role

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-T0.3 (pack build, TPL-02), WP-T1.2 (seeding, TPL-05), WP-0.13 (role `fr_template_seeder`)

## Context

System templates must ship to SaaS, on-prem and air-gapped installs alike, without network access, and an import must be able to tell a genuine pack from a tampered one. System template rows have `org_id IS NULL`; ordinary request traffic must not be able to write them. See [`docs/platform/06-templates.md` §8](../platform/06-templates.md) and [`docs/platform/03-architecture.md` §2.1](../platform/03-architecture.md).

## Decision

1. **System templates are authored as data** in `packages/templates/src/**` and built by `pnpm templates:build` into `system-core-<ver>.formpack`: a zip with `manifest.json`, the template payloads, `categories.json`, optional `attestations.json`, assets and `signature.json`.
2. **The manifest lists the sha256 of every file** (categories and attestations included, ADR-0002 §3), and `signature.json` is `{ alg, keyId, sig: base64(sign(JCS(manifest))) }`, so one signature covers the bundle. The algorithm is per key id: Ed25519 by default, ES256 where the signing KMS cannot do Ed25519.
3. **The pack is baked into the `fr-server` image** (`/opt/form/packs/`) and the air-gapped bundle.
4. **The worker job `templates.seed` runs as `fr_template_seeder`**, which writes only `org_id IS NULL` rows in the template tables, verifies the pack against the trust store and upserts it. No network access is needed.
5. Release packs are signed with the release key held in CI KMS; P0 uses a development key.

## Consequences

- Import verifies the signature and every hash and rejects a mismatch; unsigned bundles land only as drafts and only if `allowUnsignedImport`.
- Phase 0 as built (WP-T0.3): the builder bundles the pack and verifies it with the public development key `fORM-dev-2026`. A real release key is required before any release build (BL-116, owner WP-T1.2).
- Pack bytes are reproducible: the zip entries carry a fixed timestamp built in local time, so the same inputs give the same bytes in every time zone, and a test pins the system-core pack's sha256 (BL-119).
- Industry packs are separate signed packs, enabled per plan on SaaS and shipped as files on-prem; Helm `templates.trustedKeys` adds customer keys.

## Links

- Templates spec §5.2 (`tpl_seed` policies), §8.1 (bundle format), §8.2 (system packs and air-gapped)
- Architecture §2.1 (`fr_template_seeder`), §7.1 (images), §8 control 22
- Delivery plan [WP-T0.3, WP-T1.2](../platform/04-delivery-plan.md)
- [`packages/templates/README.md`](../../packages/templates/README.md)
- Related: [ADR-0002 §3](0002-phase0-batch2-decisions.md)
