# fORM- platform plan

This folder is the plan for turning fORM- (today a front-end-only form builder, about 3.3k lines at commit `e1be409`) into a multi-tenant SaaS and on-prem form platform that matches JotForm feature for feature, with SOC 2 and India DPDP compliance built in.

**Status:** v1.1, after two adversarial reviews (compliance, and feasibility/consistency). Every finding and its resolution is in `05-review-log.md`.

## Documents

| File | What it is | Read it when |
|---|---|---|
| [`01-feature-matrix.md`](01-feature-matrix.md) | 386 counted feature rows in 25 domains, each with JotForm behaviour, what fORM- has today, phase and complexity | You need to know what "feature match" means, or where a feature lands |
| [`02-form-schema-v2.md`](02-form-schema-v2.md) | The single TypeScript contract (type-checked) for forms, logic, answers, submissions, compliance and templates; evaluation semantics; v1 → v2 migration | You build anything that reads or writes a form, an answer or a template |
| [`03-architecture.md`](03-architecture.md) | Monorepo, data model with RLS, API, runtime and embed, jobs, adapters, deployment, security and compliance controls, ADRs | You design or review a component |
| [`04-delivery-plan.md`](04-delivery-plan.md) | Work packages with scope, dependencies, acceptance and size; critical paths; schedule; risks; traceability of all 306 rows; decisions with deadlines | You plan, staff or track the work |
| [`05-review-log.md`](05-review-log.md) | Every review finding and how it was resolved | You want to know why something is the way it is |
| [`06-templates.md`](06-templates.md) | The customizable templates spec: kinds, scopes, variables, brand kits, forks, updates, locks, gallery, packs | You work on templates, the gallery, brand kits or compliance snippets |
| [`backlog.md`](backlog.md) | Open minor reviewer issues from merged work packages (`BL-001`…), each with a suggested fix and an owner WP | You start a WP (pick up its rows) or look for small fixes |

Decisions are ADRs in [`docs/adr/`](../adr/): ADR-0001 and ADR-0003 to ADR-0019 write up the architecture's decisions (architecture §10), ADR-0002 records the Phase 0 batch-2 decisions, and ADR-0020 to ADR-0022 record the rich text, logic engine and field registry decisions.

**How to read them.** Start here, then the matrix summary (end of `01`) for scope. Engineers then read the schema §2–3 and architecture §0–2. Planners read the delivery plan §0–1 and §6. Anyone touching consent, retention or DSR should read architecture §8 and the review log §1. IDs are stable across documents: matrix rows (`FND-03`, `TPL-07`, `CMP-13`), work packages (`WP-0.07`, `WP-T1.4`), decisions (`D1`–`D20`), ADRs (`ADR-0001`–`ADR-0022`), review findings (`C-B1`, `F-24`), backlog items (`BL-001`).

---

## Executive summary

### Target
- **Feature match with JotForm** for mid-market customers: **306 rows** across phases P0–P2 (P0 46, P1 88, P2 172). P3 (enterprise: SSO, SCIM, admin console, locks, BYOK) and P4 (long tail) are outside feature match.
- **Where we go further:** server-enforced logic with no "hidden + required" traps, immutable published versions, field-level encryption, DPDP-native consent, withdrawal and rights tooling, India payments (Razorpay, GST), Indian languages, air-gapped installs, and **customizable templates with lineage**: use, fill variables, save, fork, brand, and receive upstream updates without losing your edits.
- **Deliberate non-goals:** widget, template, gateway and integration catalogue parity; Jotform Tables, Sign and AI agents; native mobile apps; selling themes; features that leak personal data (redirect with POST, per-visit IP logs, public anonymous data links).

### Fixed decisions (not reopened)
One codebase for multi-tenant SaaS and on-prem (including air-gapped); no cloud-only services in core (adapters for S3 storage, SMTP, KMS / Vault / keyfile, pg-boss on Postgres, Postgres FTS); SOC 2 and DPDP Act 2023 + Rules 2025 with the platform as Processor; Node + TypeScript, Fastify 5, Drizzle, Postgres with RLS per `org_id`, pino + OpenTelemetry, Vitest + Testcontainers; pnpm + Turborepo; immutable FormVersions with answers keyed by stable block id; BoxyHQ Jackson for SSO (P3); Stripe + Razorpay.

### Top 10 decisions in this plan
1. **One schema contract (`@form/schema` v2)** shared by builder, runtime, API and worker, with a compiled, acyclic logic plan that the server recomputes; determinism proven in Node, Chromium, Firefox and WebKit.
2. **Monorepo layout frozen in ADR-0001:** `@form/*` scope, `packages/registry`, `ports` + `adapters`, source-only internal packages, dependency-cruiser boundaries.
3. **Database-enforced tenancy:** forced RLS everywhere, partitions in an ungranted schema, null-safe policy helpers, respondent subject scoping, named definer functions and a read-only aggregation role for cross-org work.
4. **Server is the only authority:** hidden, skipped and unconsented answers are never stored; derived values inherit classification (taint) and are encrypted when sensitive.
5. **DPDP duties ship in P1, before the Rules apply (~13 May 2027):** complete notices with a language picker, one-click withdrawal with erasure, grievance and DSR intake with deadlines, children's and guardian consent with real verification, a one-year statutory retention floor, a notice approval gate, CERT-In and breach tooling. A dated gate (2027-05-10) enforces it.
6. **Erasure is deletion plus backup expiry (≤ 35 days)**, stated honestly; real crypto-shredding only with per-org root keys (P3).
7. **React SSR runtime** on a separate registrable domain (SaaS) with a hash-based, cache-safe CSP; proof-of-work captcha by default everywhere; no third-party requests by default.
8. **Audit you cannot lose:** append in the business transaction, denied actions on a separate connection, every submission read logged, per-org hash chain with signed checkpoints to WORM or SIEM.
9. **On-prem is bring-your-own Postgres and S3**, a signed air-gapped bundle with multi-hop upgrades, no AGPL store bundled, nothing phones home; licence expiry never stops collection.
10. **Templates are customizable and governed:** seven kinds, org-profile and brand variables, forks with upstream updates, three-way opt-in updates, signed `.formpack` bundles, P1 compliance starter set, P3 locks.

### Phases and calendar (recommended staffing: 6 engineers, then 8)

| Phase | What ships | Planned effort | Window |
|---|---|---|---|
| **P0 Foundation** | Monorepo, schema v2, registry, logic engine, validation, renderer, safe rich text, template engine and system pack, API/worker skeletons with RLS | 178 ed (~10 wk) | 2026-10-26 → 2027-01-08 |
| **P1 SaaS MVP + on-prem v1** | Auth, orgs, persistence, publish, SSR runtime and embeds, submissions, notifications, webhooks, spam, exports, analytics, all compliance primitives, Helm and air-gapped bundle, SaaS infrastructure in India, templates gallery v1 with save and fork | 510 ed (~21 wk) | 2027-01-11 → **GA 2027-06-04** (DPDP gate 2027-05-10) |
| **P2 Feature match** | Full logic and calculations, all field types, payments, appointments, workflows, integrations and public API, multilingual, Cards layout, submissions collaboration, template catalogue, themes and brand kits, versions and fork updates | 1,058 ed (~33 wk) | 2027-06-07 → **feature match 2028-01-28** |

With 4 engineers feature match moves to about Q1 2029; with 6 throughout, about April 2028.

### Phase 0 work packages, in order
WP-0.01 monorepo move → WP-0.16 cleanup → WP-0.02 tests and CI → WP-0.03 safety hotfixes → WP-0.04 schema v2 → WP-0.12 i18n → WP-0.15 ports → WP-T0.1 template schemas → WP-0.08 rich text → WP-0.06 field registry → WP-0.05 v1→v2 migration → WP-0.07 logic engine → WP-0.13 API + DB + RLS → WP-0.09 validation → WP-0.11a stores and persistence → WP-T0.2 template engine → WP-0.14 worker → WP-0.10 renderer → WP-T0.3 system pack → WP-0.11b builder on registry.

### Open questions for the product owner
1. **D13** SaaS user-content domain name for the runtime and files (must be a separate registrable domain).
2. **D3** Block publishing until a notice is approved (default: block).
3. **D15** Processor→Fiduciary breach SLA: preliminary within 24 h of awareness, or stricter (with counsel).
4. **D18** Offer per-org KMS keys (real crypto-shredding) to top tiers before P3?
5. **Staffing:** approve 6 → 8 engineers for P2, and the translation vendor and counsel budget in P1 (Hindi notices, 22 languages by P2 W4).
6. **D14** Bundle an object store on-prem (SeaweedFS / Ceph RGW after licence review) or stay bring-your-own S3. (Dev and CI already use SeaweedFS instead of MinIO, ADR-0002 §5; that does not decide the bundle.)
7. **D11** Keep optional template parts.
8. **D20** Pursue DigiLocker for guardian verification (commercial terms).
9. **D16 / D17** (with counsel) consent-record retention after erasure; statutory floor default and sectoral minimums.
10. Whether any launch customer needs full Aadhaar capture (Aadhaar Data Vault adapter, currently P4).
