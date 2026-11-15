# fORM- Platform Architecture

**Status:** v1.1, revised after the compliance and feasibility reviews (`05-review-log.md`).
**Baseline:** commit `e1be409`, a single Vite 8 + React 19 + TypeScript 6 app with Zustand, zundo, dnd-kit, react-hook-form, zod 4 and oxlint.
**Scope:** Phase 0 (foundation), Phase 1 (SaaS MVP and on-prem v1) and Phase 2 (feature match): the **306** P0–P2 rows of the feature matrix, including the 24 P0–P2 template rows (TPL-01 to TPL-22, TPL-32, TPL-33). P3 seams are reserved.
**Fixed inputs, not reopened here:** Fastify 5, fastify-type-provider-zod, Drizzle, Postgres with RLS, pino + OpenTelemetry, pg-boss (no Redis), S3 API, SMTP, KMS / Vault / keyfile, Postgres FTS, BoxyHQ Jackson (P3), Stripe + Razorpay, schema v2 (`02-form-schema-v2.md`), templates spec (`06-templates.md`).

---

## 0. Architectural principles

1. **One codebase, one image family, three topologies.** `DEPLOYMENT_MODE=saas|onprem` and `EGRESS_POLICY=open|allowlist|none` decide behaviour; "air-gapped" means `onprem` + `none`. No code path assumes a cloud service: every external dependency sits behind a port (§6) with an implementation that works offline.
2. **Postgres is the only stateful dependency** besides object storage. It holds queues (pg-boss), rate limits, search, sessions, idempotency, analytics rollups and audit. On-prem customers run two stateful things, not six. A separate queue database is a documented Helm option for large installs (§7.3).
3. **Tenant isolation is enforced by the database.** Every tenant table has `org_id` and an RLS policy; the app role cannot bypass RLS; a query outside `withTenant()` sees zero rows. Work that spans orgs goes through a few narrow, audited `SECURITY DEFINER` functions or a dedicated aggregation role (§2.1). Authorisation inside a tenant (roles, teams, per-form sharing) is in the app layer, with RLS as a second check for data access.
4. **Pure domain packages decide meaning; apps orchestrate.** `schema`, `registry`, `logic`, `validation` and `templates-core` are pure TypeScript with no I/O, clock, randomness or host locale/Unicode tables. The same code runs in the browser, the API and the worker; a fixture corpus proves identical results in Node, Chromium, Firefox and WebKit (I10).
5. **Immutable artifacts, mutable operations.** `form_versions` and published `template_versions` cannot change (DB triggers). Operational config (`FormOps`) is live, revisioned and audited.
6. **The server is the only authority.** The browser previews what the server decides (visibility, required, calculations, totals, access, spam). Hidden, skipped and unconsented answers are never stored (CMP-19).
7. **Privacy by default.** Sensitive fields are encrypted; derived values inherit classification (taint); respondent pages make no third-party requests by default (proof-of-work captcha everywhere); IPs and user agents are stored only as salted hashes with a TTL; analytics are aggregates; on-prem sends no telemetry.
8. **Few deployables.** `server` (api + runtime SSR), `worker`, `worker-pdf` and `builder` static assets; P3 adds an admin console. All stateless and horizontally scalable.

---

## 1. Monorepo

This layout is frozen by **ADR-0001** before WP-0.01; the delivery plan uses the same names.

### 1.1 Layout

```
fORM-/
├─ apps/
│  ├─ builder/        Vite 8 SPA: form + template builder, workspace, submissions inbox, settings (moved from src/ in FND-01)
│  ├─ runtime/        Respondent app: React 19 SSR server entry + hydrated client, embed iframe target
│  ├─ api/            Fastify 5: /v1 (builder + public API), /f (runtime public), /s (signed links), /hooks, /internal, /platform
│  ├─ worker/         pg-boss consumers + cron
│  ├─ worker-pdf/     pg-boss consumer with headless Chromium (PDF, thumbnails); separate image, no network
│  ├─ cli/            `form-admin`: migrate, seed, templates import/export, airgap load, audit verify, breach tooling, keys escrow
│  └─ admin/          (P3) org/platform admin console SPA
├─ packages/                       (all published under the @form/ scope)
│  ├─ schema/         v2 types + zod twins, V1 namespace, migrate(), template payload schemas, TextKey, JCS hashing
│  ├─ registry/       FieldRegistry (non-UI): config/answer schemas, operators, paths, compliance defaults, export, lint
│  ├─ logic/          compile(), evaluate(), expression parser/printer/type-checker, taint, diff engine, engine registry
│  ├─ validation/     answer validation per page / visible set; re2js; FieldError production
│  ├─ templates-core/ instantiate(), insertSnippet(), resolveVariables(), resolveForPublish(), lockFingerprint(), diffTemplate(), sanitizeForTemplate()
│  ├─ templates/      System templates authored as data; `templates:build` → signed system-core-<ver>.formpack
│  ├─ renderer/       React renderer: mode = live | preview | print | email | template-preview; props-driven
│  ├─ ui/             Design-system primitives for builder/admin (Radix-based)
│  ├─ i18n/           ICU catalogs, en-IN first, Noto font manifest, Intl wrappers with explicit locale, pinned grapheme segmenter
│  ├─ sdk/            (a) @form/embed browser script, (b) typed API client from OpenAPI, (c) postMessage protocol types
│  ├─ email/          EmailDoc AST → table-based HTML + text
│  ├─ db/             Drizzle schema, SQL migrations, RLS helpers (withTenant), roles, SECURITY DEFINER functions, partition SQL
│  ├─ ports/          Adapter interfaces + job contracts (JobData map) – zero deps
│  ├─ adapters/       Implementations, subpath exports: @form/adapters/storage/s3, /mailer/smtp, /kms/aws|gcp|azure|vault|keyfile, …
│  ├─ crypto/         Envelope encryption, blind index, signing (per-key alg), argon2id wrapper, tokens (node-only subpath)
│  ├─ config/         zod config schema, loader, edition/feature resolution, licence verification
│  ├─ observability/  pino factory + redaction, OTel bootstrap, URL/query scrubbing, metric names
│  ├─ testkit/        Fixture corpus, determinism corpus, Testcontainers helpers, RLS test DSL, adapter contract suites
│  ├─ tsconfig/       Shared tsconfig bases
│  └─ lint-config/    oxlint config + dependency-cruiser rules
├─ deploy/
│  ├─ docker/         Dockerfiles (server, worker-pdf, builder-static), compose.dev.yaml
│  ├─ helm/form/      Helm chart
│  └─ airgap/         bundle manifest, image/chart/pack/ClamAV/GeoIP packaging scripts, third-party notices
├─ docs/              platform/ (these documents), adr/, runbooks/ (incident, breach, CERT-In, restore, upgrade), DPA annexes, CUEC matrix
├─ turbo.json  pnpm-workspace.yaml  package.json  .oxlintrc.json  .dependency-cruiser.cjs  .github/workflows/
```

### 1.2 Responsibilities

| Package / app | Owns | Must not own |
|---|---|---|
| `schema` | Every wire and storage type, its zod twin, `migrate()`, `SCHEMA_VERSION`, canonical JSON (RFC 8785), `sha256Jcs()` | Behaviour |
| `registry` | `FieldDefinition` for all 34 `BlockType`s; exhaustiveness checked at compile time | React components (those live in `renderer/fields/*` with their own exhaustive `RendererRegistry`) |
| `logic` | `compile`, `evaluate`, `EXPR_FUNCTIONS`, decimal.js arithmetic, case fold, pinned grapheme length, taint, the shared diff engine (BLD-10, TPL-18) | Clock, locale, I/O (`EvalMeta` is injected) |
| `validation` | `validateAnswers(version, evalState, answers, { scope, locale, today, messages? })` → `FieldError[]` (delivery plan WP-0.09); `normalizeAnswers` (I9); regex through `re2js` on both sides | Network checks (uniqueness, OTP, slot capacity): the API appends those |
| `templates-core` | Everything in the templates spec §3–4 that is pure | DB, signatures, asset storage |
| `templates` | System template content, pack build, CI thumbnails, reviewer attestations | Runtime code |
| `renderer` | All respondent UI: Classic + Cards, WCAG 2.1 AA, print and email modes, incremental evaluation | Fetching (receives `RuntimeFormVersion`, `uploader`, `onSubmit` as props) |
| `sdk` | `embed.js` (< 6 kB gz), API client, postMessage protocol | Form rendering |
| `db` | Drizzle tables, migrations, `withTenant`, roles, definer functions, partition functions | Business rules |
| `ports` / `adapters` | Interfaces, job contracts, implementations; each family has a contract suite | Config parsing |
| `apps/api` | HTTP, authn/z, transactions, audit writes, publish and submit pipelines, composition root | Long-running work (> 2 s is a job) |
| `apps/worker` | Job handlers, cron, partition maintenance, seeding | HTTP (except `/healthz`, `/metrics`) |
| `apps/runtime` | SSR of the first page, hydration, embed mode | DB access (talks to the API in-process or over the internal URL) |

### 1.3 Dependency rules (enforced in CI)

```
L0  schema, i18n(core), lint-config, tsconfig
L1  registry → L0 ; logic → registry,L0 ; validation → logic,registry,L0 ; templates-core → validation,logic,registry,L0
L1t templates → templates-core,validation,logic,registry,L0 (system template data, pack build and `readFormpack`)
L2  renderer → L1,L0,i18n,ui ; ui → (react only) ; sdk → schema
L2s ports → schema ; crypto → schema ; config → ports,crypto,schema ; observability ; db → schema,crypto,config ; adapters → ports,crypto,config ; email → renderer(email mode),schema
L3  apps/builder → renderer,ui,sdk(client),config (edition summary and feature checks only),templates-core,templates (the bundled system pack and its reader),L1,L0
    apps/runtime → renderer,sdk,config,observability,L1,L0
    apps/api, apps/worker → L2s + L1 + templates-core + email (+ renderer for email/PDF HTML in the worker)
    apps/cli → db, config, crypto, adapters, templates-core
```

1. **dependency-cruiser** (CI job `deps`) enforces the layer graph, forbids cycles, forbids deep imports (`@form/logic/src/...`) and forbids `react`/DOM in `schema`, `registry`, `logic`, `validation`, `templates-core`.
2. **oxlint** `no-restricted-imports` / `no-restricted-globals` in pure packages: banned `node:*`, `react`, `@form/db`, `@form/adapters`; banned `Date`, `Math.random`, `Intl.Segmenter`, `Intl.*` without explicit locale, `crypto.randomUUID`, `performance.now`, native `RegExp` construction from user patterns.
3. **Composition root:** only `apps/api/src/main.ts`, `apps/worker/src/main.ts` and `apps/cli` import `@form/adapters/*`.
4. **Bundle guard:** a Vite plugin fails the builder and runtime builds if `@form/db`, `@form/crypto/node`, `@form/adapters` or `node:` modules enter the browser graph.

### 1.4 Build and test tooling

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node 24 LTS** | Same in dev, CI and images |
| Package manager | **pnpm 10** workspaces with catalogs | `onlyBuiltDependencies` allowlist (argon2, sharp, esbuild, re2 not needed: re2js is pure JS) |
| Task runner | **Turborepo 2** | `build`, `typecheck`, `lint`, `test`, `test:int`, `test:e2e`, `test:determinism`, `openapi:emit`, `templates:build`. Remote cache optional, disabled air-gapped |
| Internal packages | **Source-only ("just-in-time")**: `exports` point at `src/*.ts`; no build step | Vite, Vitest and `tsx` consume TypeScript directly |
| App builds | Vite 8 for builder and runtime client; **tsup** bundles api, worker, cli and the runtime server | Source maps go to the observability backend, never served |
| Published packages | `@form/sdk` and `@form/embed` built with tsup, released with Changesets | Everything else is `0.0.0` internal |
| Type checking | TypeScript 6, project references | `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |
| Lint / format | oxlint, Prettier, dependency-cruiser | |
| Unit tests | **Vitest 4** projects: `node`, `jsdom` (renderer, builder) | |
| Determinism | Fixture corpus in Node **and** in Playwright on Chromium, Firefox and WebKit; `EvalState` JSON diffed byte-for-byte | jsdom alone runs in V8 and is not evidence |
| Integration | Vitest + **Testcontainers**: Postgres 18, SeaweedFS for the S3 API (dev/CI only, ADR-0002 §5), Mailpit, ClamAV, Vault dev | RLS suite, migration tests, adapter contract tests. ClamAV is opt-in (`FORM_TEST_CLAMAV=1`, weekly workflow) because its image loads the full signature set on start; cloud KMS runs against emulators, and against real accounts in the nightly job (§6) |
| E2E | **Playwright**: builder flows, runtime on 3 viewports, embed on a third-party origin, `@axe-core/playwright`, Hindi + Urdu smoke | |
| API contract | `@fastify/swagger` + fastify-type-provider-zod → `openapi.json` in `packages/sdk`; **oasdiff** gates breaking changes on public routes | |
| Migrations lint | **squawk** | |
| Supply chain | osv-scanner, syft SBOM, grype, cosign signing, **third-party notices and source offers** for GPL/AGPL components shipped in images or bundles (ClamAV; any bundled object store per D14) | CMP-18 |
| Release | Calendar versions (`2027.06.0`) | |

### 1.5 Configuration, editions and licences

**Loader** (`@form/config`): defaults < `/etc/form/config.yaml` < env < `*_FILE` secrets, parsed by one zod schema; invalid config refuses to start and prints every error.

```bash
DEPLOYMENT_MODE=saas|onprem
EGRESS_POLICY=open|allowlist|none     # default: saas→open, onprem→allowlist; air-gapped = none
EGRESS_ALLOWLIST=smtp.acme.local,hooks.acme.local
PUBLIC_BUILDER_URL=https://app.form.example
PUBLIC_API_URL=https://api.form.example
PUBLIC_RUNTIME_URL=https://forms.formsuser.example   # SaaS: a DIFFERENT registrable domain from builder/api (ADR-0013)
PUBLIC_FILES_URL=https://files.formsuser.example     # same rule
DATABASE_URL=postgres://fr_app@pg:5432/form           # app role (NOBYPASSRLS)
DATABASE_MIGRATOR_URL_FILE=/run/secrets/db_migrator
DATABASE_AGG_URL_FILE=/run/secrets/db_agg             # fr_system_agg, used only by rollup/stats handlers
QUEUE_DATABASE_URL=                                   # optional separate pg-boss database
JOB_SIGNING_KEYS_FILE=/run/secrets/job_keys           # ADR-0016 HMAC keys, `id:base64url` (≥ 32 bytes) comma-separated, first signs; api and worker
WORKER_QUEUES=pdf.*,templates.thumbnail               # worker: queues to serve (default: all with a handler)
WORKER_SHUTDOWN_GRACE_MS=25000                        # worker: SIGTERM grace before running jobs are failed back for a retry
DATABASE_POOL_MAX=20
TRUST_PROXY=1                                         # api: proxy hops in front of the API, or their addresses/CIDRs; never `true` (per-IP auth limits key on the client IP)
STORAGE_DRIVER=s3|filesystem  STORAGE_ENDPOINT=  STORAGE_REGION=ap-south-1  STORAGE_FORCE_PATH_STYLE=   # endpoint unset: AWS S3; set: BYO S3 (ADR-0018), path-style by default
STORAGE_BUCKET_STAGING=  STORAGE_BUCKET_UPLOADS=  STORAGE_BUCKET_ASSETS=  STORAGE_BUCKET_EXPORTS=  STORAGE_BUCKET_AUDIT=  STORAGE_BUCKET_PACKS=   # default fr-<bucket>
STORAGE_ACCESS_KEY_ID=  STORAGE_SECRET_ACCESS_KEY_FILE=  STORAGE_SSE=none|AES256|aws:kms  STORAGE_SSE_KMS_KEY_ID=  STORAGE_PUBLIC_ENDPOINT=   # keys unset: the SDK chain (IRSA)
MAILER_DRIVER=smtp|log  SMTP_URL_FILE=  MAIL_FROM=no-reply@form.example  MAIL_FROM_NAME=fORM-
AUTH_SECRET_FILE=/run/secrets/auth_secret             # api: ≥ 32 bytes base64url; daily IP-hash salt, account throttle keys, OAuth transaction cookie
PASSWORD_BREACH_CHECK=hibp|off                        # api: HIBP k-anonymity; default hibp on SaaS with open egress, always off when air-gapped
OIDC_GOOGLE_CLIENT_ID=  OIDC_GOOGLE_CLIENT_SECRET_FILE=  OIDC_MICROSOFT_CLIENT_ID=  OIDC_MICROSOFT_CLIENT_SECRET_FILE=   # SaaS only; ignored on-prem with a notice
AUTH_TOTP_ISSUER=fORM-                                # api: the issuer authenticator apps show
PRIVACY_FIDUCIARY_NAME=fORM-  PRIVACY_CONTACT_EMAIL=privacy@form.example  PRIVACY_CONTACT_NAME=   # api: named in the builder-user privacy notice (CMP-21); the email is required in production
KMS_DRIVER=aws|gcp|azure|vault|keyfile  KMS_KEY_ID=  KMS_KEYFILE_PATH=/run/secrets/form-master.key  KMS_ENDPOINT=  KMS_REGION=   # api and worker (@form/config parseKmsConfig)
KMS_SIGNING=app|kms-native  KMS_SIGNING_SEED_FILE=/run/secrets/form-signing-seed  KMS_NATIVE_SIGNING_KEYS=audit-v1=<provider key>,…   # app: Ed25519 from a KMS-sealed seed
KMS_GCP_CREDENTIALS_FILE=  KMS_AZURE_TENANT_ID=  KMS_AZURE_CLIENT_ID=  KMS_AZURE_CLIENT_SECRET_FILE=
KMS_VAULT_ADDR=  KMS_VAULT_MOUNT=transit  KMS_VAULT_AUTH=token|kubernetes  KMS_VAULT_TOKEN_FILE=  KMS_VAULT_ROLE=  KMS_VAULT_CA_FILE=  KMS_VAULT_NAMESPACE=
AUDIT_SIGNING_KEY_ID=audit-v1  AUDIT_RETIRED_SIGNING_KEY_IDS=  AUDIT_SYSLOG_URL=tls://siem.corp.local:6514  AUDIT_SYSLOG_CA_FILE=  AUDIT_RETENTION_YEARS=7   # worker: checkpoint signing and anchoring (§2.7)
AUDIT_OTLP_URL=https://otel.corp.local:4318  AUDIT_OTLP_HEADERS_FILE=   # worker: OTLP/HTTP logs instead of syslog (one of the two)
AUDIT_CHAIN_POLL_MS=250  AUDIT_DATABASE_POOL_MAX=2  DATABASE_AUDIT_POOL_MAX=2   # worker dispatcher; separate audit pools (worker, api)
AV_DRIVER=clamav|none  CLAMAV_HOST=clamav:3310
CAPTCHA_DEFAULT=proof_of_work                         # every edition (ADR-0011); a third-party value is rejected
CAPTCHA_PROVIDERS=hcaptcha,turnstile,recaptcha_v3     # third-party providers forms may opt in to; default: all when EGRESS_POLICY=open, none otherwise; rejected when none
INTEGRATIONS_ENABLED=google_sheets,slack              # @form/schema INTEGRATION_PROVIDERS; default: all when open, none otherwise; rejected when none
PAYMENTS_ENABLED=stripe,razorpay                      # ignored when EGRESS_POLICY=none
GEOIP_DB_PATH=/opt/form/geoip/dbip-country-lite.mmdb
GUARDIAN_VERIFIERS=existing_account,manual_review[,digilocker]   # digilocker SaaS only (CMP-22)
STATUTORY_RETENTION_FLOOR_DAYS=365                    # CMP-23; configurable on-prem
NTP_SERVERS=time.nplindia.org,samay1.nic.in           # air-gapped: internal NTP; checked at boot (TOTP, retention, audit, CERT-In)
RUNTIME_MODE=embedded|standalone
LICENSE_FILE=/run/secrets/form.license                # onprem only
OTEL_EXPORTER_OTLP_ENDPOINT=  LOG_LEVEL=info
TEMPLATES_SEED_SYSTEM_PACKS=true  TEMPLATES_EXTRA_PACK_DIR=/opt/form/packs/extra
```

**Feature resolution** (API, worker, builder via `GET /v1/meta/features`, template `requiredFeatures`):
```ts
effectiveFeatures(org) =
  editionDefaults[DEPLOYMENT_MODE][EGRESS_POLICY]   // air-gapped: no google_sheets, no stripe, no third-party captcha, no GA4, no digilocker
  ∩ (DEPLOYMENT_MODE === 'saas' ? planFeatures(org.plan) : license.features)
  ∩ orgAdminRestrictions(org)                        // P3 ENT-09
```
A disabled feature is hidden in the palette and gallery and rejected at publish (`422 TEMPLATE_FEATURE_UNAVAILABLE` / `missing_capability`).

The edition factor (`@form/config` `isEditionFeatureAvailable`) gates these `FeatureId`s (ADR-0002 §4): `integration:<provider>` (`INTEGRATIONS_ENABLED`), `field:payment` and `capability:payments` (a payment gateway is enabled), `capability:guardian_digilocker` (`GUARDIAN_VERIFIERS`), `capability:captcha_<provider>` (`CAPTCHA_PROVIDERS`; `captcha_proof_of_work` always passes) and `capability:analytics_<provider>` (off when air-gapped). Every other id passes the edition check and is left to plan, licence and org restrictions.

**Licence (on-prem):** compact JWS (EdDSA), public keys baked into the image with key ids; claims `{ lid, customer, tier, seats, maxOrgs, features[], nbf, exp, graceDays: 30 }`; verified offline at boot and every 6 h. **On expiry plus grace, authoring is blocked (publish, invite, create), but live forms keep collecting and data stays readable and exportable** (ADR-0010). SaaS has no licence; plans and quotas live in the DB.

---

## 2. Data model (Postgres 18; external Postgres ≥ 16 supported)

### 2.1 Conventions, roles and definer functions

- **Ids:** UUIDv7 generated in the app. Submissions derive their partition key from the id timestamp (§2.4).
- **Tenant tables:** `org_id uuid not null` first; `created_at`, `updated_at`, optional `deleted_at`, `created_by`; every index leads with `org_id` unless globally unique.
- **jsonb** holds versioned documents; relational columns hold what is queried, joined or enforced. Money is `bigint` minor units in tables and `MinorUnits` strings on the wire.
- **Drizzle owns table definitions.** Partitioning, triggers, definer functions and tsvector triggers are hand-written SQL migrations in the same folder.
- **Extensions:** `pgcrypto`, `pg_trgm`, `unaccent`, `btree_gin`, `btree_gist` (checked by `form-admin preflight`).

| Role | Used by | Rights |
|---|---|---|
| `fr_migrator` | migrate job, `form-admin` | Owns the schema; DDL; owns the definer functions. Never used by request traffic |
| `fr_app` | api, worker, runtime | `NOBYPASSRLS`. DML on tenant tables. **No** `UPDATE`/`DELETE` on `audit_log`, `consent_records`, `disclosures`, `form_versions`, published `template_versions`. **No privileges at all on schema `parts`** (partitions) |
| `fr_template_seeder` | `templates.seed` job | Writes `org_id IS NULL` rows in template tables only |
| `fr_system_agg` | stats and rollup handlers only (separate secret and pool) | `BYPASSRLS` **SELECT only** on rollup sources (`analytics_events`, `template_usages`, `form_template_bindings`, submission counts); INSERT on rollup tables. No access to answers |
| `fr_platform` | `/platform` routes, break-glass | `BYPASSRLS`; pool created only while a break-glass grant is active; every statement inside `audit_platform()` |

**`SECURITY DEFINER` functions** (owned by `fr_migrator`, `SET search_path = pg_catalog, public`, EXECUTE granted narrowly, each call audited where it touches data):

| Function | Purpose | Granted to |
|---|---|---|
| `resolve_slug(slug)` → `(org_id, form_id, live_version_id, status_flags)` | Runtime pre-tenant lookup | `fr_app` |
| `auth_user_by_email(email_norm)`, `auth_session(token_hash, idle_seconds)` | Login and session lookup; `auth_session` returns the state (active, revoked, expired, user inactive) and slides the idle expiry | `fr_app` |
| `auth_user_credentials(user_id)`, `auth_create_user(…)`, `auth_recovery_code_use(user_id, hash)`, `auth_identity_user(provider, subject)`, `auth_token_take(hash, purpose)`, `auth_token_peek(hash, purpose)`, `auth_mfa_ticket(hash)`, `auth_throttle_hit(bucket, key, window)` | WP-1.01 (ADR-0017 as built): second factor and credential reads, sign-up, single-use recovery codes, OAuth identity lookup, single-use email tokens and the account a live link is for, MFA ticket attempts, the auth rate-limit counters | `fr_app` |
| `api_key_lookup(prefix)` | API key auth | `fr_app` |
| `invite_by_token(token_hash)` | Invite acceptance | `fr_app` |
| `list_user_orgs(user_id)`, `membership_for(user_id, org_id)` | `GET /v1/orgs`, `X-FR-Org` validation | `fr_app` |
| *As built (WP-1.02):* `membership_for(user_id, org_id)` → `(role, grants[])`, `create_org(…)`, `invite_by_token(token_hash)` (a description of the link, without using it), `invite_accept(token_hash, user_id)`, `member_sessions_revoke(user_id)`, `member_access_token(user_id, token_id, token_hash, minutes)` | `grants` are the permissions org settings add to a role (an editor approving notices, CMP-24). `create_org` and `invite_accept` run only for the signed-in user themselves (`app_user()`, actor `user`); `invite_accept` adds the membership for the invited, verified address only. `member_sessions_revoke` (after a role or status change) and `member_access_token` (BL-203: a one-time reset or verification link, without SMTP, for a member of no other org) need `members.manage` in the current org | `fr_app` |
| `orgs_due_for(job text)` → `setof uuid` | Org-spanning jobs list the orgs with work due; the job then runs one `withTenant` per org | `fr_app` (worker connection only) |
| `resolve_job_org(resource_type, resource_id)` → `org_id` | Job handlers re-derive the org from the resource and abort on mismatch (§5.1) | `fr_app` |
| `create_partitions(parent regclass, months int)` | Creates partitions in schema `parts`, enables and forces RLS on each, grants nothing to `fr_app` | `fr_app` (worker) |
| `consent_pseudonymise(submission_id)` | On erasure: nulls `submission_id` on `consent_records`, keeps `principal_bidx` as proof of consent (s.6(10)) | `fr_app` (worker) |
| `org_purge(org_id)` | Org deletion (CMP-17), including `form_versions` | `fr_app` (worker, `org.delete` only) |
| `statutory_hold_move(submission_id)` / `statutory_hold_purge()` | Moves expired or erased data into the hold store (CMP-23) and purges at the floor date | `fr_app` (worker) |
| `template_for_binding(binding_id)` | Reads a soft-deleted template for diffs and lineage | `fr_app` |
| *As built (WP-T1.1):* `template_delete(template_id)`; trigger function `template_rows_guard()` | Soft deletion of a template the caller can see (an UPDATE's new row must pass the read policy, which hides deleted rows); the trigger sets child rows' `org_id` from the true parent and refuses references to another org's rows (§2.8) | `fr_app` (the trigger function is granted to nobody) |
| *As built (migration 0019, security review of the public routes):* `form_files_check(form_id, ids[])` → `(id, block_id, purpose, name, mime, size_bytes, sha256)`; trigger function `form_submission_recorded()` | `form_files_check` is the one question the submit route asks about uploads: for at most 100 ids, the rows of that form in the context's own org (`app_org()`), as the upload route recorded them (the field, the kind, the name and type the upload check approved, the true size and hash). It lists nothing without ids and answers only inside a tenant context, so it can neither list an org's files nor look into another's; the route rewrites each file reference in the answers from these rows and never believes the respondent's copy (SR-1). `form_submission_recorded()` is the `AFTER INSERT` trigger on `submissions` (on `form_submissions` until migration 0021 moved it, keeping name, owner and grants): in the statement that inserts a response it counts the response on `forms.submission_count` and `last_submission_at`, and holds the files the answers name (`"fileId": "<uuid>"` in the jsonb text; only files of the same org and form that no response holds yet) by setting `form_files.submission_id` and `submission_received_at`. It runs as the owner, so a respondent context needs no write on `forms` or `form_files`, which the restrictive policies of 0019 refuse it. EXECUTE is revoked from public | `fr_app` (`form_files_check`); the trigger function is called by the trigger only |
| *As built (migration 0020, WP-1.07):* `form_access_password_hash(form_id)` → `text`; `resolve_form_slug(slug)` → `(org_id, form_id, live_version_id, primary_slug)` | `form_access_password_hash` is the only reader of `form_access.password_hash`, which `fr_app` cannot select (§2.4): it answers `respondent` and `system` contexts only, for a form of the context's own org, and returns null for a form with no password or in another org, so a caller learns nothing about other orgs' forms. `resolve_form_slug` is `resolve_slug` as built (created by 0013, rewritten by 0020 to read `form_slugs`): an old address finds its form too, `primary_slug` is where to redirect, and a form that is archived, trashed or not published resolves to nothing. The trigger functions of 0020 (`form_versions_immutable`, `form_versions_state_created`, `forms_slug_registered`, `forms_counter_created`, `users_forget_favourites`) are described with their tables in §2.4 | `fr_app` |
| *As built (migration 0023, WP-1.16, WP-1.18):* `secret_enc(secret_id)` → `jsonb`; `resolve_job_org(resource_type, resource_id)` rewritten | `secret_enc` is the one reader of `secrets.enc` (§2.4): `fr_app` cannot select that column, and this function answers only the `system` actor, only for the context's own org, and null for an id of another org or of no secret; any other actor gets `42501`, the answer the column grant gives. The worker sending a message or a webhook uses it, and so does the API's test send, which opens a system context for the one read. `resolve_job_org` keeps its signature, owner and grant and learns three resources, `email_message`, `webhook_delivery` and `export`, which are the rows the child jobs name (§5.3); a partitioned log row is found by id alone because the primary key `(id, created_at)` leads with `id`. The four earlier cases are unchanged | `fr_app` |
| *As built (migrations 0022 and 0024, WP-2.33):* `review_open(submission_id, received_at, form_version_id, units jsonb, respondent_emails text[])` → `(unit_count, pending_count, excluded_count)`; `review_decide(submission_id, received_at, unit_id, decision, reason_code, answers_hash, idempotency_key, decision_id)` → `(outcome, decision_id, unit_state, submission_status, replayed)`; trigger functions `submissions_review_status_guard()` and `review_decisions_append_only()` | The only door to the review tables and to the statuses `pending_review` and `rejected` (§2.4, "Section-level review"). Both run as the table owner. `review_open` writes the round-1 rows of a response the submit transaction has just stored `pending_review`, and records which members its respondent's email answers exclude from checking it; it raises, so the submit rolls back, for a response that is not held, already has rows, is another org's, or has no required applicable unit. `review_decide` checks in one transaction the permission `submissions.review`, membership of the group the unit was opened with, two-factor sign-in when the org requires it, the unit's order, the current `answers_hash` and the four-eyes rule; it locks the response row first and the unit row second, so the decisions of one response take turns; it returns each refusal as an outcome (`permission_denied`, `not_found`, `idempotency_key_reused`, `not_in_group`, `mfa_required`, `review_closed`, `order_blocked`, `review_stale`, `four_eyes_violation`) and writes nothing for it, replays a retried `idempotency_key` as its first result, and finalises the response (`complete` or `rejected`) when the rules say so. **Neither appends an audit event:** the API does, in the same transaction (§2.7; BL-295). `submissions_review_status_guard` is the `BEFORE UPDATE OF status` trigger on `submissions` (so on every partition, the months made later included) that refuses, with `42501`, a status change into or out of either review status unless the session user is the table's owner. `review_decisions_append_only` refuses UPDATE and DELETE to everyone but the owner, whom the definers and the `ON DELETE CASCADE` of the foreign key to `submissions` (run by the owner of the table deleted from) need | `fr_app` (`review_open`, `review_decide`); the trigger functions are called by their triggers only |
| `audit_chain_begin()`, `audit_pending_take(limit)`, `audit_log_append(rows)` | The chain worker: take the head (skip-locked), move pending rows, append hashed rows. Only for actor `system` inside the tenant of the chain (§2.7) | `fr_app` (worker) |
| `audit_pending_keys()`, `audit_chain_keys()` | Chains with pending rows (the dispatcher) and every chain (checkpoint, verify, archive); keys only. Only for actor `system` inside the platform tenant | `fr_app` (worker) |
| `audit_archive_detach(month)` | Detaches an audit_log month outside the 13-month window once every chain in it is archived with the same row count. Only for actor `system` inside the platform tenant | `fr_app` (worker) |

### 2.2 Tenant context and RLS mechanics

```sql
create function app_org()   returns uuid   language sql stable as $$ select nullif(current_setting('app.org_id',  true),'')::uuid $$;
create function app_user()  returns uuid   language sql stable as $$ select nullif(current_setting('app.user_id', true),'')::uuid $$;
create function app_perms() returns text[] language sql stable as $$ select coalesce(nullif(current_setting('app.perms', true),'')::text[], '{}') $$;
create function app_teams() returns uuid[] language sql stable as $$ select coalesce(nullif(current_setting('app.team_ids', true),'')::uuid[], '{}') $$;
create function app_actor() returns text   language sql stable as $$ select coalesce(nullif(current_setting('app.actor_kind', true),''), 'none') $$;
create function app_subject_ids() returns uuid[] language sql stable as $$ select coalesce(nullif(current_setting('app.subject_ids', true),'')::uuid[], '{}') $$;
-- actor_kind ∈ user | api_key | respondent | system | platform
```

**Every policy uses these helpers, wrapped in sub-selects** (`(select app_user())`), never `current_setting(...)::uuid` directly: actors without a user id (API keys, jobs, respondents) would otherwise raise on `''::uuid`, and unset settings would raise without `missing_ok`.

```ts
// packages/db/src/tenant.ts
export async function withTenant<T>(db: Db, ctx: TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.org_id',      ${ctx.orgId}, true),
      set_config('app.user_id',     ${ctx.userId ?? ''}, true),
      set_config('app.team_ids',    ${pgArray(ctx.teamIds)}, true),
      set_config('app.perms',       ${pgArray(ctx.perms)}, true),
      set_config('app.actor_kind',  ${ctx.actor}, true),
      set_config('app.subject_ids', ${pgArray(ctx.subjectIds ?? [])}, true),
      set_config('app.request_id',  ${ctx.requestId}, true)`);
    return fn(tx);
  }, { isolationLevel: ctx.isolation ?? 'read committed', accessMode: ctx.readOnly ? 'read only' : 'read write' });
}
```

- `set_config(..., true)` is transaction-scoped, safe behind PgBouncer in transaction mode.
- `FORCE ROW LEVEL SECURITY` on every tenant table; the standard policy is `org_id = (select app_org())` for USING and WITH CHECK.
- **Submission data access** has an extra **restrictive** policy:

```sql
create policy submissions_data_access on submissions as restrictive for select to fr_app using (
     (select app_actor()) = 'system'
  or ((select app_actor()) = 'respondent' and id = any ((select app_subject_ids())))
  or 'submissions.read' = any ((select app_perms())::text[]) );
create policy submissions_respondent_insert on submissions for insert to fr_app
  with check (org_id = (select app_org()));
```
A respondent context can read only the submissions whose ids were placed in `app.subject_ids` **after** a signed token (edit, receipt, resume, withdrawal) was verified; by default it can only INSERT. A bug in a `/f/*` or `/s/*` route therefore cannot expose the tenant (C-M8, F-22). The same pattern applies to `partial_submissions`, `consent_records`, `submission_files` and `submission_search` (the answer text of the search index). *As built (WP-1.03):* `submission_search` carries `submission_search_data_access` (SELECT) and restrictive UPDATE and DELETE policies on the same rule (DELETE: system or `submissions.read` only), so the respondent's submit transaction can only INSERT its document; the Postgres `SearchIndex` therefore writes with an UPDATE of the documents it may read plus `insert … on conflict do nothing` without a conflict target, since `ON CONFLICT DO UPDATE` and a conflict target both need read access.

### 2.3 RLS isolation test suite (CMP-01, TPL-04)

`packages/testkit/rls` has a declarative DSL:
```ts
isolation('submissions', { seed: twoOrgs(), as: [orgB.editor, orgB.apiKey, systemJob(orgB), respondent(orgB, otherSubmission)],
  expect: { select: 0, update: 'denied', insertForeignOrg: 'denied', noError: true } })
```
- Runs against Testcontainers Postgres with the real migrations, **for every actor kind**.
- **Meta-tests** read `pg_class`, `pg_policies`, `pg_inherits` and `information_schema.role_table_grants` and fail if:
  - any table in `public` with an `org_id` column lacks `relforcerowsecurity` or a `*_tenant` policy;
  - any **partition** (`pg_inherits` child) grants any privilege to a role other than its owner, or lacks forced RLS;
  - any policy text contains `current_setting(` outside the helper functions.
- A direct `SELECT * FROM parts.submissions_2027_05` as `fr_app` must fail with "permission denied".
- *As built (WP-1.02):* the DSL lives in `packages/db/test/isolation.ts` (testkit cannot depend on `@form/db`). `rls.int.test.ts` lists every table in `public` once (`TABLES`: how its rows belong to an org or a person, and whether SELECT, UPDATE and DELETE of the other org's rows see 0 rows or are denied), a test fails while a table is missing, and the suite is generated per table and actor kind (`user`, `api_key`, `system`, `respondent`, `platform`): SELECT, UPDATE and DELETE aimed at org A, and an INSERT of a copy of one of org B's rows re-pointed at org A (restricted to the columns fr_app may insert, so RLS's WITH CHECK, which runs before constraints, is what refuses it).
- *As built (WP-1.06):* the same idea exists one level up, for routes. `apps/api/test/isolation.int.test.ts` collects every registered route through an `onRoute` hook (`buildApp` takes an optional `onRoute` dependency) and fails for an `auth: 'user'` or `auth: 'account'` route that has no case in `apps/api/test/isolation-cases/` (a route with no `auth` setting counts as `user`: default deny), for a case whose route no longer exists, and for a route with two cases. Each case runs as a fresh member of org B (a real session, owner role, so a refusal is never for want of a permission) against org A's ids: the answer must be 404 or hold none of org A's identifiers, org A's rows must hash the same as before any case ran (the snapshot covers every table with an `org_id` column, so a table a later work package adds is checked without editing the suite), and the same request naming org A must be a 403 that appears on the platform audit chain (an `account` route ignores the header instead). A route with `auth: 'none'` is not in this suite: each has its own review (CONTRIBUTING §5). The cases live in one file per domain (§3.2).

### 2.4 Tables

Drizzle definitions for the core; the longer tail as column specs with the same conventions. Phase tags show when each table lands.

#### Identity, orgs and access (P1)

```ts
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),              // saas; onprem: 'licensed'
  region: text('region').notNull().default('in-mum-1'),      // CMP-16 (DR: in-hyd-1)
  locale: text('locale').notNull().default('en-IN'),
  timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
  dateFormat: text('date_format').notNull().default('DD-MM-YYYY'),
  status: text('status').notNull().default('active'),         // active | suspended | pending_deletion | deleted
  deletionScheduledAt: timestamp('deletion_scheduled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
// policy: select using (id = (select app_org())); signup uses create_org() SECURITY DEFINER; cross-org listing via list_user_orgs()

export const users = pgTable('users', {        // global identity; the platform is Fiduciary for this data (CMP-21)
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  emailNorm: text('email_norm').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  name: text('name'), locale: text('locale'),
  passwordHash: text('password_hash'),                         // argon2id m=64MiB,t=3,p=1
  totpSecretEnc: jsonb('totp_secret_enc'),
  totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  recoveryCodeHashes: text('recovery_code_hashes').array(),
  status: text('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, () => [
  pgPolicy('users_visible', { for: 'select', to: fr_app, using: sql`id = (select app_user()) or exists
    (select 1 from memberships m where m.user_id = users.id and m.org_id = (select app_org()))` }),
  pgPolicy('users_self_update', { for: 'update', to: fr_app, using: sql`id = (select app_user())` }),
]).enableRLS();

export const identities = pgTable('user_identities', {   // OAuth; later SAML/OIDC via Jackson, LDAP
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(), subject: text('subject').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.provider, t.subject),
  pgPolicy('identities_self', { for: 'all', to: fr_app, using: sql`user_id = (select app_user())` })]).enableRLS();

export const memberships = pgTable('memberships', {
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),               // owner | admin | editor | viewer (P1); + creator | data_collaborator | data_viewer (P2)
  customRoleId: uuid('custom_role_id'),       // P3
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index().on(t.userId), ...tenantRls('memberships')]).enableRLS();

export const sessions = pgTable('sessions', {   // opaque tokens; only SHA-256 stored
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id),
  activeOrgId: uuid('active_org_id'),
  mfaLevel: text('mfa_level').notNull(),          // first factor pwd | link | oauth | sso, then +totp or +recovery when used (as built)
  ipHash: bytea('ip_hash'), uaSummary: text('ua_summary'),
  createdAt: ts('created_at'), lastSeenAt: ts('last_seen_at'),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),       // 12 h
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(), // 14 d
  revokedAt: tsNull('revoked_at'),
}, (t) => [index().on(t.userId),
  pgPolicy('sessions_self', { for: 'all', to: fr_app, using: sql`user_id = (select app_user())` })]).enableRLS();
// lookup by token only through auth_session()
```
`invites (id, org_id, email_norm, role, team_ids, token_hash unique, expires_at, invited_by, accepted_at)` with the tenant policy; acceptance through `invite_by_token()`.

*As built (WP-1.31, migration 0007):* `users.deleted_at` (set with status `deleted`: the row is then a tombstone, `deleted-<id>@deleted.invalid`, every credential and name cleared); `user_notice_acks (id, user_id, notice_version, notice_hash, locale, context: signup|oauth_signup|settings, acknowledged_at)`, unique per user and text, append-only, kept after deletion; `user_grievances (id, user_id, reference GRV-…, category, message, status open|answered|closed, created_at, due_at ≤ 90 d, closed_at)`, the message cleared on deletion. Both tables have a `*_self` policy (a user actor's own rows, like `sessions`); fr_app may only insert and read them. `account_export_data()` and `account_delete(user, apply)` are definer functions that refuse any caller but the user in their own context (`withUser`); `account_org_plan()` behind them names the blocker per org (`last_member`, `sole_owner`, `no_owner_for_forms`) and the owner who takes the forms.
*As built (WP-1.02, migration `0008_orgs.sql`):* `invites` also keeps `email` (as typed), `created_at`, `accepted_by` and `revoked_at`; one open invite per address and org; at most 30 days; accepted and revoked invites are final (trigger); a restrictive `invites_manage` policy needs `members.manage`; fr_app cannot read `token_hash` and may insert only the invite's own columns. `org_settings (org_id, editors_approve_notice, invite_days, updated_at, updated_by)` holds the per-org settings (writes need `org.settings`); later WPs add their columns (`templates`, `brand`). `orgs` gains format checks for the slug, locale and date format, and writes need `org.settings`. RLS repeats the role checks of the API (WSP-03): restrictive policies make member changes need `members.manage` (a member may delete their own row: leaving) and draft writes need `forms.edit`, for every actor but `system`. A trigger keeps an active owner in every org. The session's `active_org_id` is the org switcher's choice and the default when a request names no `X-FR-Org`.

**Permissions** (code constant in `apps/api/src/authz/roles.ts`, loaded into `app.perms`):

| Permission | owner | admin | editor | creator (P2) | data_collaborator (P2) | data_viewer (P2) | viewer |
|---|---|---|---|---|---|---|---|
| `forms.create/edit/publish` | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `forms.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `submissions.read` | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| `submissions.edit/delete` | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `submissions.export` | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `ops.manage` (notifications to data roles, access, slugs) | ✓ | ✓ | ✓ | ✓ | – | – | – |
| **`data.route`** (webhooks, integrations, external notification recipients, upload/PDF attachments, redirect endings that pipe answers) | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `compliance.approve_notice` (CMP-24) | ✓ | ✓ | grantable | – | – | – | – |
| `compliance.dsr`, `compliance.retention`, `compliance.legal_hold`, `compliance.statutory_access` | ✓ | ✓ | – | – | – | – | – |
| `members.manage`, `org.settings` | ✓ | ✓ | – | – | – | – | – |
| `billing.manage` | ✓ | – | – | – | – | – | – |
| `api_keys.manage` | ✓ | ✓ | – | – | – | – | – |
| `templates.*` | as in templates spec §2.3; `templates.govern` = owner and admin | | | | | | |
| `brand_kits.manage`, `org_profile.manage` | ✓ | ✓ | – | – | – | – | – |

`data.route` closes the exfiltration path where a Creator, who may not read answers, could route future answers to themselves (F-24). The redirect allowlist is mandatory for redirect endings that pipe answers.

#### Workspaces, folders and forms (P1; teams in P2)

```ts
export const teams = pgTable('teams', {          // P1: one implicit default team per org
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull().references(() => orgs.id),
  name: text('name').notNull(), slug: text('slug').notNull(), isDefault: boolean('is_default').notNull().default(false),
  createdAt: ts('created_at'), deletedAt: tsNull('deleted_at'),
}, (t) => [uniqueIndex().on(t.orgId, t.slug), ...tenantRls('teams')]).enableRLS();
// team_members (org_id, team_id, user_id, role: team_admin|member) pk(team_id,user_id)
// folders (id, org_id, team_id, parent_id, name, color)  — WSP-07

export const forms = pgTable('forms', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  teamId: uuid('team_id').notNull(), ownerUserId: uuid('owner_user_id').notNull(),
  title: text('title').notNull(),
  lifecycle: text('lifecycle').notNull().default('active'),     // active | archived | trashed
  trashedAt: tsNull('trashed_at'),
  liveVersionId: uuid('live_version_id'),
  hasSensitive: boolean('has_sensitive').notNull().default(false),
  noticeApprovedHash: bytea('notice_approved_hash'),             // CMP-24: last approved notice/purpose/basis hash
  templateOrigin: jsonb('template_origin').$type<TemplateOriginStamp>(),
  brandKitId: uuid('brand_kit_id'),
  labels: uuid('label_ids').array().notNull().default(sql`'{}'`),
  submissionCount: bigint('submission_count', { mode: 'number' }).notNull().default(0),
  lastSubmissionAt: tsNull('last_submission_at'),
  createdAt: ts('created_at'), updatedAt: ts('updated_at'), updatedBy: uuid('updated_by'),
}, (t) => [
  index('forms_list').on(t.orgId, t.teamId, t.lifecycle, t.updatedAt.desc()),
  index('forms_title_trgm').using('gin', sql`title gin_trgm_ops`),
  ...tenantRls('forms'),
]).enableRLS();
// form_shares (org_id, form_id, subject: user|team, subject_id, level: edit|data_read|data_edit|view) — WSP-04

export const formDrafts = pgTable('form_drafts', {   // 1:1 with forms (BLD-07)
  formId: uuid('form_id').primaryKey().references(() => forms.id),
  orgId: uuid('org_id').notNull(),
  draft: jsonb('draft').$type<FormDefinition>().notNull(),
  draftRev: integer('draft_rev').notNull().default(1),          // CAS; PUT requires If-Match
  schemaVersion: integer('schema_version').notNull(),
  baseVersionId: uuid('base_version_id'),
  sizeBytes: integer('size_bytes').notNull(),                    // cap 5 MB
  updatedAt: ts('updated_at'), updatedBy: uuid('updated_by').notNull(),
}, () => tenantRls('form_drafts')).enableRLS();
// form_draft_snapshots (id, org_id, form_id, draft_rev, draft jsonb, reason, created_at, created_by) — BLD-09; 30 d / last 200

export const formVersions = pgTable('form_versions', {   // IMMUTABLE (PUB-01)
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(), formId: uuid('form_id').notNull().references(() => forms.id),
  number: integer('number').notNull(), label: text('label'),
  schemaVersion: integer('schema_version').notNull(),
  definition: jsonb('definition').$type<FormDefinition>().notNull(),  // resolved: no var nodes / brand refs (I11)
  compiled: jsonb('compiled').$type<CompiledForm>().notNull(),
  runtimeProjection: jsonb('runtime_projection').notNull(),
  contentHash: bytea('content_hash').notNull(),
  engine: text('engine').notNull(), requires: text('requires').array().notNull(),
  templateLineage: jsonb('template_lineage').notNull().default(sql`'[]'`),
  variablesSnapshot: jsonb('variables_snapshot').notNull().default(sql`'{}'`),
  publishedAt: ts('published_at'), publishedBy: uuid('published_by').notNull(),
}, (t) => [uniqueIndex().on(t.formId, t.number), index().on(t.orgId, t.formId), ...tenantRls('form_versions')]).enableRLS();
// trigger form_versions_immutable: BEFORE UPDATE OR DELETE → raise (deletion only via org_purge())
// form_version_state (form_id, version_id, retired_at) — operational retirement (acceptPreviousVersionsHours)
```

**FormOps tables** (each change bumps `form_ops_rev` in the same transaction and writes an audit diff):

| Table | Key columns | Notes |
|---|---|---|
| `form_access` | `form_id pk, org_id, rev, enabled, open_at, close_at, availability, submission_limit, password_hash, password_updated_at, unique_submission, uniqueness_salt_enc, one_per_verified_email, embed_allowlist[], redirect_allowlist[], screens, accept_previous_versions_hours (72), require_auth` | `password_hash` is read only in `unlock.ts` (lint-enforced). `uniqueness_salt_enc` is a per-form salt whose lifetime equals the uniqueness window (ACC-07) |
| `form_slugs` | `slug pk, org_id, form_id, is_primary` | Old slugs 301 to the primary |
| `form_counters` | `form_id pk, org_id, submitted_total bigint` | Atomic limit counter (counts `complete` only; decremented on payment failure) |
| `form_id_counters` | `(form_id, block_id, period) pk, org_id, next_seq` | Gap-free unique IDs per block and reset period (FLD-32) |
| `notifications` | `id, org_id, form_id, kind, enabled, trigger, config jsonb, purpose_ids uuid[], template_binding_id, rev` | Live, unversioned |
| `pdf_templates` | `id, org_id, form_id, name, layout, origin` | EXP-05 |
| `coupons` / `coupon_redemptions` | `(org_id, form_id, code_norm unique, discount, max_redemptions, expires_at)` / `(coupon_id, submission_id, at)` | Redemption under `FOR UPDATE` |
| `product_stock` | `(org_id, form_id, product_id) pk, remaining, low_threshold` | Atomic decrement |
| `appointment_slots` | `(form_id, block_id, slot_start) pk, org_id, slot_end, capacity, used` | Booking = `UPDATE … SET used = used + 1 WHERE used < capacity RETURNING` (works for any capacity) |
| `appointment_holds` | `id, org_id, form_id, block_id, slot_start, hold_token_hash, expires_at, submission_id` | Holds count against capacity until `expires_at` (checked in the query); released by a 1-minute job |
| `holiday_calendars` | `id, org_id null, name, dates date[]` | System (Indian national/state) and org calendars (LOG-18, FLD-17, FLD-35) |

*As built (WP-1.06 and WP-1.07, migration `0020_form_ops.sql`).* Of the tables above, `form_access`, `form_slugs` and `form_counters` exist, and `form_id_counters` follows with migration 0021; the others arrive with their work packages. `form_version_state` and `form_favourites` exist too. What differs from the text above:

- **`form_versions`** is immutable for every role. A `BEFORE UPDATE OR DELETE` trigger raises `object_not_in_prerequisite_state` (SQLSTATE 55000), the owner included, and `fr_app` has no UPDATE or DELETE privilege, so a request is refused first with `42501`. The one way past is the org purge (CMP-17), which is not built (BL-271). Migration 0020 added `label`, `engine` (`logic@2`), `draft_rev` (the draft revision the version froze, so publishing a revision twice returns the version that exists; null for versions from before 0020 and for legacy versions), `template_lineage` and `variables_snapshot` (BL-241; publish writes `[]` and `{}` until WP-T1.3), and a unique `(org_id, form_id, id)` so every child names a version together with its org and form. `content_hash` is the hex text of the sha256 of the definition (the DDL above says `bytea`), and `submissions.definition_hash` holds the same 32 bytes. `runtime_projection` and `requires` are not columns: the public routes project the stored definition once per version (`projectForRuntime`) and keep the result in a size-bounded in-process cache until the runtime host stores it (WP-1.09).
- **`form_version_state (version_id pk, org_id, form_id, superseded_at, retired_at)`**: one row per version, made by an `AFTER INSERT` trigger on `form_versions`, so "mark the previous version superseded" is always an UPDATE of a row that exists. `fr_app` may change only the two dates, and a respondent context reads the row and never writes it. Publish sets `superseded_at` with the database's clock. Nothing sets `retired_at` yet (BL-270): whether an old version still takes responses is worked out at submit time from `superseded_at` and `form_access.accept_previous_versions_hours`.
- **`form_access`** has the columns above except those of ACC-07, ACC-09 and the sign-in requirement (WP-2.18 and P3). There is no separate `form_ops_rev`: `form_access.rev` is the revision, `PUT /v1/forms/:id/access` is a compare-and-swap on it (`If-Match`; 409 `ACCESS_REV_CONFLICT`, 428 without), and the audit record `form.access_changed` names the keys that changed, never their values (screens can hold any text). The password does not move `rev`. **`password_hash` is write-only for `fr_app`:** SELECT is granted column by column and leaves it out, so `select *`, a `RETURNING` of every column, a predicate on it, a grouping, a whole-row or JSON read all fail with `42501`, and a query that names its columns cannot leak the hash into a response by accident. Members set, replace and clear it with UPDATE (`null` means no password; the route sets `password_updated_at` in the same statement, and `hasPassword` is derived from that date). The one reader is the definer function `form_access_password_hash(form_id)` (§2.1), which the unlock route calls. The database enforces this, so the "lint-enforced" of the table above needed no lint rule. Respondent contexts read the rules, because a closed form has to say so, and never write them; there is no DELETE (the row lives with the form). `embed_allowlist` is stored and validated and enforced by nothing until the runtime host sends `frame-ancestors` (WP-1.09; a product-owner decision for this run); `redirect_allowlist` is checked at publish (`redirect_not_allowed`).
- **`form_slugs (slug pk, org_id, form_id, is_primary, created_at)`**: no DELETE for anyone, and only `is_primary` changes, because a released slug could be claimed by another org and every old link would then land on theirs. The trigger `forms_slug_registered` keeps it in step with `forms.slug`, which stays the form's current address: the new slug becomes primary, the previous primary stays as an old slug, and a slug that another form holds, current or old, in any org, is refused with `23505` (never a row-level error that would reveal another org's slug). `resolve_form_slug()` (§2.1) reads it.
- **`form_counters (form_id pk, org_id, submitted_total)`**: every form has a row (a trigger on `forms`; backfilled from `forms.submission_count`). A respondent context may change `submitted_total` and nothing else, and a member or an API key changes nothing. The submit transaction runs the guarded update for every response, not only for forms with a limit (§2.5).
- **`form_favourites (form_id, user_id, org_id, created_at; pk (form_id, user_id))`**, which the text above does not list: a member's stars. The restrictive policy `form_favourites_own` lets a `user` context see and change its own rows only, so an org owner cannot read a colleague's and no other actor kind reads any; `fr_app` may select, insert and delete. Starring a form that is not in the caller's org is a 404 and writes nothing. Account deletion leaves the `users` row as a tombstone, so the foreign key never cascades; the trigger `users_forget_favourites` deletes the stars when a user's status becomes `deleted`. PII manifest: column `user_id`, erase `delete`.

#### Submissions (P1): partitioned, encrypted, searchable

```sql
create table submissions (
  id uuid not null, received_at timestamptz not null,           -- received_at = uuid_v7_ts(id) (CHECK)
  org_id uuid not null, form_id uuid not null, form_version_id uuid not null,
  definition_hash bytea not null, answer_codec_version smallint not null,
  seq bigint not null,
  status text not null,     -- complete | pending_payment | payment_failed | pending_scan | pending_guardian_consent | pending_review | rejected | spam | archived | trashed
  answers jsonb not null,   -- StoredAnswer per block (EncryptedAnswer for encrypt fields)
  computed jsonb not null,  -- variables (tainted ones encrypted), path, endingId, firedRuleIds
  meta jsonb not null,      -- locale, source, durations, ipHash, uaHash (TTL), device, country, utm, spamScore, opsRev, originalSubmittedAt (imports)
  legacy_fields jsonb,      -- as built: the prototype's display rows [{ key, label, value }] of a response moved from form_submissions (migration 0021); null for every other response
  principal_bidx bytea[],   -- blind indexes of principalIdentifier fields → DSR lookup
  delete_after timestamptz not null, statutory_hold_until timestamptz,
  legal_hold boolean not null default false,
  read boolean not null default false, starred boolean not null default false,
  tags text[] not null default '{}', assignee_id uuid, workflow_state text, status_label text,
  archived_at timestamptz, trashed_at timestamptz, revision int not null default 1, updated_at timestamptz not null,
  primary key (id, received_at),
  constraint submissions_id_ts check (received_at = uuid_v7_ts(id))
) partition by range (received_at);
create index submissions_grid   on submissions (org_id, form_id, received_at desc) where trashed_at is null;
create index submissions_unread on submissions (org_id, form_id) where read = false and trashed_at is null;
create index submissions_due    on submissions (delete_after) where legal_hold = false;
create index submissions_principal on submissions using gin (principal_bidx);
create index submissions_status on submissions (org_id, form_id, status) where status <> 'complete';
```

**Partitioning:**
- Monthly range partitions on `received_at`, created **in schema `parts`** by `create_partitions()` (worker cron `partitions.maintain`, 3 months ahead). `fr_app` has no privileges on `parts`, so partitions can be reached only through the RLS-protected parent; each partition also has RLS enabled and forced as a second guard (F-2).
- **There is never a default partition for data.** A row outside existing partitions fails loudly.
- Why time and not hash by org: grid, exports and retention are time-bounded; VACUUM and indexes stay small. Per-org deletion uses the `(org_id, …)` indexes.
- Lookups by id add `received_at = uuid_v7_ts($id)` (`submissionKey(id)` helper), touching one partition.
- **Imports (SUB-18, BLD-15):** imported rows get a fresh uuidv7 at import time (`received_at` = import time) and keep the historic date in `meta.originalSubmittedAt`; the retention basis is configurable (`submitted_at` or `original_submitted_at`). No historic partitions are needed.
- Retention never drops whole partitions (retention differs per form). Empty partitions older than the longest possible retention + 30 days are detached and dropped.

| Satellite table | Shape | Notes |
|---|---|---|
| `submission_idempotency` | `(org_id, form_id, key) pk, submission_id, received_at, response_enc jsonb, expires_at` | RLS. 24 h TTL. The stored response is encrypted with the secrets DEK (edit and receipt tokens); a replay re-mints short-lived tokens instead of returning stored ones |
| `submission_files` | `id pk, org_id, form_id, submission_id null, submission_received_at null, draft_id null, block_id, row_id null, object_key, bucket (staging\|uploads), name, size_bytes, mime_sniffed, sha256, status, encrypted, enc, created_at, scanned_at` | Bound to the draft or submission when one exists, else to the render session. Orphan GC after 24 h |
| `submission_search` | `(submission_id, received_at) pk, org_id, form_id, doc tsvector`, partitioned like submissions | Non-sensitive, non-tainted answers only, `simple` + unaccent. **`btree_gin` index on `(form_id, doc)`** per partition, so a search never scans other tenants' documents. As built (WP-1.03, migration 0010): the restrictive data-access policies of §2.2; also `locale` and `updated_at`, no foreign key to the submission (which may land later in another partition set); `partitions.maintain` keeps its months; the Postgres `SearchIndex` adapter writes and queries it |
| `captcha_redemptions` (WP-1.03) | `(org_id, challenge_hash) pk, expires_at, redeemed_at` | RLS. A proof-of-work challenge passes once across replicas; rows expire with the challenge (10 min); `purgeExpired` deletes them, called from the `drafts.expire` sweep once WP-1.13 wires proof of work into submit (BL-258). The salt is `<24 hex>?expires=<unix s>&` and verify accepts exactly that shape, with an expiry at most one lifetime (plus 60 s skew) ahead, so digits of the solution cannot be moved into the salt to extend it |
| `submission_bidx` | `(org_id, form_id, block_id, bidx, submission_id, received_at)` | Equality lookups for VAL-11 and CMP-08 |
| `submission_revisions` | `(submission_id, revision) pk, org_id, by, mode, changed, at` | Append-only (SUB-10); follows the submission's retention |
| `submission_comments` (P2) | `id, org_id, submission_id, author_id, body, mentions, created_at` | Erased with the submission |
| `partial_submissions` (P2) | `id, org_id, form_id, form_version_id, answers (encrypted), current_page_id, path, locale, resume_token_hash unique, email_bidx, expires_at (≤ 60 d)` | Holds only legitimate-use fields and fields whose consent is already granted (C-M4) |
| `consent_records` (P1) | `id, org_id, form_id, submission_id null, submission_received_at, block_id, item_id, purpose_id, granted, subject, form_version_id, notice_version, notice_hash, locale, at, source, vpc jsonb, principal_bidx` | **Append-only**. Withdrawal inserts `granted=false`. On erasure, `consent_pseudonymise()` nulls `submission_id` and keeps `principal_bidx` (proof of consent, s.6(10)); retained for purpose retention + 1 year (counsel to confirm) |
| `disclosures` (P1) | `id, org_id, submission_id, submission_received_at, recipient_kind, recipient_id, display_name, field_keys[], at` | **Append-only ledger** of who received data (s.11(1)(b)); written by notification, webhook, integration, export, workflow and API-key paths; kept for the submission's life; included in DSR exports (C-M6) |
| `statutory_hold` (P1) | `id, org_id, form_id, source_table, source_id, payload_enc (separate statutory DEK), processed_at, hold_until, reason` | CMP-23: no search, no export, no processing; read only with `compliance.statutory_access` (audited); purged by `statutory_hold_purge()` |
| `saved_views` (P2) | `id, org_id, form_id, user_id, name, filter, columns, sort, shared` | SUB-06 |
| `prefill_links` (P2) | `id, org_id, form_id, token_hash unique, data_enc, locked_keys[], expires_at, used_at` | PRE-03; data never in the URL; erased by DSR |
| `signed_links` | `id, org_id, purpose (edit\|receipt\|withdraw\|resume\|workflow_action\|dsr_confirm\|guardian_verify), subject_id, token_hash unique, expires_at, used_at` | `/s/:token`; 32-byte random tokens, stored hashed |
| `respondent_tokens` (P2) | `id, org_id, form_id, device_token_hash, created_at, expires_at` | ACC-07 |
| `otp_challenges` (P2) | `id, org_id, form_id, email_bidx, code_hash, attempts, expires_at, verified_at` | SPM-04 |
| `guardian_verifications` (P1) | `id, org_id, submission_id, method, status (pending\|verified\|rejected\|expired), evidence_file_id, reviewer_id, decided_at, expires_at` | CMP-13; manual review queue; deletes the held submission on expiry |
| `workflows`, `workflow_runs`, `workflow_actions` (P2) | definition per form; run state per submission; append-only actions | WFL-01/02; `submissions.workflow_state` mirrors the run |
| `reports` (P2) | `id, org_id, form_id, kind, config, share_token_hash, password_hash` | ANA-04 |

*As built (WP-1.12 and WP-1.15, migration `0021_submissions.sql`, ADR-0004).* `submissions`, `submission_idempotency` and `form_id_counters` exist (the last is in the FormOps table above); `submission_search` is migration 0010. What differs from the text above:

- **`submissions`** is the DDL above with these differences. `seq` is `bigint generated always as identity`: one identity for the whole table, not one per form. It orders and numbers responses, and gaps are allowed because a rolled-back insert burns a number. **`answer_codec_version` is 0** (`ANSWER_CODEC_PLAIN` in `@form/db`): answers are stored as plain jsonb, `principal_bidx` stays null and nothing is encrypted until WP-1.11 writes the encrypted codec and the blind indexes (and adds `submission_bidx`). `computed` holds `{ path, endingId }`; the variables wait for WP-1.11, because they can be tainted. `status` has a CHECK on the eight values and every response is `complete` today: the held statuses come with WP-1.14, WP-1.30 and WP-2.33. *Updated by migration 0022 (WP-2.33):* the CHECK lists ten values, `pending_review` and `rejected` having joined, and a response of a form with review units is stored `pending_review` until its units are decided (§2.4, "Section-level review"); the other held statuses still come with WP-1.14, WP-1.30 and WP-2.11. `delete_after` is a placeholder, `received_at` plus 10 years in UTC, filled by a `BEFORE INSERT` trigger so every inserter agrees, until retention purposes exist (WP-1.22). `fr_app` has column grants: INSERT may name only the identity and answer columns (`recordSubmission()` in `@form/db` is the one typed INSERT, because Drizzle lists every column of a table and naming one needs its grant, even as `default`), UPDATE covers the inbox columns and the answer columns, and nothing can set `delete_after`, `statutory_hold_until`, `legal_hold` or `seq`, or move a row to another form, version or month. `form_version_id` is a foreign key to `(org_id, form_id, id)` of `form_versions`, so a response can only name a version of its own form. The restrictive data-access policies are those of migration 0019 (§2.2). Partitions are `parts.submissions_YYYY_MM`, the current month and three ahead, with no default partition; `submissionKey(id)` and `uuid_v7_ts()` bind a lookup to one partition, and an id that is not a UUIDv7 is a 404 and never the error Postgres would raise.
- **`submission_idempotency`** is `(org_id, form_id, key) pk, submission_id, received_at, request_hash bytea (32 bytes), response jsonb, expires_at`, **without `response_enc`**. Nothing it stores needs encrypting yet: `response` holds ids only (`{ submissionId, endingId }`, never an answer), and the edit and receipt tokens that the encrypted column was for (the secrets DEK of WP-1.11, signed links of WP-2.18) do not exist, so a replay returns the stored ids with `Idempotent-Replayed: true` and re-mints nothing. `request_hash` is the sha256 of the canonical request, which tells a retry from other answers under the same key (422 `IDEMPOTENCY_KEY_REUSED`). Only respondent and system contexts touch the table, and only `system` deletes. Rows are not swept after their 24 hours yet, and a replay ignores `expires_at` (BL-269).
- **`form_id_counters (form_id, block_id, period) pk, org_id, next_seq`**: one row per unique-ID field and period (a year or a month in the form's own time zone, or empty for a counter that never restarts); `next_seq` is the number the next response gets. Respondent and system contexts create and advance rows, members and API keys only read, and nobody deletes.
- **`form_files`** (migrations 0018, 0019 and 0021) is the as-built `submission_files`, with fewer columns: `id, org_id, form_id, block_id, name, mime, size_bytes, sha256, purpose (file or signature), created_at, submission_id, submission_received_at`. A file is held by a response by both submission columns or by neither (`ON DELETE SET NULL`), so deleting a response un-holds its files and the orphan sweep (`drafts.expire`, after 24 hours) removes the bytes. There is no staging bucket, scan status or encryption until WP-1.14 and WP-1.11; the bytes are in the file store and arrive through `POST /v1/p/:slug/files` (§3.3).
- **The move from `form_submissions`, the prototype's table.** Migration 0021 keeps every row (a product-owner decision). Each row gets a UUIDv7 built from its `submitted_at` (so `received_at` is the id's own millisecond and the CHECK holds by construction) and is filed under the form's live version, else its newest, with `definition_hash` taken from that version's `content_hash`, status `complete`, `answer_codec_version` 0 and `seq` in the order received. The prototype's display rows (`form_submissions.fields`, the label and text of each answer as its page sent them) are kept too, as they were, in the jsonb column `legacy_fields`: the new design stores none (the server builds the rows when a response is read, from the answers and the version), so the column is null for every response the submit route takes, and a moved response has an array (`[]` when the prototype stored none), which also marks it as prototype data. A value that is not an array (only possible by hand) is kept as the one element of one. `fr_app` can read the column and has no INSERT or UPDATE grant on it, and the PII manifest erases it with the row. The old ids are not kept: `form_files` is re-pointed from an old-to-new map before the old table is dropped. A form that has responses and no version at all (the prototype's preview responses of a form that was never published) first gets one **legacy version**: `number` 0, so the form's first real publish is still version 1; `label` "legacy (prototype preview)"; `engine` `legacy@0`; `compiled` `{}`; `draft_rev` null, so the first publish is not taken for a replay; never live; and retired from birth (`superseded_at = 'epoch'`, `retired_at = now()`), so no acceptance window can reach it. The month partitions the old rows need are made before the copy. The counters already on `forms` are kept: the insert trigger moves to the new table after the copy, so nothing is counted twice. `form_submissions` is then dropped.

#### Section-level review (WP-2.33, WFL-09; slice 1 built early, migrations 0022 and 0024)

A response is final only when each review unit (a page, or the blocks from a `section_break` to the next one) has been approved by a checker from that unit's group, and no checker approves a unit they made or changed. What is reviewed is in the form definition and is versioned with it (`FormDefinition.review`, `CompiledForm.reviewUnits`; schema §13.1); who reviews it is live state in the tables below. Reason codes only: there are no notes and no return flow in slice 1 (BL-287).

| Table | Shape | Notes |
|---|---|---|
| `review_groups` | `id pk, org_id, name, created_by, created_at, archived_at`; unique `(org_id, id)` | A named set of checkers. Archived, never deleted, because review rows and decisions name it. Managed with `members.manage`; hidden from a respondent context |
| `review_group_members` | `(group_id, user_id) pk, org_id, added_by, added_at`; foreign key `(org_id, user_id)` to `memberships` **on delete cascade** | The key makes "a checker is a member of this org" a fact of the data, and a member who leaves, or whose account is deleted, leaves every group. Whether they may check at all is `submissions.review` at the time they decide, never this row |
| `form_review_settings` | `form_id pk, org_id, rev, enabled, settings jsonb, updated_by, updated_at` | The live assignment: for each unit its group, order, `required` and visibility (`own_unit` or `whole_submission`), and `distinctCheckers` (`ReviewSettings` of `@form/schema`). Written with `ops.manage` through `PUT /v1/forms/:id/review` (`If-Match`; 428 without, 409 when stale) and readable by every context of the org, a respondent's included, because the submit transaction asks whether the form is reviewed. A response keeps the group, order and visibility it was opened with. Why a table of its own and not a FormOps record: BL-293 |
| `submission_reviews` | `(submission_id, submission_received_at, unit_id) pk, org_id, form_id, round, state, required, review_order, group_id, visibility, maker_user_id, excluded_user_ids uuid[], last_editor_id, answers_hash bytea, rev, updated_at` | Partitioned by month on `submission_received_at`, in `parts`, with the submission it belongs to; `state` is `pending`, `approved`, `rejected`, `not_applicable` (every block of the unit was hidden or off the respondent's path) or `closed` (another unit was rejected, so this one is no longer asked). A copy taken when the review opened, so editing the settings never changes a review under way. `answers_hash` is the sha256 of the canonical JSON (RFC 8785) of the unit's stored answers (`reviewUnitAnswersHash` in `@form/logic`); a decision names it, so a checker approves exactly what they saw. Index `submission_reviews_queue` serves the queue (`state = 'pending'`) |
| `review_decisions` | `(id, submission_received_at) pk, org_id, form_id, submission_id, unit_id, round, decision (approve or reject), reason_code, decided_by, decided_at, answers_hash, form_version_id, idempotency_key`; unique `(org_id, idempotency_key, submission_received_at)` | **Append-only**, partitioned like the table above. `reason_code` is the fixed catalogue (`incomplete`, `incorrect`, `missing_document`, `duplicate`, `other`), required for a reject (a CHECK) and refused for an approve (by `review_decide()`). `form_version_id` is a foreign key `(org_id, form_id, id)` to `form_versions`, so a decision can only name a version of its own form |
| `org_settings.review_checkers_mfa` | `boolean not null default true` | "Checkers must use two-factor sign-in" (`reviewCheckersMfa` in `GET` and `PATCH /v1/org/settings`; needs `org.settings`) |

*As built.* What differs from the plan's text, and what to know:

- **Who may write.** `fr_app` has SELECT only on `submission_reviews` and `review_decisions`: a row is made, moved and closed only by `review_open()` and `review_decide()` (§2.1), which check the permission, the group, the order, the hash and the four-eyes rule in the same transaction as the write, so a route that forgets a check, or a bug in one, cannot approve a unit. Reading needs `submissions.read`, `submissions.review` or a system job (the restrictive policy `<table>_data_access`, as for `submissions`). `review_groups` and `review_group_members` are read by every context but a respondent's.
- **The statuses are guarded in the database.** `submissions.status` is a column `fr_app` may update (0021), so on its own `update submissions set status = 'complete' where status = 'pending_review'` would release a held response with no decision. The trigger `submissions_review_status_guard` (§2.1) refuses any move into or out of `pending_review` and `rejected` for everyone but the table's owner; INSERT of `pending_review` (the submit transaction), an UPDATE that keeps the status and every move between the other statuses are outside it.
- **Four-eyes rule.** A checker may not decide a unit they made (`maker_user_id`: the signed-in user for a user context, **null for a public respondent**, who has no user id, so for public forms the check is the email match and `distinctCheckers`), the last member to edit (`last_editor_id`, for the owner edits of SUB-09, not built yet), or one about themselves: `review_open()` records the ids of the org's members whose verified email matches **any** email-type answer of the response (not only a principal identifier), whatever their membership status, in `excluded_user_ids`, and stores no address. A member who joins or verifies later is not excluded (BL-286). With `distinctCheckers` a checker who already decided another unit of the response may not decide this one. All of these are `403 FOUR_EYES_VIOLATION` from the API and `four_eyes_violation` from the function.
- **Order and rounds.** Units with the same `review_order` are decided in any order; a higher order waits for the required, applicable units of the lower ones (`409 REVIEW_ORDER_BLOCKED`). `round` is 1 until the return flow exists. Two checkers deciding one unit at once: the response row is locked first, so the second finds the unit decided and gets `409 REVIEW_CLOSED`, not `REVIEW_STALE` (that is a decision about answers that are not the current ones).
- **Finalisation.** The response becomes `complete` when every required, applicable unit is approved by a decision of the current round that names the unit's **current** `answers_hash`, and `rejected` as soon as a required unit is rejected; either way the units still pending become `closed` and the response's `revision` is bumped, so an owner's concurrent edit fails its compare-and-swap. A held response sends nothing; on `complete` the decision sends one `submission.fanout` with the event `released` (§5.3); on `rejected` it sends nothing, because there is no rejection event (BL-291).
- **The token a checker sends.** The review detail returns each unit's `answersHash` as a keyed token, `HMAC-SHA256(auth secret, org | response | unit | round | hash)`, not the raw digest: the digest covers answers the caller may not read (a protected field, or a value worked out from another unit), so a raw hash would let them test guesses offline. The decision route recomputes the token in its own transaction and hands `review_decide()` the row's hash on a match; a token that matches nothing is treated as a stale hash.
- **`own_unit` redaction.** It applies to anyone acting as a reviewer on that form, an owner or admin included: a member of a review group that the form's **live settings** assign a unit of with `own_unit` visibility (the review detail also counts the groups the response's own review rows were opened with, because the settings are live and the rows are copies; `own_unit` wins when a member holds both kinds). Owners, admins and members who are in no review group see the whole response. The server removes (not masks) the answers, display rows, grid cells and columns, files and derived values of every block outside the caller's units, in the review detail, the responses grid and detail, the file download (404 for another unit's file) and exports (`visibleBlocksForReviewer`, one function in `@form/logic`); `q` on the grid is refused with `403 SEARCH_NOT_ALLOWED_FOR_REVIEWER` because a response's search document holds the text of every unit (BL-310). A settings row that does not parse stops the read: the code never treats a form as unreviewed on a parse failure.
- **Purge.** Both review tables name their submission with `ON DELETE CASCADE`; the trash purge, retention and erasure delete a response's reviews and decisions with it, and there is no `review_purge_submission()`.
- **Audit.** Eight codes in `packages/db/src/audit/events/reviews.ts`: `review_group.created`, `.updated`, `.member_added`, `.member_removed`, `review.settings_updated`, `review.opened` (counts only), `review.decided` (success or denied; metadata holds the unit, decision, reason code, round and decision id, never an answer) and `review.finalised`. A refusal is a denied `review.decided` written on the separate audit connection, and its 403 carries `audited: true` so the error handler adds no second `request.authorize` record.
- **PII manifest.** `review_groups` and `form_review_settings` pseudonymise their user columns; `review_group_members`, `submission_reviews` and `review_decisions` are `erase: 'delete'` (the last two with the submission; `decided_by` keeps the pseudonymous id as segregation-of-duties evidence, SOC 2 CC6.1 and CC6.3).

#### Compliance (P1/P2)

| Table | Shape | Notes |
|---|---|---|
| `org_data_keys` | `id, org_id, purpose (kek\|answers\|files\|secrets\|bidx\|statutory), version, wrapped_key, kek_ref, alg, created_at, retired_at, destroyed_at` | §2.6 |
| `secrets` | `id, org_id, kind (smtp\|oauth\|webhook_hmac\|gateway\|calendar), enc, meta, rotated_at` | Never returned by the API |
| `retention_policies` | `id, org_id, scope (org_default\|form), form_id, rules (RetentionOps), rev, updated_by` | Form row can only shorten purposes |
| `legal_holds` | `id, org_id, scope (org\|form\|principal), form_id, principal_bidx, reason, set_by, set_at, released_at` | Sweep skips held rows |
| `principal_objections` | `id, org_id, principal_bidx, ground ('s7a'), at` | Stops s7a processing for a principal (C-m7) |
| `dsr_requests` | `id, org_id, kind (access\|correction\|completion\|erasure\|nomination\|grievance\|withdrawal\|notice_language), status, principal_bidx[], principal_display_enc, channel, source_submission_id, received_at, due_at (≤ 90 d, Rule 14(3)), assignee_id, resolution, closed_at` | CMP-09 and CMP-10 (P1). Overdue alerts by the worker |
| `dsr_actions` | `id, org_id, dsr_id, action, target, result, by, at` | Mirrored in `audit_log` |
| `security_contacts` | `org_id pk, breach_contacts, privacy_contact, notify_channels, updated_at` | Who we notify as Processor (CMP-14) |
| `incidents` (P1) | `id, scope (platform\|org), aware_at, preliminary_sent_at, certin_reported_at, board_intimation_draft, report_72h_draft, affected_orgs[], status` | CMP-14 tooling |
| `processing_records` | view + export job | RoPA (CMP-15) from compiled inventories, FormOps and `disclosures` |
| `pii_coverage` | code manifest checked by test | Every table with PII-bearing columns declares `{ erase: 'delete'\|'pseudonymise'\|'ttl', retain_basis }`; `dsr.execute` and `retention.sweep` must cover each (C-M6) |
| `audit_log`, `audit_pending`, `audit_heads`, `audit_checkpoints` | §2.7 | |

#### Notifications and email (P1)

| Table | Shape | Notes |
|---|---|---|
| `email_senders` | `id, org_id, name, from_address, from_name, smtp_secret_id, verified_at, is_default, dkim_status` | NOT-01 |
| `email_messages` | `id, org_id, form_id, submission_id, notification_id, role, to_bidx[], to_display_masked[], subject_hash, org_profile_updated_at, brand_tokens_hash, status, attempts, provider_message_id, last_error, created_at, sent_at`, partitioned monthly, **365-day retention** | No bodies stored. Records which org-profile and brand-kit state was used for live variables (F-44) |
| `email_suppressions` | `(org_id, email_bidx) pk, reason, at, source` | NOT-11 |

#### Integrations and webhooks

| Table | Shape | Notes |
|---|---|---|
| `webhooks` | `id, org_id, form_id, url, enabled, secret_id, events[], key_by, field_keys, purpose_ids[] not null, files, filter, consecutive_failures, disabled_reason, rev` | INT-01; `data.route` required |
| `webhook_deliveries` | `id, org_id, webhook_id, event, submission_id, attempt, status, http_status, duration_ms, request_hash, response_snippet, next_attempt_at, created_at`, partitioned monthly | Metadata kept **365 days**; `response_snippet` (≤ 1 KB, PII-scrubbed) nulled after 30 days |
| `integration_connections`, `integration_bindings` (`purpose_ids[] not null`), `integration_runs` | as webhooks | P2 |

*As built (WP-1.16, WP-1.17 and WP-1.18, migration `0023_notify_webhooks_exports.sql`).* One migration made the tables of the three "send the answers somewhere" work packages, so they share one RLS review. `secrets`, `email_senders`, `notifications`, `email_messages`, `webhooks`, `webhook_deliveries`, `exports` and `disclosures` exist as below; `email_suppressions`, `pdf_templates` and the integration tables do not. Conventions repeated from 0019 to 0021: forced RLS with a `<table>_tenant` policy on `org_id = app_org()`; restrictive policies per command say who may read and write; a child names its org and its parent in one foreign key, so a row can never point at another org's form or secret whatever id a client sent; INSERT is granted on the whole table (Drizzle's INSERT lists every column) and UPDATE per column, so a bug cannot move a row to another org or form.

- **`secrets (id, org_id, kind, enc, meta, created_at, rotated_at)`**, kinds `smtp` and `webhook_hmac` only (the Compliance table lists the others, which arrive with their work packages). `enc` is the sealed value: `createOrgSecrets(keys)` in `@form/adapters/kms` encrypts it with AES-256-GCM under a fresh data key per secret, wrapped under the org's key, with the kind, org and secret id as the associated data, so a value copied to another row, kind or org does not open. Routes and jobs hold only the `OrgSecrets` port of `@form/ports` (`seal`, `open`) that the two `main.ts` files inject, because the dependency rule `adapters-only-from-composition-roots` keeps them from importing the helper. `fr_app` can write `enc` and can never select it (SELECT is granted on every other column, so `select *` fails with `42501`); the code that must open one reads it through `secret_enc()` (§2.1). `meta` holds what a screen may show: the host, port and user name of an SMTP URL, or the last four characters of a signing secret. The unique key is `(org_id, id, kind)` and `email_senders` and `webhooks` write the kind into their own row (`smtp_secret_kind`, `secret_kind`, each fixed and not updatable), so the database, not a route, decides that a webhook names only a signing secret and a sender only an SMTP one (a foreign-key check reads the referenced row without RLS, so a policy could not stop it). Policy `secrets_access`: a system job, `org.settings` for `smtp`, `data.route` for `webhook_hmac`.
- **`email_senders (id, org_id, name, from_address, from_name, smtp_secret_id, smtp_secret_kind, verified_at, last_test_error, is_default, created_at, updated_at)`**: the table above without `dkim_status`; at most one default per org (a partial unique index). Read by every context but a respondent's, written with `org.settings`. A sender that a notification names, or a secret that a sender names, cannot be deleted (409 `EMAIL_SENDER_IN_USE`), so no email silently changes its From address.
- **`notifications (id, org_id, form_id, kind, enabled, trigger, sender_id, config jsonb, purpose_ids text[], rev, created_at, updated_at, updated_by)`**: no `template_binding_id` yet, and `purpose_ids` is `text[]` (purpose ids are strings), whose CHECK refuses an empty list. `config` is the strict `NotificationConfig`; the API copies `kind`, `trigger`, `enabled`, `senderId` and `purposeIds` from it into the columns the worker queries, so the two cannot disagree. Written with `forms.edit`; `rev` is the compare-and-swap of `PUT … If-Match`; at most 25 per form, because each enabled one costs a job per response.
- **`email_messages (id, created_at, org_id, form_id, submission_id, submission_received_at, notification_id, role, to_display_masked text[], to_bidx bytea[], subject_hash, message_id, status, attempts, provider_message_id, last_error, org_profile_updated_at, brand_tokens_hash, sent_at)`**, monthly range partitions on `created_at` in `parts` (`PARTITIONED_TABLES`, so `partitions.maintain` carries them on), primary key `(id, created_at)`: the delivery log. No body is stored (the message is rendered again at send time); `message_id` is made once at dispatch and reused by every retry; `status` is `queued`, `sending`, `retrying`, `sent` or `failed`. `to_bidx`, `org_profile_updated_at` and `brand_tokens_hash` are null for now (BL-301, BL-303). The foreign key to the response cascades, so the purge deletes a response's messages with it; the 365-day sweep is WP-1.22 (BL-302). Read with `submissions.read`; only a system job writes, so a member cannot forge or edit the log.
- **`webhooks (id, org_id, form_id, url, enabled, secret_id, secret_kind, events text[], key_by, field_keys jsonb, purpose_ids text[], files, consecutive_failures, disabled_reason, rev, created_at, updated_at, updated_by)`**: no `filter` column (BL-305). Every command needs `data.route`, or a system job (the worker counts failures and, at the 50th in a row, switches the webhook off and bumps `rev`, so an owner saving stale settings is told to reload instead of switching it back on).
- **`webhook_deliveries (id, created_at, org_id, webhook_id, event, submission_id, submission_received_at, attempt, status, http_status, duration_ms, request_hash, response_snippet, replay_of, next_attempt_at)`**, monthly partitions on `created_at`: one row per delivery of one event, updated as it is tried (`pending`, `retrying`, `succeeded`, `failed`, `dead`); a replay is a new row whose `replay_of` names the first. The body is not stored, only its sha256 (`request_hash`); the response is not a foreign key, so the delivery of a `submission.deleted` event outlives its response (the two columns are both set or both null). It goes with its webhook. `data.route` reads it and may insert the replay's `pending` row; only a system job updates or deletes. `response_snippet` is at most 1 KB of the receiver's answer with addresses and runs of six or more digits replaced; nulling it after 30 days is WP-1.22 (BL-302).
- **`exports (id, org_id, form_id, requested_by, format, scope jsonb, include_sensitive, reason, idempotency_key, status, row_count, object_key, bytes, error, created_at, finished_at, expires_at)`** (a table the plan's text did not list): `format` is `csv` or `xlsx`, `status` is `queued`, `running`, `ready`, `failed` or `expired`; unique `(org_id, idempotency_key)`; a CHECK requires a non-blank `reason` with `include_sensitive`. A member with `submissions.export` may insert only a queued row with no object, size or error, because the key, size and state are the worker's to write (otherwise a crafted `object_key` would make the download route stream another org's file); only a system job updates or deletes. The file is at `<orgId>/<exportId>.<ext>` in the `exports` bucket and expires 24 hours after it is built.
- **`disclosures`** is the table above with `recipient_kind` limited to `notification`, `webhook` and `export` for now (integrations, workflows and API keys arrive with their work packages), `display_name` (a masked address, a webhook's host, the export's name) and `field_keys` (names, never values). `fr_app` has SELECT and INSERT and nothing else, so UPDATE and DELETE fail with `42501` whoever asks; the foreign key to the response cascades. Who writes it: `notification.dispatch`, in the transaction that queues the send (so step 4 of §2.5, "write `disclosures` for owner notifications", is the worker's job and not the submit transaction's); `webhook.deliver`, once per delivery and not per retry, when the request may have reached the receiver (never when the guard refused the address); `export.build`, one row per exported response. Read with `submissions.read` or `compliance.dsr`.
- **PII manifest** (`packages/db/src/pii.ts`): every table above is declared: `secrets` and `email_senders` delete; `notifications`, `webhooks` and `exports` pseudonymise; `email_messages` and `webhook_deliveries` are `ttl` (365 days; WP-1.22, not built); `disclosures` is deleted with its response.

#### Payments (P2) and billing (P1 SaaS)
`payment_accounts`, `payments` (unique `(gateway, reference)`), `payment_events` (dedupe by `event_id`; raw payload encrypted in object storage for 30 days), `invoice_counters` (gap-free GST numbering), and SaaS `plans` / `org_subscriptions` / `usage_counters` (limits = `plans.limits` merged with `org_subscriptions.overrides`, so a limit change is a row, not a deploy).

#### API, idempotency, rate limits, analytics, jobs

| Table | Shape | Notes |
|---|---|---|
| `api_keys` | `id, org_id, name, prefix unique, key_hash, scopes[], form_ids[], created_by, last_used_at, expires_at, revoked_at` | INT-03 |
| `idempotency_keys` | `(org_id, scope, key) pk, request_hash, status, response, created_at, expires_at` | §3.4 |
| `rate_limit_buckets` | **UNLOGGED** `(bucket pk, window_start, count)` | §3.5 |
| `analytics_events` | `id, org_id, form_id, form_version_id, visit_id, type (view\|start\|page\|field_focus\|field_error\|submit\|abandon), page_id, block_id, device, browser_family, os_family, country, at`, partitioned **daily** in `parts`, raw kept **30 days** | Inserted in batches (COPY every 5 s per pod); `field_focus` sampled; field-level events disabled for forms with a children policy |
| `form_analytics_daily`, `form_dropoff_daily` | rollups | ANA-01/02/03, written by `fr_system_agg`-free per-org jobs |
| `assets` | `id, org_id null, sha256 unique per org scope, kind, object_key, mime, bytes, width, height, alt_default, immutable` + `asset_refs (asset_id, owner_kind, owner_id)` | Content-addressed; system template assets stored once and referenced (F-47) |
| `job_effects` | `key pk, done_at` | 30-day TTL (F-49) |
| `presence` | **UNLOGGED** `(form_id, user_id, last_seen_at)` | BLD-14 |

### 2.5 Submit path (one transaction, ordered for throughput and correctness)

1. `resolve_slug` → `withTenant(org, actor='respondent')`.
2. **Outside the transaction:** load `form_access` and the version (cached), check status at `receivedAt`, check the version is not retired, run evaluation and validation (`packages/logic` + `validation`, scope `server`), external checks (uniqueness via bidx, OTP proof, captcha, file status), encrypt sensitive answers and tainted computed values, compute blind indexes.
3. **Begin transaction.** `INSERT submission_idempotency … ON CONFLICT DO NOTHING RETURNING` **first**; a conflict returns the stored result (with re-minted tokens) before anything is counted.
4. `INSERT submissions` (status `complete`, `pending_payment`, `pending_scan` or `pending_guardian_consent`), `consent_records`, `submission_search`, `submission_bidx`, attach `submission_files`, decrement stock or confirm the slot hold, write `disclosures` for owner notifications whose recipients are fixed.
5. Enqueue **one** `submission.fanout` job through the same transaction (pg-boss on the Drizzle `tx`): the transactional outbox. The handler fans out to notifications, webhooks, integrations, workflows and analytics counters, skipping effects that are not configured. Held statuses enqueue nothing until released.
6. **Last statements before commit:** `UPDATE form_counters SET submitted_total = submitted_total + 1 WHERE form_id = $1 AND ($limit IS NULL OR submitted_total < $limit) RETURNING …` (only for `complete`; pending-payment rows count on confirmation) and, per unique-ID block, `UPDATE form_id_counters … RETURNING next_seq`. Zero rows → `limit_reached` and rollback. Holding the hot row lock only for the commit keeps per-form throughput high.
7. Commit. Audit entries are written only for non-respondent actors.

**Throughput ceiling:** the per-form counter row serialises only the final statements, so one form sustains roughly 500–1,000 submits/s on a single primary (to be confirmed by the WP-1.28 load test); exam and admission spikes are within that. Forms without limits or unique IDs skip step 6.

**Version acceptance (F-34):** a version keeps accepting submissions for `accept_previous_versions_hours` (default 72) after a newer publish; then `version_superseded`, and the client offers to carry answers over by `FieldKey`.

*As built (WP-1.12, `apps/api/src/submit/`).* Inside the transaction the order differs from the numbered list, so that the form's hot rows are held for two statements and the commit and not for the whole transaction. The work outside the transaction is step 2 without what has no code yet: encryption and blind indexes (WP-1.11), consent (WP-1.21), captcha and spam signals (WP-1.13), uniqueness (WP-2.18). The transaction then runs: (1) claim the idempotency key, and return the stored ids at once when it is already taken; (2) number the unique-ID blocks (`form_id_counters`), here and not last, because the number is part of the stored answer and a respondent context can INSERT a response but never UPDATE it; (3) the effects: the `submission_search` document, written through the search adapter on the same transaction, and **one** signed `submission.fanout` job sent through the pg-boss adapter on the same transaction (the outbox; the job names the form as its resource, because `resolve_job_org` knows forms and not submissions, and carries ids only), so a rolled-back or replayed submit sends none and a committed one always has its job; (4) the guarded `UPDATE form_counters … RETURNING`, where zero rows is `LIMIT_REACHED` and rolls back everything above it, the key too, so the next try is a new request; (5) **last**, the `INSERT` into `submissions`, whose trigger counts the response on `forms.submission_count` and holds its files. With the INSERT first, fifty clients on one form queued behind each other through the search document and the job as well: measured on a 50-field form with 10 rules, 50 clients and no pause, one node, about 75 submits a second with the INSERT first and about 130 with it last on one laptop, and about 165 on the build server (BL-276). Other differences from the list above: the counter update runs for every response, not only for forms with a limit, so the count is right if a limit is set later; the fan-out job has no consumers until WP-1.16 and WP-1.18 (the worker's `submission.fanout` handler loads the response as the system actor and acknowledges it); and a replay returns the stored ids, because there are no edit or receipt tokens to re-mint. ADR-0004 point 6 says the counters are the last statements; as built the last statement is the INSERT, whose trigger takes the form's other hot row, and the unique-ID counters run first.

*Version acceptance as built:* a submission names the version its page was built from (`formVersionId`). The server accepts the live version, or a version that a newer one replaced less than `accept_previous_versions_hours` ago (default 72, 0 to 720, measured from `form_version_state.superseded_at`, and a window of exactly its length is over) and that is not retired; any other version is 409 `VERSION_SUPERSEDED`. The builder's fill page then offers to load the new version and carries the answers over by field key and type (hidden, calculated and context fields are dropped, because the server owns them). A version of another form or org is never handed out for an id.

*Review and the effects as built (WP-2.33, WP-1.16).* A form with review units changes the transaction in three places, and a form without them pays no statement for it (no read for a version that has no `review`). (1) First in the transaction, `readReviewSettings` reads the form's `form_review_settings` (a read with no lock) and `planReviewFrom` (`apps/api/src/modules/reviews/open.ts`) decides, from the server's own evaluation of the answers, whether a required unit applies to what the respondent saw; the idempotency key's stored result records the answer (`held`), because a respondent cannot read the review rows and the idempotency row is never edited. When no required unit applies, or review is off, or the settings name no unit of this version, the response is `complete` exactly as before. After the unique IDs are numbered the plan is made again with the numbered answers, because a unit's hash is the sha256 of its answers as stored and the number is part of an answer. (2) Otherwise it is stored `pending_review`, and right after the INSERT `review_open()` (§2.1) writes the unit rows and the API appends `review.opened`, in the same transaction, so a held response with no review rows cannot exist. The stored idempotency result carries `held: 'pending_review'`, so a replay, and the second request of a double tap, tell the respondent the same thing and open nothing twice. (3) No `submission.fanout` job is sent: the fan-out is sent only for a `complete` response (§5.3), so a held response is searchable and counted against the form's limit (a reject does not give the place back: BL-290) but triggers no email, webhook or export. The public route's answer gains the optional `held` field, which the fill page reads to say "Your submission is under review". Release is the decision route's: the decision that completes the response sends one `submission.fanout` with the event `released` through the decision's own transaction (`finaliseOnDecision`), and a replayed decision, a decision that leaves units open and a reject send nothing. The step-4 disclosures of owner notifications are written by `notification.dispatch`, not by this transaction (§2.4, "As built (WP-1.16, WP-1.17 and WP-1.18)").

### 2.6 Field-level encryption (CMP-07, CMP-08)

```
KMS root key (KeyProvider)            SaaS: 1 key per region (AWS KMS / GCP KMS / Azure KV)
  │ wrap/unwrap                       on-prem: Vault transit key | keyfile master key
  ▼
Org KEK  (random 256-bit, per org)    stored wrapped in org_data_keys(purpose='kek')
  │ AES-256-GCM key wrap (in app)     P3 option: per-org root key (BYOK or per-org KMS key) → real crypto-shredding
  ▼
DEKs per (org, purpose, version)      answers, files, secrets, bidx (HMAC key), statutory
  ▼
EncryptedAnswer { alg:'A256GCM', kid:'<orgId>:answers:v3', iv, ct = AES-GCM(JCS(value)), aad = submissionId:blockId }
```
- **Why an org KEK:** one KMS call unwraps it (cached 5 min); DEKs unwrap locally.
- **Erasure is deletion.** A record, field or org is erased by deleting rows and objects. Wrapped keys sit inside the 35-day PITR backups and the regional root key can still unwrap them, so **erasure completes when the backups that contain the data expire (≤ 35 days)**. This is stated in the DPA, in DSR responses and in the deletion certificate (method + backup-expiry date). We make no "crypto-shredding" claim in P1–P2. Real crypto-shredding of an org needs a per-org root key held outside Postgres (BYOK / per-org KMS key or Vault transit key), offered at Enterprise in P3 (ADR-0005).
- **Blind index:** `HMAC-SHA256(bidxKey_org, normalize(value))` truncated to 16 bytes; normalisers from `UniqueConstraint.normalize` and the registry; equality only, never prefix.
- **Files:** every bucket uses SSE (S3 SSE-KMS or the store's equivalent). Files in sensitive fields are re-encrypted by the worker after the AV scan (per-file DEK wrapped by the org `files` DEK); downloads stream through the API. Other files get a 5-minute presigned GET with `Content-Disposition: attachment`.
- **Secrets** use the `secrets` DEK; the API never returns them.
- **Key operations:** `kms.rotate` creates a new DEK version (old versions kept for decryption; optional re-encrypt job). Every unwrap is metered; KMS audit trails are SOC 2 evidence.

### 2.7 Audit log (CMP-02): append-only, hash-chained, never lost on rollback

```sql
create table audit_pending (                -- written by business code; append-only for fr_app
  id bigint generated always as identity primary key,
  org_key uuid not null,                    -- org_id or zero-uuid for platform
  event jsonb not null,                     -- actor, action, resource, outcome, reason, metadata (never answer values)
  occurred_at timestamptz not null default now()
);
create table audit_log (
  id bigint generated always as identity, org_id uuid, seq bigint not null, occurred_at timestamptz not null,
  actor_kind text not null, actor_id uuid, impersonator_id uuid, session_id uuid, api_key_id uuid,
  actor_ip_hash bytea, actor_ua text, action text not null, resource_type text not null, resource_id text, form_id uuid,
  outcome text not null,                     -- success | denied | error
  reason text, metadata jsonb not null default '{}', request_id text, trace_id text,
  prev_hash bytea not null, hash bytea not null,
  primary key (id, occurred_at)
) partition by range (occurred_at);        -- partitions in schema parts
create unique index on audit_log (org_id, seq, occurred_at);
create index on audit_log (org_id, occurred_at desc);
create index on audit_log (org_id, resource_type, resource_id, occurred_at desc);
create table audit_heads (org_key uuid primary key, seq bigint not null, hash bytea not null);
create table audit_checkpoints (org_key uuid, seq bigint, hash bytea, signed_at timestamptz, key_id text, alg text, signature bytea, anchored_object text, primary key (org_key, seq));
```

- **Writes (ADR-0006, revised):**
  - Successful actions insert into `audit_pending` **inside the business transaction**, so the audit record commits or rolls back with the change. Audited reads (submission views, downloads, reveals) open read-write transactions for this one insert.
  - **Denied and failed actions** (authorisation denials, validation failures that matter, errors) are inserted through a **separate connection** in their own transaction, so they survive the rollback of the business transaction (C-M7). A test asserts that a 403 produces an audit row.
  - The `audit.chain` worker (one chainer per org key at a time; as built: pg-boss `short` plus a skip-locked head, see below) moves pending rows into `audit_log` within seconds: locks the head, computes `hash = sha256(prev_hash ‖ JCS(event ∪ {seq, occurred_at}))`, inserts, advances the head. A `BEFORE INSERT` trigger rejects rows whose `prev_hash`/`seq` do not continue the head. Business transactions never hold the head lock, so audited actions in one org do not serialise (F-21).
- **Immutability:** `REVOKE UPDATE, DELETE, TRUNCATE` on `audit_log` and `audit_pending` (except the chain worker's delete of moved pending rows through a definer function), plus raise-on-update triggers.
- **Anchoring:** hourly `audit.checkpoint` signs each org head with the platform audit key (an **app-held Ed25519 key wrapped by the KMS**, so the algorithm does not depend on the KMS vendor; ES256 where policy requires a KMS-native signature) and writes the checkpoint to `audit_checkpoints` and to the `audit` bucket with Object Lock (compliance mode) **when the store supports it**. If it does not, checkpoints are also forwarded to the customer's syslog/SIEM (§6). `audit.verify` runs daily.
- **Retention:** 13 months online (covers the SOC 2 period and the Rules' one-year log minimum), then exported to NDJSON.zst with checkpoints into the WORM bucket (7 years default) and detached.
- **What gets logged:**
  - auth events (login, MFA, failures, revocations), membership and role changes;
  - builder changes (`form.draft.saved` coalesced per 5 min per user per form), publish with diff summary, notice approvals;
  - FormOps changes with config diffs;
  - **every submission read** — detail view, grid page (one coalesced event per page with the ids shown), API reads, exports, file downloads, reveals — for every form, not only sensitive ones (C-M9);
  - edits, deletes, bulk actions, DSR actions, retention changes, legal holds, statutory-hold access, key rotations, API key use (first use per day plus all writes), billing;
  - break-glass and support access; template lifecycle events (templates spec §5.3); denied and failed attempts of all of the above.
- **No answer values ever enter `metadata`**: a lint rule on `audit.append` call sites plus a runtime scrubber.
- **As built (WP-1.04, migration 0005):**
  - Platform events are chained under the zero org key, which is also their `audit_log.org_id` (now `not null`), so every row belongs to exactly one chain and the platform chain is read in `withTenant` on the zero key. `fr_app` has no INSERT on `audit_log`: rows arrive only through `audit_log_append()`. `audit_heads` has a SELECT-only tenant policy; `audit_checkpoints` and `audit_archives` are append-only, readable by their tenant and inserted only by a system actor inside it (`<table>_tenant_insert`). The cross-chain functions `audit_pending_keys()`, `audit_chain_keys()` and `audit_archive_detach()` need a system actor in the platform tenant (`audit_platform_system()`); the chain functions need a system actor in the chain's tenant (`audit_chain_org()`).
  - `audit.append(tx, org, event)` takes success events only and `audit.appendDetached(writer, org | null, event)` denied and error events only; both accept only codes of the event catalogue (`AUDIT_EVENTS`, `packages/db/src/audit/catalogue.ts`, with the outcomes each code is recorded with), validate ids, cap text and scrub `metadata`. The api and the worker each pass a separate 2-connection audit pool as the writer. The API error handler audits every 403 (`request.authorize`, filed under the member's org, or the platform chain with the claimed org for a non-member) and every 5xx a route raises (`request.failed`, the problem code as reason, never the error text). Overload 503s from under-pressure are answered before any route runs and are not audited, so an overload adds no audit writes.
  - Link hash: `sha256(prev_hash ‖ JCS(record))`, where the record is `{ v: 1, orgKey, seq, occurredAt, actorKind, actorId, impersonatorId, sessionId, apiKeyId, actorIpHash (hex), actorUa, action, resourceType, resourceId, formId, outcome, reason, metadata, requestId, traceId }` with explicit nulls and `occurredAt` in microseconds (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), so a verifier recomputes it from the stored row; seq 1 links to 32 zero bytes. The `BEFORE INSERT` trigger creates the head at genesis and refuses any row whose seq or prev_hash does not continue it, for every role.
  - The chain worker: `audit.chain` is an org-scope job whose resource is `{ type: 'audit_chain', id: orgKey }` (`resolve_job_org` maps a chain with pending rows or a head to its own key). A dispatcher in every worker that serves the queue lists `audit_pending_keys()` every 250 ms and sends one job per key with the key as singleton; the queue policy is pg-boss `short` (one queued per key, `coalesceQueued`), and `audit_chain_begin()` takes the head with `FOR UPDATE SKIP LOCKED`, so one chainer per org works while other orgs run side by side (concurrency 4). Polling keeps NOTIFY's global commit lock out of audited transactions. A pending row a chain cannot parse is coerced (`metadata._malformed`) rather than wedging the chain. Load test (`apps/worker/test/audit.int.test.ts`): 600 events over 12 orgs from 8 concurrent producers, commit to visible in audit_log, max under 5 s (`FORM_AUDIT_LAG_BUDGET_MS`); p95 under an internal 3 s target so a slower runner shows up before the budget is hit; measured on a developer laptop: p95 1.5 s, max 1.6–2.0 s.
  - `audit.checkpoint` (hourly) signs `JCS({ v, type: 'fr.audit.checkpoint', orgKey, seq, hash, signedAt, keyId, alg })` through the KMS port (`AUDIT_SIGNING_KEY_ID`, default `audit-v1`; only that key and `AUDIT_RETIRED_SIGNING_KEY_IDS` verify), puts it in the `audit` bucket under `checkpoints/<orgKey>/<seq>.json` with compliance-mode Object Lock when `capabilities().objectLock`, else forwards it to the SIEM sink (`AUDIT_SYSLOG_URL`, RFC 5424 over TCP or TLS, or `AUDIT_OTLP_URL`, OTLP/HTTP logs); production refuses a checkpoint it cannot anchor, development records it unanchored. Since WP-1.03 (BL-187) production needs a SIEM sink or `STORAGE_DRIVER=s3`, and with the S3 store alone the worker checks at boot that the `audit` bucket really has Object Lock and refuses to start otherwise. A trigger refuses a checkpoint that names no existing link.
  - `audit.verify` (daily) walks each chain in one repeatable-read snapshot (`verifyChain` refuses read committed, where links committed between pages would look like tampering), recomputes every online link, checks each link against its predecessor, that gaps are exactly the seq ranges of archived months whose partition is detached, that online plus detached archived rows equal the head's seq (an archived month still attached, because `audit.archive` stopped before the detach, is walked online and its row count must match the archive's: `archive_mismatch`), that the last link is the head, and every checkpoint's link and signature. It appends `audit.verified` (success) to the chain, or a detached `audit.verified` error naming the first problem.
  - `audit.archive` (monthly, data `{ month? }`; the cron run takes every month whose partition is still attached and lies outside the 13-month window, oldest first, so a month a failed run left behind is retried rather than forgotten, BL-196) writes `archive/<orgKey>/<YYYY-MM>.ndjson.zst` per chain (each line the record plus `prevHash` and `hash`, closed by one `{ "checkpoint": … }` line per signed checkpoint in the month's seq range, so the object verifies against signatures on its own), records it in `audit_archives` with its sha256 and seq range, appends `audit.archived`, then calls `audit_archive_detach()`, which gives up after a 1 s `lock_timeout` (migration 0011, BL-197) rather than queue every chainer behind a long `audit.verify`: while the detach waits, its queued ACCESS EXCLUSIVE request holds new chain inserts, so each attempt can add up to 1 s of chain lag, inside the 5 s budget; the job retries with backoff (six retries). The object streams through zstd into a multipart upload and is hashed on the way (BL-183); `verifyChain` reads partition attachment from the current catalog (`pg_partition_tree`), since a detach can commit between its snapshot and its first read of `audit_log` (BL-191). The worker serves it only when storage is configured (`STORAGE_DRIVER`); production refuses to archive into a store without Object Lock, development writes without it and warns.
  - Audited reads: `auditReads.detail | gridPage | api | reveal | export | download` (`packages/db/src/audit/reads.ts`) append in the read's own read-write transaction, ids and counts only.
  - Lint: `form-audit/no-answer-values` (`tools/lint/audit-plugin.js`, an oxlint JS plugin) requires an object-literal event with a string-literal `action`, no spreads but `...auditActor(ctx)`, and an object-literal `metadata` whose keys and value names are not answer containers; the scrubber drops the same keys at runtime (a test keeps the lists equal). The catalogue test scans `apps/*/src` and `packages/*/src` and fails on an emitted code missing from the catalogue or a catalogued code nothing emits.
  - Event codes live in one file per domain: `CORE_AUDIT_EVENTS` in `catalogue.ts` plus `packages/db/src/audit/events/{forms,publish,access,submissions}.ts` (§3.2).

### 2.8 Templates

The templates spec §5 is authoritative for template tables and RLS; the corrections raised in review (no `coalesce()` in keys, deferred FKs for both cycles, `'cards'`, publisher-scoped slugs, terminal `rejected`, null-safe policies, policies on localizations and category links, `template_for_binding()`, `fr_system_agg` for cross-tenant stats with ≥ 5 distinct orgs) have been applied **in the spec itself**. Gallery indexes:
- `templates (coalesce(org_id,…), kind, lifecycle, featured desc, sort_weight desc)`; GIN on `industries` and `tags`;
- `template_localizations` GIN `search` and GIN trigram `title`;
- `form_template_bindings (org_id, template_id, template_version_id)` for "forms behind on updates".

*As built (WP-T1.1, migration `0009_templates.sql`):* every table of the templates spec §5.1 except the `form_versions` columns (that table arrives with WP-1.07; BL-241). Differences from the spec text, all in the direction of tighter isolation:
- **Policy names.** The read policy of each table is `<table>_tenant` (the RLS meta-check requires it), writes are `<table>_insert|_update|_delete`, seeder policies `<table>_seed` (`org_id IS NULL` in both clauses, checked by a meta-test). Array helpers are cast in policies (`= any ((select app_teams())::uuid[])`), since `= any (subquery)` compares against the array as one value.
- **Who reads template content.** `app_reads_templates()` (an org in context and actor `user`, `api_key`, `system` or `platform`) guards every policy that admits system rows (templates, categories, signing keys, synonyms) and the whole of `template_stats_daily`, so respondents and connections without a tenant see no template rows or figures at all. Brand kits, bindings, fork bindings, usages, search misses and org packs keep the plain tenant policy.
- **Writes split by command.** The spec's `FOR ALL` write policies on localizations and category links would also widen SELECT (permissive policies OR together) and reopen the FTS leak; they are separate INSERT/UPDATE/DELETE policies that also require the parent to be visible. The update policy on `templates` repeats the visibility of `templates_tenant`; because an UPDATE's new row must also pass the SELECT policy, soft deletion goes through the definer function `template_delete(template_id)` (a template the caller can see; returns false otherwise).
- **Parent org and cross-org references.** The definer trigger function `template_rows_guard()` sets `org_id` of versions, localizations and category links from their parent (whatever the caller can read, so a child of another org's parent fails the caller's WITH CHECK, and the seeder cannot attach a system row to an org template), and refuses with 23503 a pack, forked-from version, category, parent category or bound template of another org, and a usage event naming another org's template, an unknown one, or a version that is not the template's. Composite foreign keys keep a version with its template (`templates.current_version_id`, bindings, fork bindings via `unique (id, template_id)`), a binding with a form of its org, a fork binding with a fork of its org, and `forms.brand_kit_id` with a kit of the form's org.
- **Referenced versions.** The invoker trigger function `template_refs_visible()` (triggers `templates_refs`, `form_template_bindings_refs`, `template_fork_bindings_refs`, firing after the guard) lets `fr_app` name in `templates.forked_from_version_id`, `form_template_bindings.template_version_id` and `template_fork_bindings.upstream_version_id` only a version the caller can read under RLS, on insert and when the column changes. Without it a member could bind a system draft, a peer's personal template or another team's and read its payload through `template_for_binding()`. A policy cannot do this check (templates ↔ template_versions policies would recurse), and an invisible version answers 23503 like a missing or another org's one, so the error is no existence oracle. Bindings made earlier keep working after their template is soft-deleted.
- **Scopes on write.** `templates_insert` and the WITH CHECK of `templates_update` admit a personal template only for the caller (`owner_user_id = app_user()`) and a team template only for a team in `app_teams()`, unless the caller holds `templates.govern`; a member cannot create or move a template into a scope they could not then see.
- **Drafts.** Drafts, in-review and rejected versions are visible to their author and to `templates.approve` holders of the version's own org only, so a system draft is visible to no tenant. `template_versions_update` and `template_versions_delete` repeat that rule, since Postgres applies the read policy to UPDATE and DELETE only when the statement reads columns (an `update template_versions set changelog = …` without WHERE would otherwise reach other authors' drafts).
- **Trust store.** The spec's `key_id text primary key` would let a tenant squat a key id the platform or another org needs (and learn from 23505 that it exists). `template_signing_keys` has a surrogate `id uuid` primary key and `key_id` is unique per owner (`template_signing_keys_uq` on `(coalesce(org_id, zero uuid), key_id)`); check `template_signing_keys_namespace` keeps platform key ids in the reserved `fORM-` namespace (case-insensitive) and org key ids out of it, so a key id names at most one key among those a tenant sees and no org key shadows a release key. Verification (WP-T1.2, T1.5) looks keys up by `key_id` under RLS (platform keys plus the org's own).
- **Versions.** Trigger `template_versions_immutable`: once out of `draft`, `payload`, `payload_hash`, `lock_fingerprints`, `schema_version` and `required_features` never change (42501, for every role); states move draft → in_review | published, in_review → published | rejected, published → superseded; only drafts are deleted. Operational columns (thumbnail, preview assets, stats, review fields) stay writable. Past draft, `fr_app` changes `state`, `mandatory` or `mandatory_deadline` only as a `templates.approve` or `templates.govern` holder or a `system` actor (42501 otherwise), so an ordinary member can neither supersede a published version nor make it mandatory. Unique partial indexes allow one draft and one published version per template.
- **Search.** A trigger fills `search` with `setweight` A/B/C over `unaccent(title | summary | field_labels)` in `template_search_config(locale)` (`english` for `en*`, `simple` otherwise); WP-T1.4 parses queries with the same function.
- **Roles.** `fr_app`: no DELETE on `templates`, `template_usages` append-only (trigger `template_usages_append_only`, also for the owner; it lets a DELETE through only for rows past the 400-day TTL, for `retention.sweep`), `template_stats_daily` read-only, column grants elsewhere (`org_id` of the child tables and `search` are trigger-set). `fr_template_seeder`: SELECT, INSERT, UPDATE on the system-capable template tables, DELETE on localizations, category links and synonyms, never on versions. `fr_system_agg`: SELECT on `template_usages`, `form_template_bindings` and `templates (id, org_id, scope, kind)`, SELECT, INSERT, UPDATE on `template_stats_daily`; no payloads, titles or tokens.
- `template_for_binding(binding_id)` returns the bound version (payload, hash, fingerprints, state) with the template's `deleted_at`, for a binding of `app_org()` and a builder-side actor only, and a draft, in-review or rejected version only to its author and `templates.approve` holders of the org (the rule of `template_versions_tenant`); `@form/db` wraps it as `templateForBinding()` and `template_delete()` as `deleteTemplate()`.
- `templates.team_id` and `brand_kits.team_id` have no foreign key until the teams table (WP-2.29; BL-240), like `forms.team_id`. Extra checks: slug, locale, title and category slug formats; `update_state` is `current | available | required | dismissed@<n>`; `template_search_synonyms` is unique per (org or system, term).

---

## 3. REST API (Fastify 5)

### 3.1 Surfaces and hosts

| Surface | Prefix | Host | Auth | Audience |
|---|---|---|---|---|
| Builder / app API | `/v1/*` | `api.<domain>` (CORS: builder origin only, credentials) | Session cookie + CSRF guard | `apps/builder` |
| Public API v1 (P2) | the same `/v1/*` routes flagged `config.public: true` | `api.<domain>` | `Authorization: Bearer fr_live_…` | Customers, Zapier, Make, n8n, SDK |
| Runtime public | `/f/*` | runtime host (separate registrable domain in SaaS) | None, render token, unlock token | Respondents, embeds |
| Signed links | `/s/*` | runtime host | Signed single-purpose token | Respondents, guardians, approvers |
| Provider callbacks | `/hooks/*` | `api.<domain>` | Provider signatures | Gateways, mail feedback |
| Internal | `/internal/*` | cluster-internal only | mTLS or HMAC service token | runtime SSR → api, worker callbacks |
| Platform | `/platform/*` | **separate port 8081**, never on the public ingress | Operator SSO + hardware-key MFA, break-glass grant for tenant data | Operators |

Route plugins declare `config: { auth, perm, public, rate }`. OpenAPI is emitted twice: `openapi.internal.json` and `openapi.public.json` (versioned, diffed, published).

### 3.2 Request pipeline

1. `onRequest`: request id and OTel span; body limits (1 MB default, 5 MB draft PUT, 256 KB runtime submit); security headers per surface (§4.5). **URLs are scrubbed before logging and tracing:** query strings are dropped except an allowlist of parameter names (`lang`, `embed`, `utm_*` names without values), so prefill values never reach logs or traces (C-M13).
2. `authenticate`: session (`__Host-fr_sess`, Secure, HttpOnly, SameSite=Lax, via `auth_session()`), or API key. **CSRF (ADR-0008):** unsafe methods with cookie auth need `Sec-Fetch-Site: same-origin` (the builder and API are configured same-site, the runtime is not) **and** the header `X-FR-Client: builder`; CORS denies the preflight from any other origin. No CSRF tokens. Active org from `X-FR-Org`, validated with `membership_for()`. *As built (WP-1.01):* `same-site` also passes when `Origin` is the configured builder origin (SaaS sibling hosts); unsafe `/v1/auth/*` requests are guarded with or without a cookie (login CSRF); see ADR-0008.
3. `rateLimit` (§3.5).
4. `authorize`: permission, form-level grants, `data.route` for routing endpoints, API key scope.
5. Handler inside `withTenant(ctx)`; one transaction per request; GETs read-only unless they write an audit row.
6. `idempotency` for flagged POSTs (§3.4).
7. Errors are RFC 9457 problem+json with a closed code enum: `DRAFT_REV_CONFLICT`, `LOCK_VIOLATION`, `TEMPLATE_*`, `VALIDATION_FAILED`, `PLAN_LIMIT_REACHED`, `FEATURE_UNAVAILABLE`, `NOTICE_NOT_APPROVED`, `DATA_ROUTE_FORBIDDEN`, `RATE_LIMITED`, `NOT_FOUND` (also for other tenants' ids, never 403). Denied requests are audited (§2.7).

*As built (WP-1.06 to WP-1.15).*

- **One file per domain.** Work packages built in parallel would edit the same lines of three shared lists, so each list is split by domain, and a code or a case lives in exactly one file:
  - *Audit event codes.* `CORE_AUDIT_EVENTS` (`packages/db/src/audit/catalogue.ts`: auth, accounts, orgs, members, the worker, the chain, the reads that predate the split, and `form.published`) plus `events/forms.ts` (`form.archived`, `form.trashed`, `form.restored`, `form.cloned`, `form.imported`), `events/access.ts` (`form.access_changed`, `form.password_changed`, `form.slug_changed`, `form.unlock_failed`), `events/submissions.ts` (`submission.updated`, `submission.trashed`, `submission.restored`, `submission.purged`) and `events/publish.ts`, which is empty because `form.published` predates the split. `AUDIT_EVENTS` spreads them. A spread lets a later object silently replace an earlier code, so `events.test.ts` fails for a code listed twice, and `catalogue.test.ts` still requires every listed code to be emitted: a file lists only codes something emits, and `AuditAction` stays a closed union.
  - *Problem codes.* `CORE_PROBLEMS` (`apps/api/src/errors.ts`) plus `apps/api/src/problems/{forms,publish,access,submit,submissions}.ts`; `PROBLEMS` spreads them, `problems.test.ts` fails for a code defined twice, and `ProblemCode` stays the closed union of the keys. Forms: `PRECONDITION_REQUIRED` 428, `DRAFT_INVALID` 422, `IMPORT_INVALID` 422, `INVALID_CURSOR` 400, `FORM_STATE_CONFLICT` 409. Publish: `PUBLISH_BLOCKED` 422, `PLAN_MISMATCH` 422. Access: `ACCESS_REV_CONFLICT` 409, `ACCESS_REV_REQUIRED` 428, `FORM_SLUG_TAKEN` 409, `FORM_UNLOCK_FAILED` 401. Submit: `SUBMISSION_INVALID` 422, `FORM_CLOSED` 409, `LIMIT_REACHED` 409, `VERSION_SUPERSEDED` 409, `IDEMPOTENCY_KEY_REUSED` 422. Submissions: `SUBMISSION_NOT_TRASHED` 409, `SUBMISSION_HELD` 409. `FORM_CLOSED`, `LIMIT_REACHED` and `VERSION_SUPERSEDED` are 409 and not 403 on purpose: the error handler audits every 403 as a denied action, and a closed or full form is refused for every respondent that arrives.
  - *Isolation cases.* `apps/api/test/isolation-cases/{index,core,forms,publish,access,submissions}.ts`: one `IsolationDomain` per file with its own seed (`types.ts` and `guard.ts` are the shared parts), so a work package that adds a route adds its case in its own file. `isolation.int.test.ts` belongs to none of them (§2.3).
- **Body limits as built.** 1 MiB by default (`BODY_LIMIT`), which the submit route also gets (the plan says 256 KB); publish 8 MiB; an upload the largest `maxFileBytes` of the form, as base64 in JSON, up to `UPLOAD_BODY_LIMIT`; unlock 4 KiB; CSP reports 64 KB. `PUT /v1/forms/:id/draft` sets no limit of its own, so the 5 MB cap in its handler cannot be reached (BL-278).

### 3.3 Route map

**Auth and account** (P1; WSP-01, WSP-08, CMP-21) — in-house auth on the tables above (ADR-0017), `openid-client` for OAuth, `@node-rs/argon2`:

| Method and path | Notes |
|---|---|
| `POST /v1/auth/signup` · `login` · `logout` | Sign-up shows the platform's own privacy notice (CMP-21). Login returns `mfa_required` with a 5-min ticket when TOTP is on; constant-time, generic errors |
| `POST /v1/auth/magic-link` · `…/verify` | 15-min single-use |
| `GET /v1/auth/oauth/:provider/start` · `…/callback` | Google, Microsoft; PKCE + state + nonce; hidden when `EGRESS_POLICY=none` |
| `POST /v1/auth/password/forgot` · `…/reset` | Local top-100k password list everywhere; HIBP k-anonymity SaaS only |
| `POST /v1/auth/mfa/totp/setup` · `/verify` · `/disable` · `POST /v1/auth/mfa/recovery` | |
| *As built (WP-1.01):* `GET /v1/auth/methods` · `POST /v1/auth/link` (who an emailed link is for, before it is used) · `POST /v1/auth/verify-email` · `POST /v1/auth/mfa/totp` (TOTP for an MFA ticket) · `POST /v1/auth/mfa/recovery` (recovery code for a ticket) · `POST /v1/auth/mfa/recovery-codes` · `GET /v1/me` · `GET /v1/me/sessions` · `DELETE /v1/me/sessions/:id` | Sign-up answers 202 and emails a verification link whose redemption signs in; email tokens travel in the builder URL fragment |
| `GET/PATCH /v1/me` · `GET/DELETE /v1/me/sessions[/:id]` · `POST /v1/me/export` · `POST /v1/me/delete` | Account self-service export and deletion (CMP-21) |
| *As built (WP-1.31):* `GET /v1/privacy/notice` · `PATCH /v1/me` (name) · `POST /v1/me/notice` · `POST /v1/me/export` · `GET /v1/me/deletion` · `POST /v1/me/delete` · `GET/POST /v1/me/grievances` | The platform as Fiduciary for builder accounts (CMP-21). Sign-up and a first OAuth sign-in (`…/start?notice=`) carry the notice version the builder showed; a stale one is `NOTICE_OUTDATED`, and the version and SHA-256 of the text go into `user_notice_acks`; `GET /v1/me` says whether the user has read the current text. The export is a JSON download (`fr.account-export@1`). Deletion needs a sign-in from the last 15 minutes and the address typed as confirmation; it is `ACCOUNT_DELETION_BLOCKED` while an org would be left without an owner or members (`account_delete()`), and otherwise passes the user's forms to the org's longest-standing other owner, ends every session and leaves a pseudonymous tombstone. Privacy requests get a `GRV-` reference, a 90-day due date, a receipt and an email to `PRIVACY_CONTACT_EMAIL`; ten a day per user |
| (P3) `GET /v1/auth/sso/:connection/start` | BoxyHQ Jackson; LDAP behind the same seam |

**Org, members and workspace**

| Method and path | Notes |
|---|---|
| `GET /v1/orgs` (via `list_user_orgs`) · `POST /v1/orgs` · `GET/PATCH /v1/org` | |
| *As built (WP-1.02):* `GET/PATCH /v1/org/settings` · `PUT /v1/me/active-org` (the switcher) · `GET /v1/org/invites` · `DELETE /v1/org/invites/:id` · `POST /v1/invites/lookup` · `POST /v1/invites/accept` · `POST /v1/org/members/:userId/access-link` | Invite tokens travel in the request body and the builder URL fragment, never in a path (as for the WP-1.01 links), so `POST /v1/invites/:token/accept` became `POST /v1/invites/accept`. `DELETE /v1/org/members/:userId` with one's own id is leaving. A role or status change revokes the member's sessions bound to the org. Seat and licence checks arrive with WP-1.30 |
| `GET /v1/org/members` · `POST /v1/org/invites` · `POST /v1/invites/:token/accept` · `PATCH/DELETE /v1/org/members/:userId` | Seat and licence checks |
| `GET/PUT /v1/org/profile` · `GET/PUT /v1/org/settings/templates` · `GET/PUT /v1/org/security-contacts` | TPL-06, CMP-14 |
| `GET/POST/PATCH/DELETE /v1/teams[/:id]` · `…/members` (P2) · `/v1/folders[/:id]` | |
| `GET /v1/meta/features` · `GET /v1/meta/registry` · `GET /v1/usage` | |
| `GET /v1/meta/edition` | No session (the sign-in page needs it too): `@form/config` `editionSummary`, i.e. deployment mode, egress policy and what the edition can run (FND-19). Never the egress allowlist or config notices |
| `GET /v1/billing` · `POST /v1/billing/checkout` · `POST /v1/billing/portal` | SaaS only |

**Forms, drafts and versions** (P1)

| Method and path | Notes |
|---|---|
| `GET /v1/forms?…` · `POST /v1/forms` (`from: blank \| importV1 \| jotform \| google_forms \| csv_questions`, P2 importers) | Idempotent create |
| `GET/PATCH /v1/forms/:id` · `POST …/clone` · `…/archive\|restore\|trash` · `DELETE …/:id` | Purge only when no legal hold |
| `GET /v1/forms/:id/draft` · `PUT /v1/forms/:id/draft` (`If-Match`) | `409 DRAFT_REV_CONFLICT`. **P2:** `PATCH /v1/forms/:id/draft` with `DocumentOp[]` and per-block rebase, so concurrent editors (BLD-14) do not collide on whole-document CAS |
| `GET …/draft/snapshots` · `POST …/snapshots/:sid/restore` | BLD-09 |
| `POST /v1/forms/:id/validate` | Publish-mode issues without publishing |
| `POST /v1/forms/:id/notice/approve` | CMP-24; records `noticeApprovedHash`; audited |
| `POST /v1/forms/:id/publish` | `{ label?, expectedDraftRev }`: migrate → `resolveForPublish` → `validateDefinition('publish')` (incl. notice completeness, consent ordering, purpose/recipient declarations, taint contexts, notice approval) → `compile` → server recompile-compare → hash → insert version → `live_version_id` → CDN purge → audit. Idempotent |
| `GET …/versions` · `…/versions/:n` · `…/versions/:a/diff/:b` · `POST …/versions/:n/revert` · `PATCH …/versions/:n` | BLD-09/10 |
| `GET /v1/forms/:id/presence` (SSE) · `POST …/presence` | BLD-14; SSE fed by LISTEN/NOTIFY on a **dedicated direct connection per pod** (not through PgBouncer) |
| *As built (WP-1.06):* `GET /v1/forms?q&sort&dir&lifecycle&favourite&cursor&limit` · `GET/PATCH /v1/forms/:id` · `PUT/DELETE …/favourite` · `POST …/clone` · `POST …/archive\|trash\|restore` · `POST /v1/forms` (`{ id?, title }` or `{ from: "importV1" }`) · `POST /v1/forms/merge` · `GET/PUT …/draft` | `sort` is `updated` (default), `created`, `title` or `submissions`. The cursor is HMAC-signed and bound to the exact query, caller and org; one from another sort, filter, member or org is 400 `INVALID_CURSOR`. Each row carries the caller's own `favourite`, `submissionCount` and `isLive`. `PUT …/draft` needs `If-Match` (428 without; `0` means "no draft yet"), decides in one `UPDATE … WHERE draft_rev = $expected`, and answers a stale save with 409 `DRAFT_REV_CONFLICT` carrying the server's `draft`, `draftRev`, `updatedAt` and `updatedBy`; the body is parsed with the strict `FormDefinition` twin, so an unknown key such as `settings.password` is 422 `DRAFT_INVALID` and is not stored. `PUT …/draft` and `PATCH` both lock the form row before the draft row (the opposite orders deadlocked). Clone makes a UUIDv7, titles it "Copy of …" and copies the draft only (not the access settings, not the versions). Archive, trash and restore run under a row lock; a repeat of the same verb is a no-op with no second audit record, and an impossible move is 409 `FORM_STATE_CONFLICT`. Trash is not delete: `DELETE /v1/forms/:id` is not built (BL-271). `POST /v1/forms` is idempotent by the client-chosen id and takes no `Idempotency-Key` (BL-274); `importV1` runs `migrateV1ToV2` on the server and hashes the v1 password in the same transaction (§2.4, `form_access`) |
| *As built (WP-1.07):* `POST /v1/forms/:id/publish` · `POST …/validate` · `GET …/live` | `publish` needs `forms.publish` and takes `{ expectedDraftRev?, clientDefinitionHash?, label?, media? }` (8 MiB). One pure pipeline (`apps/api/src/publish/pipeline.ts`) is shared with `validate`: strict parse (the draft's own `formId` is overwritten with the route's), `resolveForPublish` (the org profile comes through an interface that has no profile until WP-T1.3), `validateDefinition('publish')`, `patternIssues`, the redirect allowlist, `compile`, and a comparison of the client's plan hash with the server's. Error issues are 422 `PUBLISH_BLOCKED` with the whole list (`code`, `path`, `message`, `severity`, cut at 200 with `issueCount`); a different client hash is 422 `PLAN_MISMATCH`; neither stores anything, and the only plan ever stored is the server's own. A stale `expectedDraftRev` is 409 `DRAFT_REV_CONFLICT`; a revision that is already published returns its version, so a retry after a lost answer and six concurrent publishes make one version. The CPU work runs before the form row is locked (`FOR NO KEY UPDATE`, which a submit's foreign-key check does not wait for). Media is capped at 2 MB per version. `validate` needs `forms.edit` and writes nothing. Not built: the CDN purge and `runtime_projection` (WP-1.09), the notice-approval check (WP-1.21, WP-1.32) |

**Form operations**

| Method and path | Notes |
|---|---|
| `GET/PUT /v1/forms/:id/access` · `PUT/DELETE …/access/password` · `GET/PUT …/slug` | |
| *As built (WP-1.07):* the same routes, all `auth: 'user'` with permission `ops.manage` | `GET …/access` answers the defaults at revision 0 for a form nobody configured. `PUT …/access` takes `enabled`, `openAt`, `closeAt`, `availability` (`{ timeZone, windows }`, an IANA zone), `submissionLimit`, `embedAllowlist` (https origins), `redirectAllowlist` (host names), `screens` and `acceptPreviousVersionsHours`; `If-Match` is the revision read; a bad zone, a close before the open or a bad allowlist entry is 400 with the path. `PUT …/access/password` hashes with argon2id under an account's length and common-password rules; the response says only `hasPassword`. `PUT …/slug`: an address that another form holds, current or former, in any org, is 409 `FORM_SLUG_TAKEN`; the new address becomes primary and the old one keeps resolving. Audited: `form.access_changed` (keys only), `form.password_changed` (set or removed), `form.slug_changed` |
| `/v1/forms/:id/notifications[/:nid]` (+ `/test`) | External recipients need `data.route`; `purposeIds` required |
| `/v1/forms/:id/webhooks[/:wid]` (+ `rotate-secret`, `deliveries`, `replay`) | `data.route`; `purposeIds` required and must appear in the purposes' `recipients` |
| `/v1/connections…` · `/v1/forms/:id/integrations[/:iid]` (+ `runs`) | P2; `data.route` |
| `/v1/forms/:id/pdf-templates[/:pid]` (+ `preview`) | |
| `GET/PUT /v1/forms/:id/retention` | Can only shorten |
| `/v1/forms/:id/coupons` · `/stock` · `/payments` | P2 |
| `/v1/senders[/:id]` (+ `test`) | NOT-01 |
| *As built (WP-1.16):* `GET/POST /v1/email-senders` · `PATCH/DELETE /v1/email-senders/:id` · `POST …/:id/test` | The senders of the org (the plan's `/v1/senders`). `auth: 'user'`: writes need `org.settings`; the list needs `forms.read`, because whoever edits a form's emails must pick a sender, and those callers see the name and From address, not the relay or the test error. `POST` and `PATCH` take an `smtp://` or `smtps://` URL, seal it under the org's key and never return it; a new URL is sealed as a new secret and the old one deleted. The test send checks the connection and sends one message to the **signed-in caller's own address**, never one in the request, so the route cannot be used as a relay; success sets `verified_at`, a failure stores a scrubbed `last_test_error`; changing the URL or the From address clears `verified_at`. `DELETE` of a sender a notification uses is 409 `EMAIL_SENDER_IN_USE`. Audit: `email_sender.saved`, `.deleted`, `.tested` (keys and results, never an address or URL) |
| *As built (WP-1.16):* `GET/POST /v1/forms/:formId/notifications` · `GET/PUT/DELETE …/notifications/:id` · `GET /v1/forms/:formId/email-log` | Notifications and autoresponders as the strict `NotificationConfig` (422 `NOTIFICATION_INVALID` with paths); `forms.read` reads, `forms.edit` writes, `submissions.read` reads the log. `purposeIds` must be non-empty and declared in the draft's `privacy.purposes` (422 `MISSING_PURPOSE`, nothing written). A save that newly routes answers outside the people who may read them (a fixed address; a member or the form's owner whose role cannot read answers; the respondent's files or a PDF) also needs `data.route` (403 `DATA_ROUTE_FORBIDDEN`, audited as a denied `request.authorize`); a recipient that is an org member who may read answers, the org's admins, or a field the respondent fills in is not outside. `PUT` takes the revision in `If-Match` (428, 409 `NOTIFICATION_REV_CONFLICT`) and locks the row; at most 25 per form; a field the draft no longer has is a `warnings` entry, not an error (D5). The plan's `POST …/notifications/:id/test` (a test email of a notification) is not built (NOT-06, WP-2.16: BL-304). The log is newest first by a signed keyset cursor bound to the org, form and status filter (400 `INVALID_CURSOR` otherwise) and never shows a full address. Audit: `notification.saved` and `.deleted` |
| *As built (WP-1.18):* `GET/POST /v1/forms/:formId/webhooks` · `GET/PUT/DELETE …/webhooks/:id` · `POST …/:id/rotate-secret` · `GET …/:id/deliveries` · `POST …/:id/deliveries/:deliveryId/replay` | Every route needs `data.route`. The URL passes the edition's egress rule at every save (`https` only under `EGRESS_POLICY=open`; `http` or `https` for an allowlisted host under `allowlist`; nothing under `none`) and then the tenant egress guard, which resolves the name and refuses private, loopback and link-local addresses, `169.254.169.254` included (422 `EGRESS_DENIED`, which never says what a name resolved to). The server makes the signing secret, 32 random bytes sealed under the org's key, and returns `whsec_` + base64url **once**, from `POST` and from `rotate-secret`; reads show only `secretHint` and the rotation time. `PUT` is a compare-and-swap on `rev` (428, 409 `WEBHOOK_REV_CONFLICT`); turning a webhook back on, or changing its URL, clears the failure count and reason. The body names no id, org, secret or `filter`; an unknown key is refused. Replay inserts a new `pending` delivery (`replay_of`) and sends `webhook.deliver` in the same transaction; a switched-off webhook is 409 `WEBHOOK_DISABLED`, a delivery whose response is in the trash 409 `WEBHOOK_RESPONSE_TRASHED`. Audit: `webhook.saved`, `.deleted`, `.secret_rotated`, `.replayed` (the host, never the path or query) and, from the worker, `webhook.disabled` |

**Submissions, files and exports**

| Method and path | Notes |
|---|---|
| `GET /v1/forms/:id/submissions?…` | Columns are the union over versions; sensitive values masked unless `reveal=1` (audited); every page read audited (coalesced) |
| `GET /v1/submissions/:sid` · `PATCH /v1/submissions/:sid` | Audited read; edits revalidated, revision row |
| `POST /v1/forms/:id/submissions/bulk` | Large sets run as a job |
| `POST /v1/forms/:id/submissions/import` (P2) | CSV/XLSX with mapping; lawful-basis declaration; optional retrospective-notice campaign (s.5(2)) |
| `GET …/revisions` · `POST …/request-update` · `POST …/resend/:nid` · `POST …/rerun/:wid` · `POST …/reply` · `POST …/forward` (P2) | Reply/forward write `disclosures` |
| `/v1/submissions/:sid/comments` (P2) | |
| `POST /v1/files/:fileId/download` | Presigned GET or stream; audited; disclosure if to an external party |
| *As built (WP-1.15):* `GET /v1/forms/:formId/submissions` · `GET\|PATCH …/submissions/:id` · `POST …/submissions/bulk` · `GET /v1/forms/:formId/files/:id` | Ids sit under the form, not at `/v1/submissions/:sid`. The grid (`submissions.read`) takes `limit`, `cursor`, `from`, `to`, `status`, `read`, `starred`, `view` (`inbox`, `archived` or `trash`) and `q`. Columns are the union of the fields of every version, one per block id, labelled by the newest version; cells are built on the server with the field type's own text, and encrypted and sensitive fields (and values derived from one) show a mask and are listed in `masked`. Pages are newest first by `(received_at, id)` with a signed cursor bound to the exact query and member (400 `INVALID_CURSOR`, never the first page). `q` goes to the `SearchIndex` scoped to the org and the form, and is intersected with the view and the filters. **Every read is audited:** one `submission.page_viewed` per page with every id shown (split over as many records as the 16 KiB metadata limit needs, BL-192) and one `submission.viewed` per detail. `GET …/:id` rebuilds the fields from the version the response was received on, so a response keeps the labels it was answered under. `PATCH` (`submissions.edit`) sets `read` and `starred`; a flag already at the asked value writes nothing and records nothing. `bulk` takes up to 500 ids and `mark_read`, `mark_unread`, `star`, `unstar`, `archive`, `unarchive`, `trash`, `restore` or `delete`: one transaction, an id that is not a response of this form is counted as `missing` and touched by nothing, and `delete` needs `submissions.delete` and refuses the whole call (409 `SUBMISSION_NOT_TRASHED`, `SUBMISSION_HELD`) unless every response named is in the trash and free of a legal hold or statutory period; it removes the rows, their search documents and `form_files` rows in the transaction and the bytes after it commits, so a rolled-back delete loses no bytes. A search and a delete answer 503 on an app built without a search index (the composition root passes the Postgres adapter). `GET …/files/:id` hands a stored upload to a member with `submissions.read` of the owning org, as an attachment (octet-stream or a known image type, `nosniff`, no cache; never under another form), and the download is audited. Not built: `reveal=1` (WP-1.11), `/v1/submissions/:sid`, revisions and exports (WP-1.17) |
| `POST /v1/forms/:id/exports` → `GET /v1/exports/:jobId` | `includeSensitive` needs a reason; audited; disclosure rows |
| *As built (WP-1.17):* `POST /v1/forms/:formId/exports` · `GET /v1/exports/:id` · `GET /v1/exports/:id/download` | Every route needs `submissions.export`. `POST` takes `{ format: csv or xlsx, scope: all, selected (1 to 1000 ids) or filtered (a received-at range), includeSensitive?, reason? }` and a required `Idempotency-Key`: a retry returns the same export with `Idempotent-Replayed: true` and enqueues nothing, and the same key for another export is 422 `EXPORT_KEY_REUSED`. `includeSensitive` without a reason is 422 `EXPORT_REASON_REQUIRED`. At most 10 exports are queued or running per org and 100 may be asked for in a day, otherwise 429 `EXPORT_QUOTA_REACHED` with `Retry-After`; the check holds an advisory lock per org so ten requests that each saw nine cannot all insert. One transaction inserts the `exports` row, writes `submission.exported` (naming the session and a keyed hash of the address) and sends `export.build`. The download is streamed through the API from the `exports` bucket, never a presigned URL (a bearer URL could be forwarded; every download must pass the session check and write `export.downloaded` before the first byte): 409 `EXPORT_NOT_READY` or `EXPORT_FAILED`, 410 `EXPORT_EXPIRED`. An export belongs to the member who asked: anyone else, an owner included, gets 404, because the file is redacted for its requester. Without an object store every route is 503 |
| `/v1/forms/:id/views` (P2) · `GET …/submissions/stream` (SSE, P2) | |
| `GET/POST /v1/guardian-verifications` · `POST …/:id/decide` | CMP-13 manual review queue |

**Review (WP-2.33, as built; no row in the plan's map)**

| Method and path | Notes |
|---|---|
| `GET/POST /v1/org/review-groups` · `PATCH /v1/org/review-groups/:id` · `PUT/DELETE /v1/org/review-groups/:id/members/:userId` | Writes need `members.manage`; the list needs `members.manage` or `submissions.review`. A member is added only if active and their role carries `submissions.review` (422 `NOT_A_REVIEWER`); an archived group takes no members (409 `REVIEW_GROUP_ARCHIVED`); groups are archived, never deleted. Audit: `review_group.created`, `.updated`, `.member_added`, `.member_removed` |
| `GET/PUT /v1/forms/:id/review` | The form's live review settings. `forms.read` reads, `ops.manage` saves with `If-Match` (428 `REVIEW_SETTINGS_REV_REQUIRED`, 409 `REVIEW_SETTINGS_CONFLICT`). A unit that is not in the draft's or the live version's `review` units, is assigned twice, or names a group that is not an unarchived group of this org is 400 `VALIDATION_FAILED` with the path, and a group of another org answers as one that does not exist. Audit: `review.settings_updated` |
| `GET /v1/reviews/queue?formId&unitId&age&cursor` | `submissions.review`. The units the caller could decide **now**: pending on a response still held, in a group the caller belongs to (the group the unit was opened with), no required unit of a lower order open, and the four-eyes rule leaves it to them, which is the test `review_decide()` makes, so the queue never offers work that would be refused. Lists a unit, never an answer: form title, unit name, response id, age, round. `age` is `1d`, `3d`, `7d` or `30d`; the cursor is signed and bound to the caller and filters |
| `GET /v1/forms/:formId/submissions/:id/review` | A held response as its checker may see it: each unit with state, group and whether the caller may decide it now, the decision history (who, when, reason code, round), and the answers with `own_unit` redaction. Every read writes `submission.viewed` in the same transaction. Files and unit tokens of units the caller may not see are left out and computed values are never sent |
| `POST /v1/forms/:formId/submissions/:id/review/units/:unitId/decisions` | `submissions.review`. Body `{ decision: approve or reject, reasonCode?, answersHash }` (the token of the detail) and a required `Idempotency-Key`. The response is looked up before the session check, so another org's response is 404 and never a 403 that says something about it. Refusals: 403 `FOUR_EYES_VIOLATION`, `NOT_IN_REVIEW_GROUP`, `MFA_REQUIRED` (each a denied `review.decided`); 409 `REVIEW_STALE`, `REVIEW_ORDER_BLOCKED`, `REVIEW_CLOSED`; 422 `IDEMPOTENCY_KEY_REUSED`. One transaction: `review_decide()`, `review.decided`, `review.finalised` when it settled the response, and the single `submission.fanout` `released` for a response that became `complete`. The two-factor check that needs the session (`mfaLevel`) runs in the route; `review_decide()` repeats it from the user's own enrolment |
| *Existing routes that changed* | `GET/PATCH /v1/org/settings` carry `reviewCheckersMfa`. The responses grid and detail show a `review` summary (each unit's name and state, nothing else) for a response that was held, accept `status=pending_review` and `status=rejected`, apply the `own_unit` redaction and refuse `q` to a redacted reviewer (403 `SEARCH_NOT_ALLOWED_FOR_REVIEWER`); `GET /v1/forms/:formId/files/:id` answers 404 for another unit's file. `POST /v1/p/:slug/submissions` answers `held: 'pending_review'` for a held response |

**Analytics, templates, compliance, keys, assets**
- Analytics: `GET /v1/forms/:id/analytics`, `…/funnel`, `…/breakdown`, `/v1/forms/:id/reports` (P2).
- Templates: the templates spec §5.3 routes, mounted unchanged.
- Compliance:

| Method and path | Notes |
|---|---|
| `GET /v1/compliance/inventory?formId` · `POST /v1/compliance/ropa-exports` | CMP-03, CMP-15 |
| `GET /v1/forms/:id/consents` · `GET /v1/consents/lookup?principal=` | Principal values blind-indexed before the query |
| `GET/PUT /v1/org/retention` · `POST/DELETE /v1/legal-holds` · `GET /v1/statutory-hold?…` (audited) | CMP-06, CMP-23 |
| `POST /v1/dsr` · `GET /v1/dsr[/:id]` · `POST /v1/dsr/:id/search\|export\|correct\|erase\|close` | CMP-09/10 (P1). Export includes `disclosures`. Erase is a job with dry-run, blocked by legal hold, subject to the statutory floor; the response says what is restricted and until when |
| `POST /v1/incidents` · `POST /v1/incidents/:id/principal-notices` · `GET /v1/incidents/:id/board-draft` | CMP-14 fiduciary tooling (§8, control 15) |
| `POST/DELETE /v1/org/deletion` | CMP-17; 30-day cooling-off; certificate states method and backup-expiry date |

- API keys (P2): `GET/POST /v1/api-keys`, `POST …/:id/rotate`, `DELETE …/:id`.
- Assets: `POST /v1/assets/uploads` → `…/complete` → `GET /v1/assets/:id`.
- Security: `POST /v1/csp-reports` (no session; `application/csp-report` and `application/reports+json`, 64 KB) logs the builder's CSP violations scrubbed, without samples (§4.5, control 14).

**Runtime public** (runtime host):

| Method and path | Notes |
|---|---|
| `GET /f/:slug` (SSR HTML) · `GET /f/_v/:versionId.json` | JSON immutable, cacheable for a year |
| `POST /f/:slug/session` | `{ status, publicConfig, renderToken, visitId, accessToken? }`; records a view; no-store |
| `POST /f/:slug/unlock` | Password → 2 h access token. Limited per IP **and** visit token (§3.5); audited |
| `POST /f/:slug/uploads` → presigned POST · `…/:fileId/complete` · `…/:fileId/status` | §4.6 |
| `POST /f/:slug/submissions` | `Idempotency-Key` = `idempotencyKey` |
| `POST /f/:slug/validate-page` | Only legitimate-use fields and fields with granted consent |
| `POST /f/:slug/otp` · `…/otp/verify` (P2) | |
| `GET /f/:slug/appointments/:blockId/slots` · `POST …/hold` (P2) | |
| `POST /f/:slug/drafts` · `GET /f/:slug/drafts/:resumeToken` (P2) | |
| `POST /f/:slug/events` | Batched beacons; ignored for forms with a children policy except page-level counts |
| `GET /f/:slug/pow-challenge` | ALTCHA-style proof of work |
| `GET/POST /s/:token` | Edit, withdraw consent (one click, CMP-05), receipt, resume, workflow action, DSR identity confirmation, guardian verification. Sets `app.subject_ids` after verification |
| *As built (WP-1.07, WP-1.12):* `GET /v1/p/:slug` · `POST /v1/p/:slug/unlock` · `POST /v1/p/:slug/files` · `POST /v1/p/:slug/submissions` | **Served by the API process, pending the runtime host (WP-1.09), which will serve `/f/:slug/…` and make these obsolete.** All four are `auth: 'none'`: a respondent has no account, so there is no session to require, and what a stranger with `curl` and a form address can do is read a live form's status, guess its password, upload a file to one of its upload fields and write one response at a time within its status and limit. The org, the id, the moment, the status and every stored column are the server's; the slug is resolved on every request, so a form that is unpublished, archived or trashed stops answering at once. `GET` answers the status now (open, closed, not yet open, outside hours, limit reached or password) and, unless the form is behind its password, the live projection; an old address answers `{ redirectTo }`; a password form answers with its status only and withholds its questions, whatever the status, until the request carries a valid `X-FR-Access` token; `Cache-Control: no-store`. `POST …/unlock` takes `{ password }` and returns a two-hour token bound to the form, the live version and the issue time, so a republish, or a password change, asks again; a wrong password and a form with no password take the same argon2id work and give the same 401 `FORM_UNLOCK_FAILED`, and a refusal is audited as `form.unlock_failed` with the keyed address hash and nothing else about the caller. `POST …/files` takes base64 in JSON, with a server-made id, a type sniffed on the server against an allowlist and a size limit read from `Content-Length` before the body is parsed (until the presigned flow of WP-1.14). It takes a file only while the form takes responses, and asks that the way a submission does (`readAccess`, `isUnlocked`, `runtimeStatus`, one `assertOpen` for both), before the body is read: 409 `FORM_CLOSED` or `LIMIT_REACHED`, 401 `PASSWORD_REQUIRED`. An upload names no version, so its `X-FR-Access` token must be the one for the live version, and a republish asks again. `POST …/submissions` needs an `Idempotency-Key` header (exactly one uuid, in either case: the server lower-cases it before it looks the key up, so `ABC…` and `abc…` are one key; a missing, repeated or malformed header is 400) and takes `{ formVersionId, answers, fields[], locale, client? }`, where `client` (`startedAt`, `urlParams`, `pageUrl`, `referrer`, `device`, `embedOrigin`) is advisory and stored only as the address without its query, the referrer's host and the device. It answers `{ ok, submissionId, endingId }`, with `Idempotent-Replayed: true` for a retry; 422 `SUBMISSION_INVALID` names each field; 409 `FORM_CLOSED`, `LIMIT_REACHED` or `VERSION_SUPERSEDED`; 401 `PASSWORD_REQUIRED`; 422 `IDEMPOTENCY_KEY_REUSED`. An answer that a rule hides is dropped, and the blocks the server owns (hidden, calculation, context and unique ID) are removed from the answers before they are evaluated: a hidden field is filled only from the page address the browser reported (`client.urlParams`), never from the answers it sent, so a respondent cannot write into a field the server owns. The limits of §3.5 run before the body is read. `POST /v1/p/by-form/:formId/submissions` is gone: a form id is not a way to write to a form |

**Platform** (port 8081): health, licence, orgs, suspend, plan overrides, `POST /platform/break-glass` (`{ orgId, reason, ticket, ttlMinutes ≤ 60 }`, notifies the org's security contacts, dual audit), jobs and DLQ, audit verify, template packs, `POST /platform/incidents` (CERT-In report drafts).

### 3.4 Idempotency
- `Idempotency-Key` is **required** on `POST /f/:slug/submissions`, `POST /v1/templates/:id/use`, `POST /v1/forms`, `POST /v1/forms/:id/publish`, every public-API create, and exports.
- `idempotency_keys (org_id, scope, key)` with a SHA-256 of the canonical body: same key, different body → `422 IDEMPOTENCY_KEY_REUSED`; in flight → `409 IN_PROGRESS`; completed → stored response with `Idempotent-Replayed: true`. TTL 24 h.
- Runtime submits use `submission_idempotency` (org- and form-scoped, RLS, encrypted response). *As built:* the stored response holds ids only and is not encrypted (§2.4); the generic `idempotency_keys` table is not built (BL-274).

### 3.5 Rate limits

`@fastify/rate-limit` with a Postgres store (UNLOGGED fixed window, `INSERT … ON CONFLICT DO UPDATE … RETURNING`) behind an in-process token bucket.

| Bucket | Key | Limit |
|---|---|---|
| `auth_login` | ipHash + emailNorm | 10 / 15 min, then captcha (PoW), then growing backoff |
| `auth_any` | ipHash | 60 / min |
| `auth_account` (as built) | emailNorm (keyed hash) across IPs, password attempts | 30 / h, then a password sign-in steps up to an emailed link (`link_sent` whatever the password; the link only when it was right), never a lockout |
| `auth_mail` (as built) | emailNorm (keyed hash) | 10 / h links mailed to one address (sign-up, magic link, reset, step-up); failed passwords never count |
| `auth_mfa` (as built) | user id | 30 / h second-factor checks (MFA tickets and the signed-in TOTP routes) |
| `builder_read` / `builder_write` | userId | 600 / min · 120 / min |
| `api_read` / `api_write` | apiKeyId | per plan; `RateLimit-*` headers |
| `runtime_session` | ipHash + form | 300 / min (CGNAT-friendly) |
| `runtime_submit` | **visit token** + form; ipHash + form as a signal | 10 / min per visit token. Per IP: **60 / min raises the spam score and triggers on-suspicion captcha; it does not reject** (schools, offices and mobile CGNAT share IPs). Per form: 500 / s guard |
| `runtime_upload` | visit token + form | 60 / 10 min, plus bytes per hour |
| `runtime_unlock` | **ipHash + visit token** + form | 5 / 15 min per visit token, exponential lockout per visit token; a high per-IP rate only adds captcha |
| `auth_files_ip` · `auth_files_form` (as built, WP-1.12) | keyed hash of the address; keyed hash of address and form | `POST /v1/p/:slug/files`, per 10 min: **240** per address over every form, **120** per address and form |
| `auth_submit_ip` · `auth_submit_form` (as built, WP-1.12) | the same two keys | `POST /v1/p/:slug/submissions`, per 10 min: **120** per address over every form, **60** per address and form |
| `auth_unlock_ip` · `auth_unlock_form` (as built, WP-1.07) | the same two keys | `POST /v1/p/:slug/unlock`, per 15 min: 30 per address over every form, 10 per address and form; every attempt counts, the right password too |
| `otp_send` | email bidx + form | 3 / 15 min, 10 / day |
| `exports` | org | 10 concurrent, 100 / day |

The rate-limit IP hash is `HMAC(daily_salt, ip)` (CMP-11). Uniqueness (ACC-07) uses the per-form salt instead.

*As built (WP-1.07, WP-1.12).* The six `auth_*` buckets above stand in for `runtime_submit`, `runtime_upload` and `runtime_unlock` until the runtime host and the visit token exist (WP-1.09, WP-1.13). They key on the address hash alone (a keyed hash, never the address; the form joins it as a second keyed hash), which is not CGNAT-friendly, so the limits are far above what a person does (a classroom behind one address still fits 60 submissions in 10 minutes to one form) and, unlike the plan's `runtime_submit`, a spent budget **rejects**: `429` problem+json with `Retry-After`, audited once per window as `auth.throttled` with the hash and no address. For uploads and submissions the per-address budget is counted first, before anything about the form is looked up, and both budgets are counted before the body is read; a refusal closes the connection so a client does not go on sending a body nobody reads, and an unknown form is a 404 that still counts against the address. Unlock counts both budgets before any password work. The unlock budgets are two because each attempt costs an argon2id check (64 MiB in the libuv threadpool) whether or not the form has a password: the per-form budget alone would give one address a fresh budget for every slug it can find or publish. Limits are `DEFAULT_AUTH_LIMITS` in `apps/api/src/modules/auth/throttle.ts`, and `auth_throttle_hit()` accepts any `auth_` bucket name, so a new bucket needs only its name in `AUTH_THROTTLE_BUCKETS` (`packages/db/src/auth.ts`) and its limit, and no migration.

### 3.6 Pagination, filtering and versioning
- Cursor pagination everywhere (`limit` 50, max 200; HMAC-signed cursors). No offset paging; `?count=estimate` optional.
- Sorting allowlists; `?fields=` on public lists.
- `/v1` changes are additive; oasdiff gates breaking changes; `Deprecation`/`Sunset` headers for 6 months; webhook payloads carry `apiVersion` and can be pinned.
- Docs rendered with Scalar, self-hosted (`/v1/docs` SaaS, bundled `/docs` on-prem).

---

## 4. Runtime and embed

### 4.1 Decision: React SSR first paint plus an immutable version JSON, behind a cache (ADR-0003)

- First paint on low-end Android over 3G/4G matters most. SSR of the first page (30–60 kB HTML with inlined critical CSS) puts interactive fields on screen before the ~90 kB gz renderer + React load.
- The definition is immutable, so SSR renders from a cached `RuntimeFormVersion` and every per-visitor value stays out of the HTML.

```
Browser ──GET /f/acme-kyc──▶ [CDN (SaaS) / ingress cache (on-prem)] ──▶ runtime SSR (React 19 renderToPipeableStream)
                                                                         │ resolve slug → liveVersionId (10 s LRU)
                                                                         │ load runtime projection (LRU, immutable)
        HTML: first page + <script type="application/json" id="fr-v">projection</script> + hashed assets
Cache-Control: public, s-maxage=60, stale-while-revalidate=600 ; Vary: Accept-Language ; Surrogate-Key: form:<id>
Cache key: path only — the QUERY STRING IS EXCLUDED (prefill is applied on the client), and CDN query logging is off
Browser hydrate ──POST /f/acme-kyc/session──▶ { status, publicConfig, renderToken, visitId, accessToken? }   (no-store)
```
- **Prefill hygiene (C-M13):** the runtime reads prefill parameters on the client, then removes them from the address bar with `history.replaceState`; `Referrer-Policy: no-referrer` stops them leaking to third parties; OTel `http.url`/`url.query` are scrubbed (§3.2) and `enhancedDatabaseReporting` stays off. On SaaS the CDN is a listed sub-processor terminating TLS in India; `/f/*/submissions` and `/f/*/uploads` bypass the CDN.
- Status that changes what is shown (closed, not yet open, limit reached, password) is re-rendered client-side from `/session`; SSR also renders it when its 10-second status cache already knows. Publishing or status changes purge `form:<id>` through `CdnPurge` (no-op on-prem); staleness is bounded at 60 s and **the server rejects submits to closed forms regardless**.
- Password-protected forms: HTML and JSON are `private, no-store`; the projection is withheld until `/unlock`.
- `RUNTIME_MODE=embedded`: the API process serves SSR too (small on-prem installs run one `server` deployment).
- Assets: `/_a/*` content-hashed and immutable; Noto font subsets per script, loaded only for the form's locales; no third-party origins unless the form opts in to third-party captcha, payments or tracking (CMP-12).

### 4.2 Hosts and isolation (ADR-0013)

- Subdomains of one registrable domain are the **same site**: SameSite cookies flow between them and Fetch-Metadata reports `same-site`. So on SaaS the runtime and user files are served from a **separate registrable domain** (for example `formsuser.in`, to be chosen: decision D13), not `forms.<domain>`.
- Builder (`app.<domain>`) and API (`api.<domain>`) stay same-site; the session cookie is `__Host-` scoped to the API host.
- Uploaded files are served from the user-content domain with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- On-prem: hosts are Helm values; the chart documents that using subdomains of one site leaves only CORS between respondent content and the API, and recommends a separate domain where possible.
- **Custom domains** (P3, PUB-10) map onto the runtime host via cert-manager / ACME.

### 4.3 Embedding (PUB-04/05/06)
- **Iframe:** `<iframe src="https://<runtime>/f/acme-kyc?embed=1" title="…" allow="camera; clipboard-write; payment">`.
- **Script:** `<script src="https://<runtime>/embed.js" data-fr-form="acme-kyc" data-fr-mode="inline|popup|lightbox|feedback" data-fr-pass="utm_*,ref" async></script>`. `@form/embed` (< 6 kB gz, SRI hashes per release) creates the iframe, passes only listed URL params (via the fragment/postMessage, not the iframe query string), handles resize and modes, and exposes `window.fORM.on('submit', cb)`.
- **postMessage protocol** (`@form/sdk/protocol`):
```ts
type FrToHost =
  | { fr: 1; ch: string; t: 'ready' | 'page'; pageId?: string }
  | { fr: 1; ch: string; t: 'resize'; height: number }
  | { fr: 1; ch: string; t: 'submit'; submissionId: string; endingId: string }   // no answers, ever
  | { fr: 1; ch: string; t: 'redirect'; url: string };                          // https only
type HostToFr = { fr: 1; ch: string; t: 'prefill'; params: Record<string, string> };  // subject to allowPrefill
```
  `ch` is a random channel id in the iframe URL fragment; both sides check `event.origin`.
- **`frame-ancestors`** from `form_access.embed_allowlist`; empty means `*` (forms are embeddable), with a builder warning for forms with sensitive fields.

### 4.4 Spam and abuse (SPM-01..04, FLD-29)
Cheapest first, all on the server:
1. Rate limits (§3.5).
2. **Render token** from `/session` (HMAC over version, issuedAt, visitId), issued < 24 h ago; `submittedAt − issuedAt ≥ minFillSeconds` (default 3 s) or the submission is quarantined.
3. **Honeypot** with a randomised name per version; non-empty → quarantine.
4. **Captcha:** `off`, `always`, `on_suspicion` (spam score ≥ 0.5: per-IP velocity, missing interaction counter, disposable email). **Proof of work (ALTCHA-compatible, adaptive difficulty) is the default provider in every edition** and the only one air-gapped. hCaptcha, Turnstile and reCAPTCHA v3 are per-form opt-ins that must be declared in a purpose's `recipients` and on the sub-processor list (C-M12).
5. **Disposable-email list**, bundled per release.
6. **OTP** (SPM-04) where configured.
7. Result: `status = 'spam'` (quarantine, SPM-03) with "not spam" restore. Quarantined submissions trigger no side effects until restored. **Respondents see the normal ending**: quarantine is silent.

### 4.5 Content Security Policy (hash-based, cache-safe)

Nonces cannot sit on cacheable HTML, so the runtime CSP is **hash-based**, computed at publish (C/F-25):
```
default-src 'none';
script-src 'self' 'strict-dynamic' 'sha256-{bootstrap}' {captchaOrigins?} {paymentOrigins?};
style-src 'self' 'sha256-{themeVars}' 'sha256-{customCss}';
img-src 'self' https://{filesHost} data: blob:;
font-src 'self';
connect-src 'self' https://{apiHost} https://{stagingBucketOrigin} {captchaOrigins?} {paymentOrigins?};
frame-src {captchaOrigins?} {paymentOrigins?};
form-action 'self'; base-uri 'none';
frame-ancestors {embedAllowlist | *};
require-trusted-types-for 'script';          # report-only when payment or third-party captcha scripts are present
report-to csp;
```
- The bootstrap script, theme variables and custom CSS are inline blocks whose hashes are stored in the version's runtime projection; the CSP header is a function of the version, so it is identical for every visitor and cacheable.
- Analytics origins are added only when ANA-05 is enabled **and** the consent purpose is granted; tags load after consent through the bootstrap.
- Custom CSS (DSN-04) is sanitised at publish with a css-tree allowlist (no `@import`, no `url()` other than bundled fonts, no `expression`, `behavior`, `-moz-binding`), scoped under `.fr-root`.
- **Builder:** `script-src 'self'`, `style-src 'self'`, Trusted Types enforced with no policies (`trusted-types 'none'`), `frame-ancestors 'none'`, reports to `POST /v1/csp-reports`; served as in [builder-security-headers.md](builder-security-headers.md) (WP-1.05). **API:** `default-src 'none'; frame-ancestors 'none'`. Runtime and builder send `Referrer-Policy: no-referrer` and `strict-origin-when-cross-origin` respectively.

### 4.6 File uploads: presigned POST, staging bucket, AV scan

```
renderer uploader ──POST /f/:slug/uploads {blockId,rowId?,name,size,mime,renderToken,draftId?}──▶ api
   api: block config (accept, maxFileBytes, maxFiles), plan quota, per-visit count
        insert submission_files(status=pending_upload, bucket=staging, draft_id or upload_session_id)
        Storage.presignPost({ bucket:'staging', key:'u/{org}/{form}/{yyyy}/{mm}/{fileId}', contentType, contentLengthRange:[min,max], expires: 10m })
renderer ──multipart POST directly to the bucket──▶ STAGING bucket (unversioned, 48 h lifecycle)
renderer ──POST /f/:slug/uploads/:fileId/complete──▶ api: head() → size matches → status=uploaded → enqueue file.inspect
worker file.inspect:
   1. sniff MIME (first 4 KB, file-type); must match accept.mimeTypes AND extension, else failed
   2. images: strip EXIF/GPS (sharp re-encode) when stripMetadata (default true)
   3. AVScanner.scan → infected: delete from staging, status=infected
   4. sensitive field: encrypt (per-file DEK) while copying
   5. copy to the versioned UPLOADS bucket, delete the staging object, status=clean
submit: answers reference fileIds; each must belong to the same org/form/block and to the same draft or submission
        (or the same render session when no draft exists), status=clean (or uploaded/scanning when scan='async');
        scan='required' + not clean → pending_scan (released by file.inspect)
gc: uploads.gc deletes unattached files after 24 h
```
- Presigned **POST** enforces `content-length-range` on S3-compatible stores (C/F-29).
- Plaintext and infected objects only ever exist in the **unversioned** staging bucket, so versioning on the uploads bucket never retains them.
- Uploads bound to a draft survive resume (RSP-03) and respondent edits (RSP-09).
- Signature pads upload a PNG through the same `uploader` (never a data URL).
- `AV_DRIVER=none` forces `scan: 'off'` with a loud publish warning.

---

## 5. Jobs (pg-boss)

### 5.1 Conventions
- **pg-boss v10+** in its own schema (optionally in a separate queue database). pg-boss tables are not under RLS; they hold ids only.
- **Job envelope (ADR-0016):** `{ v: 1, orgId, resource: { type, id }, data, sig }`, where `sig` = HMAC over the rest with a worker-held key. Handlers verify `sig`, re-derive the org with `resolve_job_org(resource)` and abort on mismatch before entering `withTenant({ orgId, actor: 'system', perms: [job-specific minimal set] })`. Arbitrary inserts into `pgboss.job` therefore cannot act on another org (F-23).
  - As built (WP-0.14): `sig` is `<keyId>.<base64url HMAC-SHA256>` over the canonical JSON (sorted keys) of `{ v, queue, orgId, resource, data }`; the queue name is signed so an envelope cannot be replayed into another handler. `JOB_SIGNING_KEYS` is a key ring (the first signs, all verify). The queue scope (`JOBS`) is checked too: `org` jobs need an org, `system` jobs must have none. A rejected envelope (malformed, scope mismatch, unknown key, bad signature, resource missing or of a type `resolve_job_org` does not know, org mismatch) never runs: it gets a `job.rejected` denied audit record on its own connection, filed under the org that owns the resource when the database names one, and goes straight to the dead-letter queue.
  - The pg-boss schema is installed by its owner (`installQueueSchema`, with the migrations); `fr_app` gets row access only. Every queue `<name>` has the dead-letter queue `<name>.dead`; the policies are `JOB_POLICIES` in `@form/ports`, and `exclusive` queues use pg-boss's `singleton` policy.
  - `system.heartbeat` has scope `any`: with an org it makes one RLS round trip in that tenant and leaves an audit record; from cron it pings the database.
- **Payloads carry ids only.** Where a job must carry a secret (magic link, OTP code, invite token for `email.send`), that field is encrypted with the secrets DEK, and auth queues have a 1-day archive retention.
- **Org-spanning jobs** (`retention.sweep`, `drafts.expire`, `analytics.rollup`, `payment.reconcile`, `billing.meter`, `kms.rotate`, `dsr.overdue`) call `orgs_due_for(job)` and process one `withTenant` per org. `audit.checkpoint`, `audit.verify` and `audit.archive` walk `audit_chain_keys()` instead (every chain, the platform chain included; §2.7). Cross-tenant aggregates (`templates.stats`) use the `fr_system_agg` role only. `partitions.maintain` calls `create_partitions()` (F-1).
- **Transactional outbox:** enqueue in the business transaction.
- Every queue declares `retryLimit`, `retryBackoff`, `expireInSeconds`, a DLQ and `singletonKey` where needed. Handlers are idempotent through `job_effects` (30-day TTL). **Email delivery is at-least-once**: a crash between SMTP acceptance and recording the effect can resend; the stable `Message-ID` lets clients de-duplicate (F-49).
- **Pools:** `worker` runs everything except `pdf.*` and `templates.thumbnail` (`worker-pdf`); concurrency per queue.
- **Cron** via `boss.schedule()` in UTC, single-node per schedule.

### 5.2 Queues

| Queue | Trigger | Retry | Notes |
|---|---|---|---|
| `submission.fanout` | submit, edit, release of a held submission | 5 | One job per event; enqueues only configured effects (no empty work) |
| `notification.dispatch` | fanout | 5, 30 s → 1 h | Recipients, variant, locale, masking, purpose filter → `email.send`; writes `disclosures` |
| `email.send` | dispatch, auth, invites, OTP, DSR, guardian requests, breach notices | 8, 1 m → 6 h, DLQ | Suppressions; `email_messages`; hard bounce → suppression |
| `email.scheduled` | NOT-09 delays, reminders | – | Cancelled on erasure or withdrawal |
| `webhook.fanout` / `webhook.deliver` | fanout, `consent.withdrawn`, deletes | 1 m … 24 h × 3, then dead | 10 s connect / 30 s total; `fORM-Signature: t=…,v1=HMAC`; auto-disable after 50 failures; **SSRF guard** (DNS pinned, private ranges blocked on SaaS, allowlist on-prem, no redirects); purpose-filtered body; `disclosures` row |
| `integration.fanout` / `integration.run` (P2) | fanout, withdrawal | like webhooks | Purpose filter; on withdrawal, provider delete calls where supported, results recorded |
| `consent.withdrawn` | `/s/:token` withdrawal, owner UI, API, DSR | 5 | CMP-05: erase answers whose purposes are all consent-based and withdrawn (subject to the statutory floor → `statutory_hold_move`), cancel scheduled emails, reminders and workflows, emit the webhook event, delete downstream (P2 integrations), send the confirmation email |
| `guardian.expire` | cron every 15 min | – | Deletes `pending_guardian_consent` submissions past `expiryHours` |
| `workflow.step` (P2) | `start_workflow`, approvals | 5 | `workflow_runs` state machine |
| `pdf.render` | export, attachment, ending download, DSR export | 3 | Renderer print mode → Chromium `page.pdf()`; **all** network blocked except local assets; bundled Noto fonts; qpdf passwords |
| `export.build` | exports | 2 | Streaming cursors; formula-injection escaping; audited; `disclosures` |
| `file.inspect` | upload complete | 3 | §4.6 |
| `retention.sweep` | cron 15 min, per org via `orgs_due_for` | – | `DELETE FROM submissions WHERE (id, received_at) IN (SELECT id, received_at FROM submissions WHERE delete_after < now() AND NOT legal_hold LIMIT 5000)`; data within the statutory floor moves to `statutory_hold` instead; covers every table in `pii_coverage` |
| `signals.ttl` | cron daily | – | Nulls `meta.ipHash` / `uaHash` and other signals past their TTL (CMP-11) |
| `statutory.purge` | cron daily | – | `statutory_hold_purge()` at the floor date |
| `drafts.expire` | cron hourly | – | Partial submissions, upload GC, expired holds, idempotency TTLs, rate-limit cleanup, `job_effects` TTL |
| `dsr.execute` / `dsr.overdue` | DSR action / cron daily | 3 | Erase across every `pii_coverage` table (submissions, partials, prefill links, comments, revisions, workflow runs, holds, payment event objects, delivery snippets, export objects, email log via `to_bidx`), pseudonymise consents, integration deletes; overdue alerts to assignees |
| `inactivity.notify` / `inactivity.erase` | cron daily | – | Third Schedule `inactivity` retention: 48 h notice, then erase |
| `org.delete` | after cooling-off | manual | Export → `org_purge()` → destroy org keys → certificate (method + backup-expiry date) |
| `analytics.rollup` | cron hourly per org | – | Raw → daily; drops raw partitions > 30 d |
| `partitions.maintain` | cron daily | – | `create_partitions()` for submissions, search, audit, email, deliveries (monthly) and analytics (daily) |
| `audit.chain` / `audit.checkpoint` / `audit.verify` / `audit.archive` | continuous / hourly / daily / monthly | – | §2.7 |
| `kms.rotate` | yearly or on demand | – | |
| `payment.reconcile` (P2) | webhook + cron 10 min | 10 | Releases or fails held submissions, stock and slots |
| `billing.meter` | cron hourly (SaaS) | – | Usage → Stripe/Razorpay; 80% / 100% emails |
| `templates.seed` / `templates.thumbnail` / `templates.update_notify` / `templates.export` / `templates.import` / `templates.stats` | per templates spec | | `templates.stats` as `fr_system_agg`; thumbnails in `worker-pdf` |
| `search.reindex` | sensitivity change, bulk import | 3 | |
| `geoip.refresh` (SaaS) | weekly | – | On-prem gets the DB in the bundle |

*As built (16 Nov 2026):* the worker serves `submission.fanout`, `notification.dispatch`, `email.send`, `webhook.fanout`, `webhook.deliver` and `export.build` as §5.3 describes. `email.scheduled`, `consent.withdrawn`, `pdf.render`, `integration.*`, `retention.sweep`, `dsr.*` and `search.reindex` are not built (BL-304, BL-306, BL-297, BL-302).

**Back-pressure:** queue depth and age are metrics; alerts when `email.send` age > 5 min, `webhook.deliver` > 15 min, `retention.sweep` lag > 6 h, `audit.chain` lag > 1 min; DLQ visible in `/platform/jobs`.

**Write volume:** at the 200 submits/s target, one fanout job per submission plus per-effect jobs is about 600–1,000 job rows/s. Analytics are batched in process (COPY every 5 s) and `field_focus` is sampled, so analytics do not add per-event writes. Installs above this run pg-boss in the separate queue database.

### 5.3 The effect jobs as built (WP-1.16, WP-1.17, WP-1.18, WP-2.33)

**The chain.** `submission.fanout` is sent once per committed `complete` response (submit, edit, or release of a held one) and carries ids only. Its handler loads the response as the `system` actor in the org's tenant and calls the **consumers** of this process in order, inside its own transaction: `notificationsConsumer`, then `webhooksConsumer` (`createEffectFanout` in `apps/worker/src/jobs/effects.ts`; integrations and workflows add theirs there). A consumer only enqueues, through the fan-out's transaction (the outbox), so a notification that cannot be rendered fails alone and never holds up a webhook; it reads no answer.

```
submission.fanout ─┬ notificationsConsumer ─▶ notification.dispatch ─▶ email.send        (email_messages, disclosures)
                   └ webhooksConsumer ──────▶ webhook.fanout ───────▶ webhook.deliver    (webhook_deliveries, disclosures)
a person: POST /v1/forms/:formId/exports ──▶ export.build                                (exports, disclosures)
```

A response that is not `complete` triggers nothing: held (`pending_payment`, `pending_scan`, `pending_guardian_consent`, `pending_review`), `rejected`, and set aside (`spam`, `archived`, `trashed`) are acknowledged without calling a consumer, so nothing is emailed, posted or exported before release. A released response sends the fan-out again with the event `released`, and its status is `complete` by then. Events map as follows: `created` and `released` are the notification trigger `submitted` and the webhook event `submission.created`; `updated` is `edited` and `submission.updated`. A rejected response has no event (BL-291).

**Who names what.** The parents, `notification.dispatch` and `webhook.fanout`, name the form as their resource, like `submission.fanout`, so `resolve_job_org` needs no case that finds a partitioned row by id; their children name their own row: `email.send` an `email_message`, `webhook.deliver` a `webhook_delivery`, `export.build` an `export` (migration 0023, §2.1). The worker re-derives the org from the resource before it runs, as everywhere (§5.1), and every read afterwards is under RLS, so an id of another org finds nothing and is acknowledged.

**Retries** (`JOB_POLICIES`): `notification.dispatch` 5, 30 s up to 1 h; `email.send` 8, 1 min up to 6 h; `webhook.fanout` and `webhook.deliver` 3, 1 min up to 24 h; `export.build` 2 and a 1 h limit per attempt. Delivery is at-least-once: an email keeps the `Message-ID` made at dispatch (`<email_messages.id@MAIL_MESSAGE_ID_DOMAIN>`) on every try, a webhook keeps its delivery id (a replay carries the id and creation time of the first delivery, so the receiver sees the same event again) and each attempt is signed again with its own time, and a fan-out delivered twice makes one message per response and notification (an advisory lock and a look at the log; the plan's `job_effects` table is not used). A refusal for good (a bad sender secret, a rejected recipient, an address the egress guard refuses, a scope the API never writes) fails the row without a retry; anything else is retried and, on the last attempt, the row is `failed` or `dead` and the job still throws, so the dead-letter queue shows it. Messages written to `last_error`, `response_snippet` and `exports.error` are fixed or scrubbed sentences: the log is read by members, so it never holds a URL, an address, a body, a path or a database message.

**Manual transactions.** The runtime runs an org job in one `withTenant` transaction, which is right for database work and wrong for an SMTP session, a 30 s HTTP request or an upload: the connection would be pinned for the whole call. A job definition may say `transaction: 'manual'`; its handler then gets `ctx.inTenant(fn)` and no `tx`. `inTenant` is the same `withTenant` (org from the resolved resource, actor `system`, the definition's permissions, request id `job:<id>`), so RLS and the audit trail look the same, and a unit whose attempt was interrupted rolls back and no new one starts. The pattern is: read and decide in one short transaction, call out holding none, record the result in another. `email.send` (read and render; SMTP; record), `webhook.deliver` (read, build and sign; request; record, with the failure count and the audit record of an automatic switch-off) and `export.build` (take the row and read the columns; then per batch of 2 000 responses one transaction that reads, builds the cells and writes the `disclosures` rows, with the batch's bytes sent to the store between two transactions; mark ready) are manual; the rest keep the one transaction.

**`EffectDeps`.** `apps/worker/src/main.ts` builds one object for every effect job: the queue, the object store, the mailer, the tenant HTTP request, `OrgSecrets`, the clock and the config. `mailerFor(orgId, senderId?)` returns the platform mailer for a message with no sender, or, for an org's sender, a mailer that reads that org's SMTP URL as a read-only system context of the org (`secret_enc()`) and opens it under the org's key after the transaction has ended, so no connection is held while the KMS answers. `tenantHttp(url, request)` is a POST with a body, a time limit and a cap on the answer read, through the **tenant** egress guard (`createTenantEgressGuard(edition)`, no trusted hosts, because a webhook URL and an org's own SMTP relay are supplied by a tenant); the connection is pinned to the address the guard vetted, no redirect is followed, and the platform mailer, the KMS and the object store use the infrastructure guard. No effect imports an adapter: `main.ts` builds each one and injects a port or a factory (the rule `adapters-only-from-composition-roots`). The worker now also parses `MAILER_DRIVER`, `SMTP_URL` (or `SMTP_URL_FILE`), `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_MESSAGE_ID_DOMAIN` and `PUBLIC_BUILDER_URL` (the "view response" button links to it); production refuses to start with `MAILER_DRIVER=smtp` and no `SMTP_URL`, or without `PUBLIC_BUILDER_URL`. The API reads `STORAGE_*` with the same parser (`parseStorageConfig`) for the export downloads and builds the tenant guard, the org mailer (`createOrgMailer`, which opens only its own org's secret) and `OrgSecrets` in its own `main.ts`.

**What may leave: one filter.** Notifications, webhooks and exports never read a stored answer themselves. `disclosableFields` (`apps/worker/src/effects/disclosure.ts`) is the single place that decides which answers of one response may reach a recipient, and every effect renders only what it returns (DPDP s.8(2), s.11(1)(b); CONTRIBUTING §5, rule 6):

- **Purpose.** A personal or sensitive field goes only to a recipient declared for one of its purposes (`notifications.purpose_ids`, `webhooks.purpose_ids`; every purpose of the form for an export). A field of classification `none` that names no purpose counts as non-personal and always passes, so a form with no privacy configuration still sends its plain answers; one that names a purpose is bound to it. A webhook's `fieldKeys` narrows the result and never widens it.
- **Per field.** The field's own `inNotifications` (webhooks follow it too: they are an outside recipient) or `inExports` is `include`, `mask` or `omit`; `mask` shows `MASK` (`••••••`, no prefix, no length), `omit` leaves the field out, label and value alike. A notification's `sensitiveOverride` can only make this stricter.
- **Taint** (I13). A value derived from a sensitive field is masked whatever its own setting says, and its taint's purposes join the purpose check.
- **Export only.** `includeSensitive` lifts a mask and never an omit.
- **What it cannot read.** A sealed answer (stored encrypted, WP-1.11) and an answer whose type is not the field's are masked even with `includeSensitive`. A repeating group is as strict as its strictest child, shown whole or masked, never in part.

`recordDisclosure` appends the `disclosures` row in the caller's transaction, naming field keys and never values; `disclosedFieldKeys` says which fields' values were really sent (not a masked or blank one). An email is rendered from the list `disclosableFields` returned, so the answers table, a merge tag in the body and one in the subject agree, and a retry hours later renders again through the same filter: an answer marked sensitive since, or a purpose taken away, is not sent by a retry queued before the change (and a field the render would now disclose that the ledger does not yet name gets its row first). Everything is escaped for where it lands: HTML text and attributes, the subject loses CR, LF and every control character, a link or button goes out only with an `http(s)`, `mailto` or `tel` address, and a piped value in a button URL is percent-encoded. The consent-granted check of a consent-based purpose waits for WP-1.21 (Core already drops answers without consent before they are stored).

**Webhook delivery.** The body is `{ id, event, createdAt, form: { id }, submission: { id, submittedAt, answers } }`, answers keyed by field key or block id, in document order, values of their stored type; what the server keeps for itself (the email OTP proof, an appointment hold token, signature evidence) never leaves, a file is its metadata without a URL (BL-307), and a repeating group is sent row by row. The request carries `fORM-Signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 over `<t>.<raw body>` keyed with the `whsec_…` text exactly as the owner was shown it (never decoded), plus the headers `fORM-Event` and `fORM-Delivery-Id`; the recipe a receiver copies is in [webhook-signatures.md](webhook-signatures.md), verbatim from `verify-recipe.ts` and pinned by a test. 2xx is success and resets the failure count; any other status, no answer, a timeout (30 s) or an answer over 64 KB is a failure that retries; a refused address is `dead` at once with no request; the 50th failure in a row switches the webhook off (`webhooks.disabled_reason`, `webhook.disabled` in the audit chain). The delivery log's reason for a refused or unresolvable address is a fixed sentence, because the guard's own message names what the resolver returned and members with `data.route` read the log (the detail goes to the worker's log). The receiver's answer is kept as a scrubbed snippet of at most 1 KB.

**Export build.** Columns are the union over every version of the form: the newest version that has a field decides its header, position and whether it is exported at all, and each response is read under its own version, so an answer to a field the form no longer asks stays readable and a field now marked `omit` or `mask` is not exported in clear for older responses either. Rows are read by keyset on `(received_at, id)`, 2 000 at a time, trashed responses left out. The CSV is RFC 4180 with a UTF-8 byte-order mark (so Excel reads Devanagari and Tamil as such) and CRLF; the XLSX is written by the streaming workbook writer with every cell a string and never a formula, a text cut at Excel's 32 767-character limit and a refusal, with a fixed message, past its row limit. Both writers escape every cell and header against formula injection themselves (an apostrophe before a leading `=`, `+`, `-`, `@`, tab or carriage return, also behind white space and invisible characters), so a caller cannot forget. A requester who is acting as a reviewer with `own_unit` visibility gets only the columns of their own units (`visibleBlocksForReviewer`); settings that do not parse stop the export instead of giving a checker a whole response.

---

## 6. Adapters (ports and implementations)

`packages/ports` holds the interfaces; `packages/adapters/<family>/<impl>` the implementations; the composition root picks them from config; every family has a contract suite in `testkit` run against real containers in CI.

```ts
export interface Storage {
  presignPost(i: { bucket: BucketName; key: string; contentType: string; minBytes: number; maxBytes: number; expiresSec: number; tags?: Record<string,string> }): Promise<{ url: string; fields: Record<string,string> }>;
  presignGet(i: { bucket: BucketName; key: string; expiresSec: number; downloadName?: string }): Promise<string>;
  head(bucket: BucketName, key: string): Promise<{ bytes: number; contentType?: string; etag: string } | null>;
  get(bucket: BucketName, key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream>;
  put(bucket: BucketName, key: string, body: NodeJS.ReadableStream | Buffer, o: { contentType: string; sse?: true; objectLock?: { mode: 'compliance'; retainUntil: Date } }): Promise<void>;
  copy(src: ObjRef, dst: ObjRef): Promise<void>;
  delete(bucket: BucketName, keys: Array<string | { key: string; versionId: string }>): Promise<void>;
  capabilities(): Promise<{ objectLock: boolean; versioning: boolean; sse: boolean }>;
}
export type BucketName = 'staging' | 'uploads' | 'assets' | 'exports' | 'audit' | 'packs';

export interface Mailer { send(m: MailMessage): Promise<{ messageId: string; refused: MailRefusal[] }>; verify(senderSecretRef?: string): Promise<{ ok: boolean; error?: string }> }

export interface KeyProvider {
  wrap(plaintextKey: Uint8Array, ctx: { orgId: string }): Promise<{ wrapped: Uint8Array; kekRef: string }>;
  unwrap(wrapped: Uint8Array, kekRef: string, ctx: { orgId: string }): Promise<Uint8Array>;
  /** Signing keys are app-held and KMS-wrapped by default (Ed25519); 'kms-native' keys use what the KMS supports (ES256 on Azure Key Vault). */
  sign(keyId: string, data: Uint8Array): Promise<{ alg: 'ed25519' | 'es256'; signature: Uint8Array }>;
  publicKey(keyId: string): Promise<{ alg: 'ed25519' | 'es256'; key: Uint8Array }>;
}

export interface Captcha { readonly provider: 'proof_of_work' | 'hcaptcha' | 'turnstile' | 'recaptcha_v3'; publicConfig(): {…}; verify(token: string, ctx: {…}): Promise<{ ok: boolean; score?: number }> }
export interface PaymentGateway { /* createCheckout, verifyWebhook, fetchStatus, refund? (P4) */ }
export interface AVScanner { scan(stream, meta): Promise<{ verdict: 'clean' | 'infected' | 'error'; signature?: string; engineVersion: string }>; health(): Promise<…> }
export interface GuardianVerifier {           // CMP-13 / CMP-22
  readonly method: 'existing_verified_adult_account' | 'manual_document_review' | 'digilocker_token';
  start(i: { orgId: string; submissionId: string; guardianEmail: string }): Promise<{ next: 'email_link' | 'redirect' | 'review_queue'; url?: string }>;
  complete(i: { verificationId: string; payload: unknown }): Promise<{ verified: boolean; evidenceRef: string }>;
}
export interface Queue { send…; work…; schedule… }
export interface GeoIP { country(ip: string): CountryCode | undefined }
export interface CdnPurge { purge(keys: string[]): Promise<void> }
export interface AuditSink { forward(checkpoint: AuditCheckpoint): Promise<void> }   // syslog / OTLP / SIEM fallback when no WORM
export interface EgressGuard { assertAllowed(url: URL): Promise<{ pinnedIp: string }> }
```

The sketch above is abridged; `packages/ports` holds the exact signatures. Where they differ:
- Streams are `ByteStream` (`AsyncIterable<Uint8Array>`) and bytes are `Uint8Array`, so ports need neither Node nor DOM types. Node `Readable` and web `ReadableStream` both qualify.
- `AVScanner` verdicts add `skipped`, which the no-op scanner returns; it never claims `clean`.
- `GuardianVerifier.start` also returns the `verificationId` that `complete` takes, and `complete` takes the `orgId`: another org's verification is `not_found`, as if it did not exist.
- `AuditSink` has a `kind` and `GeoIP` a `databaseVersion`. `EgressGuard.assertAllowed` takes the URL fields it reads (a `URL` satisfies it).
- `Queue` is spelled out: `send(name, JobRequest)` signs the request into a `JobEnvelope`, and `JOBS` gives each queue its scope (`org`, `system` or `any`). `SendOptions.tx` (a `SqlExecutor`; `@form/db` `txExecutor(tx)` adapts a Drizzle transaction) enqueues inside the business transaction, `ReceivedJob.signal` is aborted on shutdown, and `JOB_POLICIES` holds each queue's retry, expiry, exclusivity and concurrency.
- `SearchIndex` is a minimal Postgres-FTS-shaped port.
- Expected failures throw `PortError` with a typed code (`not_found`, `invalid_argument`, `unsupported`, `integrity`, `expired`, `rejected`, …).
- `Mailer.send` returns `{ messageId, refused }`: recipients the server refused while it accepted the message for others, each marked `permanent` (5xx, a hard bounce to suppress) or not (4xx, retry that address). A 5xx to every recipient or to the message itself throws `PortError('rejected')`; outages, sender or auth refusals and 4xx replies throw `unavailable`, so `email.send` retries them. Refusals of recipients or of the message are a `MailDeliveryError` (a `PortError`) with `scope` (`recipients` or `message`) and every refused recipient, so the hard bounces of a send that is retried for a deferred recipient can still be suppressed. `MailMessage.senderSecretRef` picks a per-org SMTP sender.
- `SendOptions.singletonKey` de-duplicates waiting jobs on a queue that coalesces and running jobs on an exclusive queue; on any other queue it is `PortError('unsupported')` rather than a silent no-op (the queue contract found the gap).
- `presignPost` validates `tags` against the S3 tag rules (`isValidObjectTags`) and the store applies them to the upload.
- `CountryCode` and `IsoInstant` are the `@form/schema` brands, re-exported by `@form/ports`; `toIsoInstant(date)` makes one (it stays in ports because the pure schema package never touches `Date`). `@form/config` re-exports `FeatureId` and `INTEGRATION_PROVIDERS` from the schema too.

The storage contract also exercises presigned URLs (size range, content type, key binding, tampering, expiry) when the store supplies a client for them, and the mailer contract checks refusals when the server under test can be told to refuse (the testkit SMTP sink can; a stock Mailpit cannot, so those cases skip there).

**As built (WP-1.03).** Every port family has a contract suite in `@form/testkit` and at least one production implementation that passes it:

| Family (`@form/adapters/<family>`) | Implementations | Contract runs against |
|---|---|---|
| `storage` | S3 API (aws-sdk v3: presigned POST and GET, multipart uploads for streams), filesystem (development) | SeaweedFS with S3 authentication, with and without Object Lock (`test:int`); AWS S3 nightly |
| `mailer` | SMTP (nodemailer): the platform relay and per-org senders | the testkit SMTP sink (refusals), Mailpit (`test:int`) |
| `kms` | AWS KMS, Cloud KMS, Azure Key Vault, Vault transit, keyfile | the in-process AWS, GCP and Azure emulators (`@form/testkit` `start*KmsEmulator`), Vault dev (`test:int`); the real accounts nightly |
| `scan` | ClamAV (clamd INSTREAM), no-op | a fake clamd in every run; the ClamAV image opt-in (below) |
| `captcha` | proof of work (ALTCHA-compatible, Postgres or memory replay store), hCaptcha / Turnstile / reCAPTCHA v3 | a siteverify mock; the Postgres replay store in the worker's `test:int` |
| `geoip` | MMDB (DB-IP Lite) | a fixture MMDB that `buildTestMmdb` writes |
| `guardian` | existing verified adult account, manual document review (store explicit, memory until CMP-13) | in-memory stores |
| `audit-sink` | WORM bucket (compliance-mode Object Lock), syslog over TCP or TLS (RFC 5425), OTLP/HTTP logs | an in-memory locked store, local syslog (TLS with a private CA made at runtime) and OTLP receivers; S3 on SeaweedFS in the worker |
| `egress` | the guard below, pinned HTTP(S) | the egress contract's fixture resolver |
| `queue` | pg-boss (WP-0.14) | the migrated schema as `fr_app` (worker `test:int`): retries then dead letters, forged envelopes, delayed starts, UTC cron |
| `search` | Postgres FTS (`submission_search`) | the migrated schema as `fr_app` (worker `test:int`) |

- **Entry points.** The package has no root export: composition roots import `@form/adapters/<family>`. The dependency-cruiser rule `adapter-families-apart` keeps families independent; a family may use `egress` (every outbound call passes it) and the helpers at the package root, nothing else.
- **Egress (§1.5 `EGRESS_POLICY`).** Two guards per process. The *tenant* guard (`createTenantEgressGuard`) holds org-supplied destinations (webhooks, per-org SMTP, integrations, third-party captcha): `open` reaches public addresses only, `allowlist` only `EGRESS_ALLOWLIST`, `none` only allowlisted hosts that resolve to private addresses. The *infrastructure* guard (`createInfrastructureEgressGuard`) holds what the operator configured (KMS, object store, SMTP relay, SIEM, OTLP collector, clamd): those hosts are trusted endpoints that pass the allowlist and may be private under `open` (a VPC endpoint, the dev stack), but under `none` they still may not resolve to a public address. Link-local addresses (cloud metadata) never pass. Names are resolved once and the connection is pinned to the vetted address (`egressHttp`, `egressLookup` for the SDK agents). One exception: the AWS drivers (S3, AWS KMS) without static keys take credentials from the SDK's default chain, whose STS (web identity) and container or instance metadata requests use the SDK's own HTTP clients and do not pass the guard; an `allowlist` or `none` install on AWS sets static keys until BL-255 closes this. The egress-blocked runs (`packages/adapters/src/egress-blocked.test.ts`, `test/egress-blocked.int.test.ts`) open the on-prem implementations under `EGRESS_POLICY=none` with a process-wide tripwire on sockets and DNS (`installEgressTripwire`) and fail on any connection or lookup outside the internal services.
- **KMS.** A `RootKey` (`encrypt`/`decrypt` with authenticated context) per provider: AWS encryption context, Cloud KMS additional authenticated data, Vault transit `associated_data`; Key Vault's key wrap has no AAD, so it wraps `key ‖ SHA-256(aad)` and checks the suffix (OAEP is non-malleable). `kekRef` is `<provider>:<key ref>`, with the key version where the KMS reports one. Signing is app-held Ed25519 by default: a 32-byte seed sealed by the root key in `KMS_SIGNING_SEED_FILE` (`sealSigningSeed`, `form-admin keys init` when the CLI lands), unwrapped once at boot, keys derived per key id as with the keyfile. `KMS_SIGNING=kms-native` signs ES256 inside the KMS with the keys `KMS_NATIVE_SIGNING_KEYS` maps. Cloud tokens: a GCP service-account key (JWT bearer) and Entra client credentials; Vault: a token file or Kubernetes auth. Metadata-server identities (GKE workload identity, Azure managed identity) are not wired because the guard never reaches link-local addresses (BL-255). `openKeyProvider(config)` builds the provider from `@form/config` `parseKmsConfig`, which the api and the worker share.
- **Storage.** `capabilities()` probes the buckets: `objectLock` is the `audit` bucket's Object Lock, `versioning` the `uploads` bucket's, `sse` whether `STORAGE_SSE` is set. A write asking for what the bucket lacks is `unsupported`. `ensureBuckets()` creates missing buckets (the `audit` one with Object Lock on request) for development and tests.
- **Audit anchoring (§2.7).** The worker anchors a checkpoint in the WORM bucket sink while the bucket has Object Lock, else in the SIEM sink (`AUDIT_SYSLOG_URL` or `AUDIT_OTLP_URL`); in production it refuses to start when neither is possible. Archives stream through zstd into a multipart upload, hashed on the way.
- **ClamAV in CI.** The official image loads its whole signature set on start, so the real-engine contract is opt-in (`FORM_TEST_CLAMAV=1`, or `FORM_TEST_CLAMAV_HOST=host:port` for a running clamd) and runs weekly in `.github/workflows/av-contract.yml`; every run tests the adapter against the fake clamd.
- **Nightly real accounts.** `.github/workflows/cloud-nightly.yml` runs `pnpm --filter @form/adapters test:cloud` (the KMS and storage contracts against AWS KMS, Cloud KMS, Key Vault and an S3 bucket with Object Lock). It is off until the repository variable `FORM_CLOUD_NIGHTLY` is `'true'` and the accounts exist (BL-254).

| Port | SaaS | On-prem (connected) | Air-gapped (`EGRESS_POLICY=none`) |
|---|---|---|---|
| Storage | AWS S3 (SSE-KMS, Object Lock for `audit`) | **Bring-your-own S3-compatible store** (Ceph RGW, NetApp StorageGRID, Dell ECS, cloud S3, or MinIO the customer licenses). Object Lock checked via `capabilities()` | Same, in-cluster. A bundled store is optional and subject to decision D14 (Apache-2.0 SeaweedFS or Ceph RGW after a licence review); **MinIO is not bundled** (AGPL, community distribution changes). Dev and CI use SeaweedFS (Apache-2.0, ADR-0002 §5), which is not bundled either |
| Mailer | SMTP to an India-hosted provider + per-org SMTP | Customer SMTP relay | Customer internal relay; `log` driver for demos. Without SMTP, admins issue one-time codes for invites, resets and DSR identity checks |
| KeyProvider | AWS KMS / GCP KMS / Azure Key Vault | Vault Transit or keyfile | Vault or keyfile (k8s Secret with etcd encryption at rest or an external secrets store required; Shamir escrow) |
| Queue | pg-boss | pg-boss | pg-boss |
| Captcha | **PoW default**; hCaptcha / Turnstile / reCAPTCHA per-form opt-in | PoW; others if egress allowed and opted in | PoW only |
| Payments | Stripe, Razorpay | if gateways are allowlisted | Disabled |
| AVScanner | ClamAV (clamd + freshclam) | ClamAV + private mirror | ClamAV with signatures in each bundle + offline update |
| GuardianVerifier | existing account, manual review, DigiLocker (P2) | existing account, manual review | existing account, manual review |
| GeoIP | DB-IP Lite, weekly | bundled | bundled |
| CdnPurge | Cloudflare / CloudFront | no-op or Varnish/NGINX | no-op |
| AuditSink | WORM bucket | WORM if supported, else syslog/SIEM | same |
| EgressGuard | deny private ranges | allowlist | deny all except configured internal hosts |
| Search | Postgres FTS + pg_trgm | same | same |
| SSO (P3) | BoxyHQ Jackson | Jackson + LDAP | Jackson + LDAP |

---

## 7. Deployment

### 7.1 Images

| Image | Contents | Entrypoints |
|---|---|---|
| `fr-server` (distroless node:24) | api, runtime SSR, worker, cli bundles; template packs; licence public keys; GeoIP; disposable-email list | `server api`, `server runtime`, `server worker`, `server migrate`, `server cli …` |
| `fr-worker-pdf` | `fr-server` + Chromium, Noto fonts, qpdf | `server worker --queues=pdf.*,templates.thumbnail` |
| `fr-builder` (nginx-unprivileged) | Static builder SPA | – |
| Third-party (pinned digests, mirrored in the bundle) | postgres:18 (optional), clamav, otel-collector, (P3) jackson; optional bundled object store per D14 | |

All non-root, read-only root filesystem, `cap_drop: ALL`, with SBOM, cosign signature and third-party notices.

### 7.2 Dev stack (`deploy/docker/compose.dev.yaml`)
Postgres 18, SeaweedFS for the S3 API (dev and CI only; MinIO no longer publishes images, ADR-0002 §5), Mailpit, ClamAV (optional `av` profile), `grafana/otel-lgtm`; images are pinned by version and digest; apps run on the host (`pnpm dev` → builder :5173, runtime client :5174, api :8080 with `RUNTIME_MODE=embedded`, worker). `pnpm dev:setup` runs migrations, creates roles and definer functions, seeds a demo org and the system pack, creates buckets, writes `.env.local` with a keyfile dev key. `pnpm dev:airgap` reruns the stack on an `internal: true` network to catch hidden outbound calls.

### 7.3 Helm chart (`deploy/helm/form`)
- **Workloads:** `server` (api + embedded runtime; `runtime.standalone=true` splits them; HPA; PDB), `worker` (HPA, optional KEDA on queue depth), `worker-pdf`, `clamav` (freshclam sidecar when connected), `builder`.
- **Lifecycle:** `migrate` Job (pre-install/pre-upgrade, advisory lock). Seeding runs in the worker (`templates.seed` singleton).
- **Networking:** Ingress or Gateway API per host; port 8081 never exposed; default-deny NetworkPolicies; egress only to configured SMTP, KMS, gateway and NTP targets.
- **State — default profile: external Postgres and external S3.** CloudNativePG and a bundled object store are optional subcharts (CNPG needs cluster-scoped CRDs and operator rights that many air-gapped customers forbid). `queueDatabase.url` enables the separate pg-boss database.
- **Observability:** ServiceMonitor, OTel wiring, Grafana dashboards as ConfigMaps.

```yaml
deploymentMode: onprem
egressPolicy: allowlist
egressAllowlist: [smtp.corp.local, hooks.corp.local]
ntp: { servers: [ntp.corp.local] }
hosts: { builder: app.forms.corp.local, api: api.forms.corp.local, runtime: forms.corp-user.local, files: files.corp-user.local }
license: { existingSecret: form-license }
database: { existingSecret: form-db, migratorSecret: form-db-migrator, aggSecret: form-db-agg, pool: { max: 20 } }
queueDatabase: { existingSecret: "" }        # optional
storage: { driver: s3, endpoint: https://s3.corp.local, buckets: { staging: fr-staging, uploads: fr-uploads, assets: fr-assets, exports: fr-exports, audit: fr-audit, packs: fr-packs }, existingSecret: form-s3 }
kms: { driver: vault, vault: { address: https://vault.corp.local, transitKey: form-root, authRole: form } }
mailer: { driver: smtp, existingSecret: form-smtp }
av: { driver: clamav, required: async, offlineSignatures: true }
captcha: { default: proof_of_work }
compliance: { statutoryRetentionFloorDays: 365, guardianVerifiers: [existing_account, manual_review] }
auditSink: { syslog: { host: siem.corp.local, port: 6514, tls: true } }
templates: { seedSystemPacks: true, extraPacks: [ { configMap: industry-bfsi-pack } ], trustedKeys: [], showSystemGallery: true }
postgresql: { bundled: false }
objectStore: { bundled: false }
```

### 7.4 Air-gapped bundle (FND-18)
`form-airgap-<version>.tar`: OCI image archives (pinned digests, signatures, SBOMs), charts, signed template packs with attestations, ClamAV signature DBs + `form-admin av update`, GeoIP DB, offline docs, **third-party notices and source offers**, **migration images for every release since the oldest supported one** (multi-hop upgrades, below), `checksums.sha256`, `bundle.sig`.

Install: `form-admin airgap verify` → `form-admin airgap load --registry …` → `helm install … --set global.imageRegistry=…`. CI deploys the bundle into a kind cluster with **deny-all egress** (Cilium) and runs the Playwright smoke suite; any external DNS lookup or connection fails the release.

### 7.5 Migrations
- Drizzle-generated + hand-written SQL in `packages/db/migrations`, applied with locking and checksum verification.
- **Expand/contract only**, so each release works with N−1 and N+1 schemas; indexes `CONCURRENTLY` (squawk-enforced).
- RLS policies, grants, triggers, definer functions and partitions are in migrations; the RLS meta-tests run after migrations in CI.
- Document schema migrations (`FormDefinition` v1→v2) run lazily on read.
- **On-prem upgrades:** any supported version → current in one command. `form-admin upgrade plan` lists the hops; the bundle carries the intermediate migration images, and each hop runs expand/contract migrations and data backfills in order. `form-admin preflight` checks versions, extensions, disk, backups, licence and NTP first.

### 7.6 Backups and DR (CMP-18, SOC 2 A1)
- **Postgres:** WAL archiving + daily base backups (pgBackRest, Barman or the managed service), encrypted with a backup key separate from data keys; **PITR 35 days**; SaaS RPO ≤ 5 min, RTO ≤ 4 h; **DR replica and backups in a second Indian region** (Mumbai ↔ Hyderabad, CMP-16).
- **Object storage:** versioning on `uploads` and `assets` with 35-day noncurrent expiry, replication to the Indian DR region; `audit` with Object Lock where supported; `staging` unversioned (48 h); `exports` 24 h.
- **Keys:** provider-protected KMS keys; keyfile mode needs an offline Shamir 3-of-5 escrow (`form-admin keys escrow`), tested in the restore drill.
- **Restore tests:** quarterly and automated, including `audit.verify` and escrow recovery; evidence recorded. On-prem gets the same job as an optional CronJob.

### 7.7 Observability
- **Logs:** pino JSON; redaction of auth headers, cookies, passwords, answers, emails, phones, tokens and bodies; **URLs without query values**; `orgId`, `requestId`, `traceId` on each line. **Retention 365 days on SaaS, stored in India** (CERT-In requires 180 days of ICT logs in India; the DPDP Rules require one year of processing logs). On-prem: the operator's log stack, with the same minimum documented in the CUEC matrix.
  - *As built (WP-1.12):* a database error is the one error whose text can carry what a respondent typed: Drizzle's `DrizzleQueryError` puts every bound parameter in its message, its stack header and `params`, and node-postgres' `DatabaseError` quotes the offending value in `detail`, `where` and `internalQuery`. The `err` serializer `loggableError` (`packages/db/src/log.ts`) keeps what an operator needs (the type, the SQLSTATE, the constraint, the table, the SQL text with its `$1` placeholders, the stack frames) and drops what quotes data. It is wired into the API and the worker loggers (`createServiceLogger` in `apps/api/src/log.ts` and `apps/worker/src/log.ts`), so no call site has to remember to scrub. `createLogger` and `loggerOptions` in `packages/observability` do not have it yet, so a service that builds its logger there logs a failed query with its parameters (BL-277).
- **Traces:** OTel auto-instrumentation (http, fastify, pg without statement parameters, undici) + manual spans; 10% head sampling, 100% errors and slow requests; collector in-region.
- **Metrics:** HTTP durations; `fr_submit_total{result}`, `fr_submit_duration`, `fr_runtime_ttfb`; queue depth/age; webhook and email outcomes; KMS unwraps; AV verdicts; audit chain lag and verify failures; DB pool waits; NTP offset.
- **SLOs (SaaS):** runtime first byte p95 < 300 ms (cache miss); submit p95 < 800 ms; submit availability 99.95%; notification enqueue-to-send p95 < 2 min; webhook first attempt p95 < 30 s. Burn-rate alerts.
- **Clock sync:** NTP to NIC/NPL servers on SaaS (CERT-In) and to internal NTP on-prem; boot and readiness fail when the offset exceeds 1 s (TOTP, retention deadlines and audit ordering depend on it).
- **On-prem:** the same dashboards ship with the chart; nothing phones home; `form-admin support-bundle` collects redacted logs and config for the customer to send, covered by the support DPA (CMP-21).

---

## 8. Security and compliance controls

The platform is the **Data Processor** for respondent data and the **Data Fiduciary** for its own users' account data (CMP-21). Each customer org is the Data Fiduciary for its forms. On-prem, the customer operates the platform; our controls become product capabilities plus operator duties listed in the **shared-responsibility (CUEC) matrix** (`docs/runbooks/cuec.md`). DPDP references are to the Act (2023) and the Rules (2025), most of which apply from about **13 May 2027**. Counsel must confirm the mapping, especially Rules 6(1)(e), 8(3), 10–12 and 14(3), before the DPA is finalised.

| # | Control | Implementation | SOC 2 | DPDP / other |
|---|---|---|---|---|
| 1 | Tenant isolation | RLS on every tenant table, forced; `fr_app NOBYPASSRLS`; partitions in an ungranted schema; null-safe helpers; meta-tests; per-actor isolation suite; 404 for foreign ids | CC6.1, C1.1 | s.8(5); Rule 6 |
| 2 | Least privilege inside a tenant | Role matrix, restrictive submission policy with respondent subject scoping, `data.route`, per-form shares, Creator without data access | CC6.1, CC6.3 | s.4, s.6, s.8(5) |
| 3 | Strong authentication | argon2id, TOTP, session expiry and revocation, `__Host-` cookies, Fetch-Metadata + header CSRF guard, login throttling; P3 SSO/SCIM/enforced 2FA | CC6.1, CC6.2 | Rule 6 |
| 4 | Privileged and support access | Isolated platform port, operator SSO + WebAuthn, break-glass with reason, ticket, TTL, customer notification and dual audit; on-prem support bundles under a support DPA | CC6.2, CC6.3, CC7.2 | s.8(2) |
| 5 | Encryption in transit | TLS 1.2+, HSTS, mTLS or NetworkPolicies + `sslmode=verify-full` | CC6.7 | Rule 6 |
| 6 | Encryption at rest + field level | SSE everywhere; envelope encryption for sensitive fields and tainted derived values; blind indexes; encrypt-after-scan; secrets encrypted. Erasure completes with backup expiry (≤ 35 d); real crypto-shredding only with per-org root keys (P3) | CC6.1, CC6.7, C1.1 | s.8(5); Rule 6 |
| 7 | Data minimisation | Server strips hidden, skipped and unconsented answers; consent-based fields are not drafted, validated or tracked before consent; IP/UA hashes with TTL sweep; analytics aggregates only; EXIF stripped; Aadhaar last 4 only; sensitive prefill off | P3.1, P4.1 | s.4, s.6(1); Aadhaar Act / UIDAI rules |
| 8 | Notice and consent | Standalone notice with itemised data, purposes, withdrawal, rights and Board-complaint text; unbundled items, never pre-ticked; rendered-notice hash per locale; language picker (English + Hindi in P1, 22 languages by P2 W4); consent records; publish blocks incomplete, bundled, unapproved or misordered notices | P2.1, P3.2 | s.5, s.6; Rule 3 |
| 9 | Consent withdrawal | One-click signed link on the ending and in the autoresponder; record; erasure of consent-only data (subject to the statutory floor); cancellation of scheduled jobs; webhook event; integration deletes (P2); confirmation to the principal | P2.1 | s.6(4), s.6(6), s.8(7)(a) |
| 10 | Legitimate uses | `LawfulBasis` per purpose with s.7 clause and justification; lawful-basis confirmation on template use; per-principal objections stop s7a | P3.1 | s.7 |
| 11 | Retention and erasure | Purpose retention, sectoral `statutory` minimums, `inactivity` erasure with 48 h notice, **statutory floor of one year in a restricted hold store**, sweep every 15 min, trash, legal hold, backup expiry ≤ 35 d, org deletion certificate (method + backup-expiry date); PII coverage matrix enforced by test | C1.2, P4.2, P4.3 | s.8(7); Rules 6(1)(e), 8 |
| 12 | Data principal rights | DSR lookup, export (with the disclosures ledger), correct, erase; intake with due dates ≤ 90 days and overdue alerts (P1); privacy contact in every response; nomination template; notice-language requests | P5.1, P5.2, P8.1 | s.11–14; Rules 9, 14 |
| 13 | Children and guardians | Age gate on the data principal (respondent or subject of the form); VPC by existing verified adult account or manual review (P1) and DigiLocker token (P2); lawful guardians of persons with disability; Fourth Schedule exemption mode; `pending_guardian_consent` hold with no processing; tracking off for the whole form | P3.1 | s.9; Rules 10, 11, 12 |
| 14 | Logging and monitoring | Hash-chained audit incl. denied actions and every submission read; signed checkpoints (WORM or SIEM); 13 months online; logs 365 days in India; NTP sync; CSP reports | CC4.1, CC7.2, CC7.3 | Rule 6; CERT-In Directions 2022 |
| 15 | Breach and incident response | Runbook; `incidents` table; **CERT-In report within 6 h of noticing** (SaaS); **preliminary notice to affected Fiduciaries within 24 h of becoming aware, updates every 24 h**; fiduciary tooling that builds the affected-principal list, sends principal notices with the Rule 7(1) contents through SMTP (works air-gapped) and drafts the Board intimation and the 72-hour report; annual tabletop | CC7.3, CC7.4, CC7.5 | s.8(6); Rule 7; CERT-In |
| 16 | Secure SDLC and change management | CODEOWNERS for `db/`, `crypto/`, `authz/`, `logic/`; CI gates (typecheck, deps, unit, int, RLS, determinism across browsers, e2e, oasdiff, squawk, SBOM, image scan); signed images; immutable versions and template lineage | CC8.1 | s.8(5) |
| 17 | Vulnerability and malware management | Dependency scanning with fix SLAs; annual pentest; bug bounty (SaaS); ClamAV; MIME sniffing; hash-based CSP + Trusted Types; AST-only rich text; SSRF guard; re2js; CSV escaping; zip guards | CC7.1, CC6.8 | Rule 6 |
| 18 | Processing integrity | Same logic and validation client and server, verified across browser engines; server recomputation; engine versioning; idempotent submits; gap-free sequences | PI1.2, PI1.3 | s.8(3) |
| 19 | Availability and recovery | HA Postgres (external or CNPG), stateless pods, PDBs, PITR 35 d, quarterly restore tests, Indian DR region | A1.1–A1.3 | s.8(5) |
| 20 | Third parties and data flows | No third-party requests on respondent pages by default (PoW captcha); every downstream target declared in `Purpose.recipients`; purpose-filtered webhooks, integrations and notifications; disclosures ledger; sub-processor list with regions and prior notice of changes; India region default | CC9.2, P6.1 | s.8(2), s.11(1)(b), s.16 |
| 21 | Records of processing | RoPA export per form and org from compiled inventories, FormOps and disclosures; DPIA/audit evidence pack for Significant Data Fiduciaries (P2) | CC2.2, P8.1 | s.8(1), s.10; Rule 13 |
| 22 | Templates supply chain | Signed packs (per-key algorithm), trust store, unsigned imports as drafts, full validation, PII scan, placeholder recipients, analytics IDs stripped | CC8.1, CC9.2 | s.8(5) |
| 23 | Licence and edition safety | Offline licence; expiry never stops collection or export | A1.2 | Fiduciary continuity |
| 24 | Platform as Fiduciary | Builder-user notice at sign-up, account export and deletion, privacy contact, DPA clause for anonymised cross-tenant statistics (≥ 5 distinct orgs) | P1.1, P5.1 | s.5, s.8(9), s.11–13 |
| 25 | Personnel and governance (SaaS) | Background checks, training, quarterly access reviews, vendor reviews, policies | CC1–CC5 | Processor DPA obligations |

**Evidence collection** (for the SOC 2 Type I audit after P1): CI artefacts, access-review reports, restore-test results, audit-verify results, change logs, vulnerability SLA reports, backup and encryption configuration snapshots, tabletop records, CERT-In drill records.

**Statements we do not make:** that drawn signatures are IT Act s.3A electronic signatures (they are not; WFL-08 covers recognised signing), that erasure is instant (it completes with backup expiry), or that "sensitive" is a DPDP category (it is our protection tier).

---

## 9. Phase map

| Phase | Architecture deliverables |
|---|---|
| **P0** | Monorepo and tooling (§1); `schema` v2 + `migrate`; `registry`; `logic@2` with cross-browser determinism; `validation` with re2js; `renderer` extraction; `templates-core` + `templates` (WP-T0.1–0.3); `db` with roles, null-safe helpers, first tables, definer functions (`list_user_orgs`, `membership_for`, `orgs_due_for`, `create_partitions`, `resolve_job_org`), the `parts` schema and RLS meta-tests; api skeleton; worker skeleton with the signed job envelope; port interfaces and contract suites; dev stack; CI gates |
| **P1** | Auth (in-house) and platform-as-fiduciary; orgs and roles incl. `data.route`; drafts with CAS; publish with notice approval; React SSR runtime on a separate SaaS domain with hash CSP; embeds; submit path (§2.5) with partitions, encryption, taint, consents, disclosures; uploads via staging; notifications, webhooks with purpose gating; spam (PoW default); analytics v1; exports and Chromium PDFs; retention, statutory hold, legal hold, DSR v1 + intake; consent withdrawal; children's data (manual/existing-account VPC); audit chain with pending queue; adapters; licence and editions; Helm, external-DB profile, multi-hop air-gapped bundle; SaaS infrastructure in India with DR; CERT-In and breach tooling; templates WP-T1.1–1.7; SaaS billing |
| **P2** | Public API, keys, SDK; integrations with withdrawal deletes; payments; appointments (slot table); save and resume; respondent edit; workflows; teams and full roles; saved views, comments, SSE; DocumentOp draft saves; custom PDFs; reports; Cards layout; 22 consent languages by W4; CMP-08/17/22; SDF evidence pack; template catalogue, themes, brand kit, section snippets, review, versions and fork updates, legal-text updates, bundles, analytics (WP-T2.1–2.11) |
| **P3 (reserved seams)** | Jackson SSO, SCIM, LDAP; `apps/admin`; activity-log UI and SIEM streaming; custom domains; BYOK / per-org root keys (real crypto-shredding); E2E-encrypted forms; locks; multiple brand kits; mandatory template updates; residency regions; Aadhaar Data Vault adapter (P4) |

---

## 10. Decisions this document takes (ADRs)

Each decision is written up in [`docs/adr/`](../adr/) as `00NN-<slug>.md`. ADR-0020 to ADR-0022 record decisions the schema spec and the Phase 0 work packages took (rich text, the logic engine, the field registry).

1. **ADR-0001:** Monorepo layout and names (`@form/*`, `packages/registry`, `ports` + `adapters`, source-only internal packages, dependency-cruiser).
2. **ADR-0002:** Phase 0 batch-2 decisions: strict zod twins, `answerScalar` as the scalar contract, signed formpack file hashes, `capability:*` feature ids, SeaweedFS for dev/CI S3, i18n test and formatting rules, builder clipboard ([`docs/adr/0002-phase0-batch2-decisions.md`](../adr/0002-phase0-batch2-decisions.md)).
3. **ADR-0003:** Runtime HTML cacheable by path only; per-visitor state from `POST /session`; version JSON immutable; hash-based CSP.
4. **ADR-0004:** Submissions range-partitioned monthly in an ungranted `parts` schema, bound to the uuidv7 id; no default data partition; idempotency in a side table; counters updated last.
5. **ADR-0005:** KMS root → org KEK → purpose DEKs; erasure = deletion + backup expiry ≤ 35 d; crypto-shredding only with per-org root keys (P3).
6. **ADR-0006:** Audit via `audit_pending` in the business transaction, denied events on a separate connection, a per-org chain worker, signed checkpoints to WORM or SIEM.
7. **ADR-0007:** pg-boss as the transactional outbox with one fanout job per event; idempotent handlers; at-least-once email.
8. **ADR-0008:** CSRF via Fetch-Metadata + custom header, no tokens.
9. **ADR-0009:** Chromium renders PDFs (correct Indic shaping) in an isolated image with no network; no pdf-lib text path.
10. **ADR-0010:** On-prem licence expiry blocks authoring, never collection or export.
11. **ADR-0011:** Proof-of-work captcha is the default in every edition and the only air-gapped provider.
12. **ADR-0012:** Template packs are signed `.formpack` files baked into the image and seeded by a dedicated DB role.
13. **ADR-0013:** SaaS runtime and user files on a separate registrable domain.
14. **ADR-0014:** Statutory retention floor via a restricted hold store with its own DEK.
15. **ADR-0015:** Cross-org work only through named `SECURITY DEFINER` functions and the `fr_system_agg` role.
16. **ADR-0016:** Signed job envelope with org re-derivation.
17. **ADR-0017:** In-house authentication on our own tables (no third-party auth framework), for air-gapped operation, no telemetry and a clean Jackson seam in P3.
18. **ADR-0018:** Storage is bring-your-own S3 on-prem; no AGPL object store in the bundle.
19. **ADR-0019:** One `fr-server` image with several entrypoints; runtime SSR embeddable in the API process (planned as ADR-0002, renumbered when ADR-0002 recorded the batch-2 decisions).
20. **ADR-0020:** Rich text is a constrained TipTap-compatible AST, never HTML; HTML is parsed only by the `@form/schema` allowlist reader, and nothing reads or writes `innerHTML`.
21. **ADR-0021:** The `logic@2` engine: a compiled, acyclic plan evaluated in one pass, total and deterministic across Node, Chromium, Firefox and WebKit, versioned by engine id.
22. **ADR-0022:** The field registry (`@form/registry`) is the single source of type knowledge: one `FieldDefinition` per `BlockType`, `answerScalar` as the scalar contract, stubs for unavailable types.

**Open questions for review** (also in the README and the delivery plan §9): breach SLA (24 h preliminary from awareness, or stricter); consent-record retention after erasure (purpose retention + 1 year, pseudonymised); per-org KMS keys before P3 for high tiers; Postgres floor 16 for external databases; SaaS user-content domain name; bundled on-prem object store (none vs SeaweedFS / Ceph RGW).
