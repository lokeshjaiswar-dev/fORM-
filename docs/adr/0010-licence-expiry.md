# ADR-0010: On-prem licence expiry blocks authoring, never collection or export

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** licence and editions in Phase 1 (architecture §9); `@form/config` holds licence verification (WP-0.15 shaped the edition config)

## Context

On-prem installs carry a licence; SaaS has none (plans and quotas live in the database). Installs may be air-gapped, so the licence must verify offline. Customer orgs are Data Fiduciaries for their forms: if an expired licence stopped live forms or locked data away, the customer could not meet its own obligations to respondents (collection in progress, DSR exports, retention). See [`docs/platform/03-architecture.md` §1.5](../platform/03-architecture.md).

## Decision

1. The licence is a **compact JWS (EdDSA)** verified offline against public keys baked into the image, at boot and every 6 hours. Claims: `{ lid, customer, tier, seats, maxOrgs, features[], nbf, exp, graceDays: 30 }`.
2. **On expiry plus grace, authoring is blocked** (publish, invite, create).
3. **Live forms keep collecting, and data stays readable and exportable.**
4. Licence `features` take part in feature resolution: `effectiveFeatures(org) = editionDefaults ∩ license.features ∩ orgAdminRestrictions` on-prem.

## Consequences

- No code path may make collection, reading or export depend on licence validity.
- SaaS never consults a licence: the same features come from `planFeatures(org.plan)`.
- Security control 23 ("licence and edition safety", SOC 2 A1.2) depends on this rule.

## Links

- Architecture §1.5 (feature resolution, licence), §8 control 23
- Delivery plan [WP-0.15](../platform/04-delivery-plan.md) (edition config), §9 phase map in the architecture (P1 "licence and editions")
