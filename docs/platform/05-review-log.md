# Review log

Two adversarial reviews were run on v1.0 of the planning set (feature matrix, templates spec, schema v2, architecture, delivery plan). This log lists every finding and how v1.1 resolves it.

- **Compliance review** (lens: SOC 2, DPDP Act 2023 + Rules 2025, on-prem and air-gapped): 3 blockers (`C-B1`–`C-B3`), 22 major (`C-M1`–`C-M22`), 23 minor (`C-m1`–`C-m23`).
- **Feasibility and consistency review**: 6 blockers, 30 major, 14 minor (`F-1`–`F-50`; F-1–F-6 blockers, F-7–F-36 major, F-37–F-50 minor; F-41–F-48 concern customizable templates).

**Status values:** **Fixed** (change made in the named documents) · **Partly** (main risk addressed, residual noted) · **Deferred** (accepted, scheduled later, with reason) · **Counsel** (fix made, legal confirmation still needed).

Document abbreviations: **M** = `01-feature-matrix.md`, **S** = `02-form-schema-v2.md`, **A** = `03-architecture.md`, **D** = `04-delivery-plan.md`, **T** = `06-templates.md`.

Statutory citations below follow the reviewers and still need counsel's confirmation before the DPA is drafted (Rules 6(1)(e), 7, 8(3), 9, 10–12, 14(3); CERT-In Directions 2022; Aadhaar Act / UIDAI regulations; IT Act s.3A).

---

## 1. Compliance review

### Blockers

| ID | Finding | Resolution | Where | Status |
|---|---|---|---|---|
| C-B1 | Statutory duties (withdrawal, grievance with deadline, verifiable parental consent, notice in Eighth Schedule languages) arrive in P2, after Rules commencement (~13 May 2027) | CMP-05, CMP-10, CMP-13 moved to P1; CMP-04 gains a language picker with en + hi in P1 and a request-another-language workflow; 22 languages by P2 W4; dated **Rules-commencement gate on 2027-05-10** in M1.5 for every tenant processing real data; P1 extended to 21 weeks (GA 2027-06-04) | M (CMP-04/05/10/13), D (M1.5, WP-1.21, 1.23, 1.30), A §8, T §7 | Fixed |
| C-B2 | Guardian email ≠ verifiable parental consent; persons with disability, Fourth Schedule exemptions, respondent vs subject and pre-consent processing missing | `ChildrenDataPolicy` rewritten: `subject`, `lawful_guardian` (Rule 11), `exempt` (Rule 12), `GuardianConsentConfig` with methods existing verified adult account / manual document review / DigiLocker (P2, CMP-22); `pending_guardian_consent` status with no processing and expiry deletion; `ConsentRecord.vpc` evidence; email OTP documented as contact only; air-gapped offers the two local methods | S §2 (§3, §16), A §2.4, §5.2, §6, §8 #13, D WP-1.30, WP-2.31, M CMP-13/22 | Fixed / Counsel |
| C-B3 | Retention ignores the one-year minimum for data, traffic data and logs; no sectoral minimums | Platform statutory floor (default 365 d, `STATUTORY_RETENTION_FLOOR_DAYS`) with a restricted **statutory hold store** (own DEK, no processing, audited access); `RetentionRule` adds `statutory` (may extend, e.g. PMLA 5 y) and `inactivity`; erasure responses say what is restricted and until when; email logs, webhook metadata and app logs kept 365 days; control 14 corrected | M (CMP-06, new CMP-23), S RetentionRule, A §2.4, §5.2, §7.7, §8 #11/#14, D WP-1.22, ADR-0014 | Fixed / Counsel |

### Major

| ID | Finding | Resolution | Where | Status |
|---|---|---|---|---|
| C-M1 | "Crypto-shredding" overclaimed (wrapped KEKs in PITR backups) | All shred wording removed; erasure = deletion + backup expiry ≤ 35 d; certificate states method and backup-expiry date; WP-1.11 acceptance rewritten; real crypto-shred only with per-org root keys (P3 BYOK, decision D18) | A §2.6, ADR-0005, S comments, M CMP-07/17, D WP-1.11 | Fixed |
| C-M2 | Notices miss withdrawal / rights / Board-complaint elements; notice version hashes the authored text only | `FiduciaryInfo.rightsUrl`, `boardComplaintInfo`, `privacyContact`; `withdrawalText` required in dpdp mode (`notice_incomplete`); `noticeVersion`/`noticeHash` over the fully rendered notice per locale | S ConsentConfig/FiduciaryInfo/ConsentRecord, A §8 #8, D WP-1.21, M CMP-04 | Fixed |
| C-M3 | `dropAnswersWithoutConsent` is a toggle | Literal `true`; negative type test added | S PrivacyConfig, checks | Fixed |
| C-M4 | Drafts, autosave, page validation, OTP and analytics process data before consent | Invariant I14 (consent block precedes consent-based fields, publish error); drafts, `validate-page`, OTP and analytics carry only legitimate-use or granted fields; "save for later" is its own purpose | S I14, A §2.4 (`partial_submissions`), §3.3, M RSP-03/04, D WP-1.21, WP-2.18 | Fixed |
| C-M5 | Withdrawal does not erase or reach processors | `consent.withdrawn` job: erase consent-only data (subject to floor), cancel scheduled emails/workflows/reminders, webhook event, integration delete calls (P2), confirmation | A §5.2, §8 #9, M CMP-05, D WP-1.21, WP-2.24/2.25 | Fixed |
| C-M6 | DSR access cannot list recipients; erasure coverage incomplete | Append-only `disclosures` ledger (type `Disclosure`), included in DSR exports; `pii_coverage` manifest with CI test covering every PII table (partials, prefill links, comments, revisions, workflow runs, holds, payment objects, delivery snippets, exports, statutory hold) | S §16, A §2.4, §5.2, D WP-1.23, M CMP-09 | Fixed |
| C-M7 | Denied and failed actions never audited (rollback) | Denied/error events written on a separate connection into `audit_pending`; test that a 403 yields an audit row | A §2.7, ADR-0006, D WP-1.04 | Fixed |
| C-M8 | Respondent context can read every submission in the org | `app.subject_ids` GUC; respondent SELECT only for verified subject ids; INSERT-only otherwise | A §2.2, D WP-1.12 | Fixed |
| C-M9 | Only sensitive reads audited; "sensitive" mislabelled as DPDP class | Every submission read audited (detail, grid page coalesced, API, export, download); "sensitive" relabelled as a product protection tier | A §2.7, S FieldCompliance, M CMP-02/03, SUB-03 | Fixed |
| C-M10 | CERT-In Directions missing (6 h reporting, 180-day logs in India, NTP) | CERT-In runbook and drafts; logs 365 d in India; NTP to NIC/NPL (internal NTP on-prem) with readiness check | A §7.7, §8 #14/#15, M CMP-14, D WP-1.24, WP-1.29, R21 | Fixed |
| C-M11 | Breach SLA clock starts at confirmation; no fiduciary tooling | "Preliminary within 24 h of awareness, updates every 24 h"; tooling for affected-principal lists, Rule 7(1) principal notices via SMTP (air-gapped too), Board intimation and 72 h drafts | A §8 #15, §3.3, M CMP-14, D WP-1.24, D15 | Fixed / Counsel |
| C-M12 | hCaptcha default sends data to a foreign sub-processor | Proof-of-work default in every edition; third-party captcha per-form opt-in, declared as recipients and sub-processors | A §1.5, §4.4, §6, ADR-0011, M FLD-29/CMP-12, S CaptchaConfig | Fixed |
| C-M13 | Prefill PII leaks via URLs, logs, traces, Referer, CDN | Query strings scrubbed from logs/traces; `history.replaceState`; `Referrer-Policy: no-referrer`; CDN cache key ignores query, query logging off; CDN listed as sub-processor with India TLS; submit/upload routes bypass CDN | A §3.2, §4.1, §4.5, M PRE-01, D WP-1.09 | Fixed |
| C-M14 | Classification does not propagate to derived values | Invariant I13 taint; `CompiledForm.taint`; `declassify` with audit; encrypted `EncryptedScalar`; publish error for sensitive pipes in subjects/URLs/redirects; masking | S I13, §3.3 #10, A §2.6, D WP-1.20, M CMP-03/FLD-33 | Fixed |
| C-M15 | Webhook/integration purpose gating optional | `purposeIds` required on notifications, webhooks, integrations; targets must be declared in `Purpose.recipients` (`recipient_not_declared`) | S, A §2.4, §3.3, M INT-01, D WP-1.18 | Fixed |
| C-M16 | Full Aadhaar storage allowed by opt-in | Preset `in_aadhaar_last4`: last 4 only, no checksum, full number never sent; full-number mode only via an Aadhaar Data Vault adapter (P4, UIDAI-authorised); KYC templates instruct masked copies | S TEXT_PRESETS, M VAL-03, T §6.4, D WP-2.07 | Fixed |
| C-M17 | Platform's own Fiduciary role unmodelled | New row CMP-21 (P1): builder-user notice, account export/delete, privacy contact, DPA clause for anonymised aggregates (≥ 5 distinct orgs), support-access DPA | M CMP-21, A §8 #24, D WP-1.31 | Fixed |
| C-M18 | Consent pseudonymisation and org purge contradict role grants | Definer functions `consent_pseudonymise()` and `org_purge()`; lawful basis for retained `principal_bidx` (s.6(10)) documented | A §2.1, §2.4 | Fixed / Counsel |
| C-M19 | MinIO AGPL and distribution changes threaten the bundle | BYO S3 default on-prem; MinIO dev/CI only; D14 evaluates SeaweedFS / Ceph RGW with licence review; third-party notices and source offers in the bundle; WORM as a capability check with syslog/SIEM fallback | A §6, §7, ADR-0018, D WP-1.27, D14, R20, M FND-17/18 | Fixed |
| C-M20 | No review gate for consent text before P3 locks; legal fixes cannot be pushed | CMP-24 notice approval gate (P1, `compliance.approve_notice`); TPL-33 legal-text updates with bulk apply and mandatory deadline for consent snippets (P2) | M CMP-24, TPL-33, A §3.3, D WP-1.32, WP-T2.11, T §4.5 | Fixed |
| C-M21 | Forks of system templates never receive upstream updates | Template-to-template binding (`template_fork_bindings`, `TemplateForkBinding`), TPL-32 (P2) in WP-T2.7 | M TPL-32, S §17, T §2.1, §4.4, D WP-T2.7 | Fixed |
| C-M22 | Matrix not updated for templates; counts inconsistent | TPL section added (33 rows); BLD-13, DSN-03, DSN-09 became uncounted pointers; totals recomputed by script: 386 counted, **306 for feature match**, used in all documents | M §2b and summary, A scope, D header and §8 | Fixed |

### Minor

| ID | Finding | Resolution | Status |
|---|---|---|---|
| C-m1 | TPL id drift in templates spec prose | All references re-pointed (locks TPL-23, kits TPL-24, governance TPL-25, gallery governance TPL-26); §10.3 now references WP-1.06 | Fixed (T) |
| C-m2 | Invalid `coalesce()` SQL in spec | Unique indexes instead; corrections applied in the spec itself | Fixed (T §5.1) |
| C-m3 | No P1 path to edit or fork org templates | TPL-08 widened: fork, open → edit → publish vN, lifecycle, metadata (WP-T1.5) | Fixed (M, T, D) |
| C-m4 | TPL-10 depends on P2 OTP and tracker | CMP-10 now P1; P1 variants use signed-link identity confirmation and submission ids | Fixed (T §6.4, D WP-T1.6) |
| C-m5 | Wrong wording on notice languages | Rewritten: the principal's option to read the notice in English or any Eighth Schedule language; picker on every dpdp notice | Fixed (T §7, S) |
| C-m6 | "Grievance officer" / mandatory DPO terminology | Renamed `org.privacy_contact.*`; `dpo` optional (SDFs); `dsr_response`, `breach_notice` email roles carry the contact | Fixed (S, T, A) |
| C-m7 | `LegitimateUseGround` imprecise; s.7(a) objection | One value per s.7 clause; `principal_objections` table stops s7a processing | Fixed / Counsel (S, A) |
| C-m8 | Significant Data Fiduciaries unsupported | SDF evidence pack (DPIA export, audit pack, DPO field) in WP-2.31 | Fixed (P2) |
| C-m9 | IP/UA hashes never nulled; daily salt breaks uniqueness and e-sign evidence | `signals.ttl` job; per-form uniqueness salt; `SignatureValue.audit.evidenceHash` | Fixed (A, S, M CMP-11/ACC-07) |
| C-m10 | No `consent_manager` source | Added to `ConsentRecord.source` | Fixed (S) |
| C-m11 | Imported submissions need retrospective notices | Import requires lawful-basis declaration; retrospective-notice campaign tool | Fixed (M SUB-18, A §3.3, D WP-2.14) |
| C-m12 | DR region not pinned to India | Mumbai ↔ Hyderabad; sub-processor regions named | Fixed (M CMP-16, A §7.6, D WP-1.29) |
| C-m13 | Ed25519 unavailable on Azure Key Vault | Per-key algorithm (Ed25519 app-held KMS-wrapped, or ES256 KMS-native) for checkpoints and packs | Fixed (A §2.7, §6, T §8) |
| C-m14 | Keyfile KMS needs protected secrets and tested escrow | etcd encryption or external secrets required; escrow tested in restore drill | Fixed (A §6, §7.6) |
| C-m15 | CloudNativePG needs cluster rights | External Postgres is the default profile; CNPG optional | Fixed (A §7.3) |
| C-m16 | N−2 → N upgrades unrealistic air-gapped | Multi-hop upgrade images in the bundle, `form-admin upgrade plan` | Fixed (A §7.5, D WP-1.27) |
| C-m17 | No SMTP air-gapped breaks OTP, invites, resets, DSR | Admin-issued one-time-code fallback | Fixed (A §6) |
| C-m18 | No CUEC matrix, hardening guide, tabletop, sub-processor notice | Added to CMP-18 and WP-1.24 | Fixed |
| C-m19 | Sanitiser keeps analytics ids and real sample answers; lawful basis silently inherited | Sanitiser strips analytics ids, synthetic-only samples; Use dialog asks for lawful-basis confirmation | Fixed (T §3.1, §5.3) |
| C-m20 | E-signature overclaim | Disclaimer on signature templates; WFL-08 for recognised signing; stated in A §8 | Fixed |
| C-m21 | Third Schedule 3-year inactivity erasure | `RetentionRule { kind: 'inactivity' }` with 48 h notice jobs | Fixed (S, A §5.2) |
| C-m22 | Field-level analytics for children's forms | Disabled for the whole form when a children policy applies | Fixed (S, A, D WP-1.19) |
| C-m23 | Cross-document drift (scope, registry location, Postgres version) | `@form/*`, `packages/registry`, Postgres 18 everywhere (ADR-0001) | Fixed |

---

## 2. Feasibility and consistency review

### Blockers

| ID | Finding | Resolution | Where | Status |
|---|---|---|---|---|
| F-1 | Org-spanning jobs and org listing impossible under RLS | Definer functions `orgs_due_for`, `list_user_orgs`, `membership_for`, `create_partitions`, `resolve_job_org`; `fr_system_agg` role (SELECT-only on rollup sources) for cross-tenant stats; added to WP-0.13/0.14 | A §2.1, §5.1, ADR-0015, D WP-0.13 (14 ed) | Fixed |
| F-2 | Partitions bypass RLS | Partitions in schema `parts` with no grants to `fr_app`, plus forced RLS per partition; meta-test on `pg_inherits` grants; direct-partition test | A §2.3, §2.4, ADR-0004 | Fixed |
| F-3 | Template policies throw for actors without a user id | All policies use null-safe helpers in sub-selects; per-actor isolation tests; meta-test forbids raw `current_setting(` | T §5.2, A §2.2–2.3 | Fixed |
| F-4 | Localizations and category links lack RLS (FTS leak) | `tl_read` / `tcl_read` inherit parent visibility; added to TPL-04 suite | T §5.2 | Fixed |
| F-5 | P1 GA collects consent without withdrawal; English-only notices | Same fix as C-B1 (withdrawal and language picker in WP-1.21; dated gate) | as C-B1 | Fixed |
| F-6 | Guardian email is not Rule 10 VPC | Same fix as C-B2 (`GuardianVerifier` port, DigiLocker adapter P2) | as C-B2 | Fixed |

### Major

| ID | Finding | Resolution | Status |
|---|---|---|---|
| F-7 | Matrix not updated; 302 double-counts | As C-M22: pointers excluded; 306 everywhere (the extra rows are the new CMP and TPL rows from this review) | Fixed |
| F-8 | TPL ids shifted in spec prose | As C-m1 | Fixed |
| F-9 | Architecture and delivery plan describe different monorepos | ADR-0001 freezes the architecture layout with `@form/*`; registry in `packages/registry`; ports + adapters; source-only packages + tsup for apps; dependency-cruiser; `memberships`, `audit_log`, `fr_migrator`; Postgres 18; `fr-server` + `fr-worker-pdf`; React SSR runtime (WP-1.09 +8 ed); Fetch-Metadata CSRF (no tokens); in-house auth (ADR-0017, D4 decided) | Fixed (A §1, D throughout) |
| F-10 | WPs sized below Cx floors | Payments 110, appointments 40, logic 100, audit 12, WP-0.07 20, WP-0.10 18, connectors 40, encryption 12; size-floor rule and CI check; P2 = 920 raw / 1,058 planned (33 wk with 8 engineers) | Fixed (D §0) |
| F-11 | Critical chains wrong | 0.08→0.06 edge removed (types in 0.04); WP-1.01 uses the dev mail adapter (no 1.03 dependency); chains recomputed; 2.32 starts after T2.1; payments start after 2.02 ends; P0 arithmetic corrected (162 raw) | Fixed (D §3, §4, §6) |
| F-12 | P1 compliance starter set needs P2 features; ★ count vs 25 | Explicit list of 25 P1 templates; P1 variants (signed-link identity, submission ids); full versions in T2.1 | Fixed (T §6.4) |
| F-13 | No way to insert the Consent snippet in P1 | Single-block snippet insertion in WP-T1.4 (+3 ed) | Fixed |
| F-14 | Determinism suite only V8; `Intl.Segmenter`; trig functions | Playwright on Chromium, Firefox, WebKit; pinned segmenter; decimal.js (full) for trig | Fixed (S §3, A §1.4, D WP-0.07, 0.12) |
| F-15 | Client/server regex engines differ | `re2js` on both sides | Fixed (S, M VAL-04, D WP-0.09) |
| F-16 | Same-cell writers not in authored order | Writer-chain edges before sorting; conflicting-writers cycle hint; golden test | Fixed (S §3.3 #3, D WP-0.07) |
| F-17 | On-path membership not a cell | `onPath(p)` cell and `on_path` plan step; value reads depend on it; I8 transitive and covers validation bounds | Fixed (S I8, §3.3, PlanStep) |
| F-18 | Clock and meta inputs differ | Client clock frozen at `startedAt` (reset on resume); `pageUrl`, `referrer`, `device` in `SubmissionRequest.client` | Fixed (S, D WP-0.10, 1.12) |
| F-19 | Runtime projection drops `reads`; Exclude is a no-op | `ClientRuleStep` / `ServerRuleStep` split; `reads` kept; negative type test | Fixed (S) |
| F-20 | Submit transaction holds the hot lock; gaps; one counter | Reordered: work outside tx, idempotency first, counters last; `form_id_counters` per block and period; limit counts `complete` only; ceiling documented | Fixed (A §2.5, D WP-1.12) |
| F-21 | Audit writes impossible in read-only GETs; per-org serialisation | `audit_pending` + chain worker; audited GETs use read-write tx | Fixed (A §2.7) |
| F-22 | Respondent actor reads every submission | As C-M8 | Fixed |
| F-23 | Job payloads can target any org; secrets in payloads | Signed job envelope + org re-derivation (ADR-0016); encrypted secret fields; 1-day archive for auth queues | Fixed (A §5.1, D WP-0.14) |
| F-24 | Creator can exfiltrate data | `data.route` permission for all routing paths; mandatory redirect allowlist for piped redirects | Fixed (A §2.4, D WP-1.02, 1.18, 2.29, M WSP-04) |
| F-25 | Nonce CSP on cached HTML; Trusted Types breaks payments; query in cache key | Hash-based CSP computed at publish with `'strict-dynamic'`; Trusted Types report-only with payment/captcha; query excluded from cache key | Fixed (A §4.1, §4.5) |
| F-26 | Subdomains are same-site | Runtime and files on a separate registrable domain in SaaS (ADR-0013, D13); on-prem residual risk documented | Fixed (A §4.2, M FND-20) |
| F-27 | Appointment exclusion constraint broken | `appointment_slots` capacity table + `appointment_holds` with expiry | Fixed (A §2.4, D WP-2.13) |
| F-28 | Imports vs partitions and uuidv7 CHECK | Import-time ids with `originalSubmittedAt`; no default data partition | Fixed (A §2.4, M SUB-18) |
| F-29 | Uploads bound to one visit; versioned plaintext; presigned PUT | Bind to draft/submission; unversioned staging bucket; presigned POST everywhere | Fixed (A §4.6, M FLD-26, D WP-1.14) |
| F-30 | Calculations/variables and group children stored in plaintext | Taint (I13); `EncryptedScalar`; group children as `StoredAnswer` | Fixed (S) |
| F-31 | Crypto-shred acceptance contradicts key design | As C-M1 | Fixed |
| F-32 | Postgres scale and pooling assumptions | One fanout job; batched analytics (COPY), sampled `field_focus`; dedicated LISTEN connection; `btree_gin (form_id, doc)`; valid DELETE syntax; separate queue DB option | Fixed (A §2.4, §5, §7.3) |
| F-33 | Per-IP limits block CGNAT; daily salt breaks uniqueness | Visit-token limits, IP as spam signal (on-suspicion PoW), unlock lockout per visit token; per-form uniqueness salt | Fixed (A §3.5, M ACC-07) |
| F-34 | Republish rejects in-flight respondents | Versions accept submissions for 72 h after a newer publish (`acceptPreviousVersionsHours`), then carry-over by `FieldKey` | Fixed (S FormOps, A §2.5, D WP-1.07) |
| F-35 | P2 rows lack tables/routes/schema | Added `saved_views`, `workflows`, `workflow_runs`, `workflow_actions`, `reports`, `prefill_links`, `respondent_tokens`, `otp_challenges`, `signed_links`, `holiday_calendars`; routes for import, reply/forward, Google Forms/CSV import; `workflow_state`, `status_label`; analytics `browser_family`, `os_family` | Fixed (A §2.4, §3.3, S StoredSubmission) |
| F-36 | Option and page labels cannot hold pipes/vars | `LabelText = string \| PlainTemplate`; XLIFF placeholders with set checks | Fixed (S, T §7) |

### Minor

| ID | Finding | Resolution | Status |
|---|---|---|---|
| F-37 | Doubtful JotForm claims (VAL-10, WSP-02, FLD-20) | "(exceeds)" removed from VAL-10 and WSP-02; WSP-02 and FLD-20 marked "to re-verify" | Partly (verification pending) |
| F-38 | Aadhaar contradiction | As C-M16 | Fixed |
| F-39 | Status-screen names; quarantine leak; copy manifest | Names unified (`not_yet_open`, `password`); no `quarantined` screen (silent); manifest states `access.screens` is copied | Fixed (S, T §1, §3.1, A §4.4) |
| F-40 | Template SQL defects | `'cards'`; `form.purposes`; `industry` column; deferred FK for `forked_from_version_id`; publisher-scoped slugs; terminal `rejected`; `template_for_binding()` for soft-deleted; k ≥ 5 distinct orgs; RLS on `user_identities`, `sessions`; `submission_idempotency` with `org_id`, RLS, encrypted response, re-minted tokens | Fixed (T §5, A §2.4) |
| F-41 | No fork of system templates; no lifecycle/metadata UI | WP-T1.5 widened (+5 ed) | Fixed |
| F-42 | No authoring UI for custom variables or optional parts | Variable and optional-part editor in WP-T2.7; P1 Use dialog renders variables for system templates only (stated) | Fixed |
| F-43 | Brand refs before brand kits undefined | Fall back to theme/renderer defaults with a warning; `brand_ref_unresolved` is a warning | Fixed (T §3.3) |
| F-44 | Email variables resolve live silently | Resolved at send time, recorded on `email_messages` (profile timestamp, brand hash); documented in the editor | Fixed (T §3.2, A §2.4) |
| F-45 | Duplicate copies origin stamps | Duplicate and paste strip `origin`; tested | Fixed (T §3.1, D WP-0.11a) |
| F-46 | Spec/schema shape mismatches | Reconciled and listed as documented deltas | Fixed (S §2.1, T) |
| F-47 | Asset copy-on-use duplicates system assets | Content-addressed store with references | Fixed (T §5.1, A §2.4, D WP-1.08) |
| F-48 | P1 org templates have no thumbnails | Placeholder thumbnails in P1; worker thumbnails in P2 | Fixed (T §6.2) |
| F-49 | pdf-lib cannot shape Indic; Azure Ed25519; SMTP double send; `job_effects` TTL | Chromium only; per-key signing alg; at-least-once email with stable Message-ID; 30-day TTL | Fixed |
| F-50 | Missing SaaS infra WP; Google OAuth verification; dependency loops; captcha precedence; whole-document CAS conflicts | WP-1.29 SaaS infrastructure (20 ed); R18 and verification start in P1 W12; org-profile interface splits WP-1.07/WP-T1.3; captcha block overrides behaviour; `DocumentOp` draft saves in WP-2.30 (+8 ed) | Fixed |

---

## 3. Changes not requested by a finding

- **Templates (user request: "also add templates, customizable").** The templates spec (`06-templates.md`) opens with an explicit definition of customisation (use + variables + save + fork + brand + updates) and the TPL rows are now a first-class matrix domain referenced from the schema, the architecture and the plan.
- **Effort and calendar.** P0 162 → 178 planned ed (~10 wk), P1 464 → 510 (~21 wk, GA 2027-06-04), P2 920 → 1,058 (~33 wk with 8 engineers, feature match 2028-01-28). Total 1,746 planned ed.
- **New decisions D13–D20** in the plan §9 (user-content domain, bundled object store, breach SLA, consent-record retention, statutory floor, per-org KMS keys, Postgres floor, DigiLocker).
- **Schema verification.** The revised TypeScript still type-checks under strict settings; two negative tests were added (five in total).

## 4. Residual items needing confirmation

| Item | Owner | Due |
|---|---|---|
| Statutory mapping (Rules 6(1)(e), 7, 8(3), 9, 10–12, 14(3)), s.7 clause wording, consent-record retention, sectoral minimums | Counsel | P1 W6–W10 |
| CERT-In obligations for the SaaS operator, NTP sources | Counsel, SRE | P1 W8 |
| JotForm behaviour claims (WSP-02 plan availability, FLD-20 range) | PM | P1 W4 |
| MinIO / object-store licensing for any bundled store | SRE, counsel | P1 W10 |
| DigiLocker integration terms | PO | P2 W8 |
