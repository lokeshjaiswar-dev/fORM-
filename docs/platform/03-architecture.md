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
| `validation` | `validateAnswers(version, answers, evalState, {scope})` → `FieldError[]`; regex through `re2js` on both sides | Network checks (uniqueness, OTP, slot capacity): the API appends those |
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
L2  renderer → L1,L0,i18n,ui ; ui → (react only) ; sdk → schema
L2s ports → schema ; crypto → schema ; config → ports,crypto,schema ; observability ; db → schema,crypto,config ; adapters → ports,crypto,config ; email → renderer(email mode),schema
L3  apps/builder → renderer,ui,sdk(client),templates-core,L1,L0
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
| Integration | Vitest + **Testcontainers**: Postgres 18, SeaweedFS for the S3 API (dev/CI only, ADR-0002 §5), Mailpit, ClamAV, Vault dev | RLS suite, migration tests, adapter contract tests |
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
DATABASE_POOL_MAX=20
STORAGE_DRIVER=s3  STORAGE_ENDPOINT=  STORAGE_BUCKET_STAGING=  STORAGE_BUCKET_UPLOADS=  STORAGE_BUCKET_ASSETS=  STORAGE_BUCKET_EXPORTS=  STORAGE_BUCKET_AUDIT=
MAILER_DRIVER=smtp|log  SMTP_URL_FILE=
KMS_DRIVER=aws|gcp|azure|vault|keyfile  KMS_KEY_ID=  KMS_KEYFILE_PATH=/run/secrets/form-master.key
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
| `auth_user_by_email(email_norm)`, `auth_session(token_hash)` | Login and session lookup | `fr_app` |
| `api_key_lookup(prefix)` | API key auth | `fr_app` |
| `invite_by_token(token_hash)` | Invite acceptance | `fr_app` |
| `list_user_orgs(user_id)`, `membership_for(user_id, org_id)` | `GET /v1/orgs`, `X-FR-Org` validation | `fr_app` |
| `orgs_due_for(job text)` → `setof uuid` | Org-spanning jobs list the orgs with work due; the job then runs one `withTenant` per org | `fr_app` (worker connection only) |
| `resolve_job_org(resource_type, resource_id)` → `org_id` | Job handlers re-derive the org from the resource and abort on mismatch (§5.1) | `fr_app` |
| `create_partitions(parent regclass, months int)` | Creates partitions in schema `parts`, enables and forces RLS on each, grants nothing to `fr_app` | `fr_app` (worker) |
| `consent_pseudonymise(submission_id)` | On erasure: nulls `submission_id` on `consent_records`, keeps `principal_bidx` as proof of consent (s.6(10)) | `fr_app` (worker) |
| `org_purge(org_id)` | Org deletion (CMP-17), including `form_versions` | `fr_app` (worker, `org.delete` only) |
| `statutory_hold_move(submission_id)` / `statutory_hold_purge()` | Moves expired or erased data into the hold store (CMP-23) and purges at the floor date | `fr_app` (worker) |
| `template_for_binding(binding_id)` | Reads a soft-deleted template for diffs and lineage | `fr_app` |

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
  or 'submissions.read' = any ((select app_perms())) );
create policy submissions_respondent_insert on submissions for insert to fr_app
  with check (org_id = (select app_org()));
```
A respondent context can read only the submissions whose ids were placed in `app.subject_ids` **after** a signed token (edit, receipt, resume, withdrawal) was verified; by default it can only INSERT. A bug in a `/f/*` or `/s/*` route therefore cannot expose the tenant (C-M8, F-22). The same pattern applies to `partial_submissions`, `consent_records` and `submission_files`.

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
  mfaLevel: text('mfa_level').notNull(),          // pwd | pwd+totp | oauth | sso
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

#### Submissions (P1): partitioned, encrypted, searchable

```sql
create table submissions (
  id uuid not null, received_at timestamptz not null,           -- received_at = uuid_v7_ts(id) (CHECK)
  org_id uuid not null, form_id uuid not null, form_version_id uuid not null,
  definition_hash bytea not null, answer_codec_version smallint not null,
  seq bigint not null,
  status text not null,     -- complete | pending_payment | payment_failed | pending_scan | pending_guardian_consent | spam | archived | trashed
  answers jsonb not null,   -- StoredAnswer per block (EncryptedAnswer for encrypt fields)
  computed jsonb not null,  -- variables (tainted ones encrypted), path, endingId, firedRuleIds
  meta jsonb not null,      -- locale, source, durations, ipHash, uaHash (TTL), device, country, utm, spamScore, opsRev, originalSubmittedAt (imports)
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
| `submission_search` | `(submission_id, received_at) pk, org_id, form_id, doc tsvector`, partitioned like submissions | Non-sensitive, non-tainted answers only, `simple` + unaccent. **`btree_gin` index on `(form_id, doc)`** per partition, so a search never scans other tenants' documents |
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
  - The `audit.chain` worker (one consumer per org key, singleton) moves pending rows into `audit_log` within seconds: locks the head, computes `hash = sha256(prev_hash ‖ JCS(event ∪ {seq, occurred_at}))`, inserts, advances the head. A `BEFORE INSERT` trigger rejects rows whose `prev_hash`/`seq` do not continue the head. Business transactions never hold the head lock, so audited actions in one org do not serialise (F-21).
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

### 2.8 Templates

The templates spec §5 is authoritative for template tables and RLS; the corrections raised in review (no `coalesce()` in keys, deferred FKs for both cycles, `'cards'`, publisher-scoped slugs, terminal `rejected`, null-safe policies, policies on localizations and category links, `template_for_binding()`, `fr_system_agg` for cross-tenant stats with ≥ 5 distinct orgs) have been applied **in the spec itself**. Gallery indexes:
- `templates (coalesce(org_id,…), kind, lifecycle, featured desc, sort_weight desc)`; GIN on `industries` and `tags`;
- `template_localizations` GIN `search` and GIN trigram `title`;
- `form_template_bindings (org_id, template_id, template_version_id)` for "forms behind on updates".

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
2. `authenticate`: session (`__Host-fr_sess`, Secure, HttpOnly, SameSite=Lax, via `auth_session()`), or API key. **CSRF (ADR-0008):** unsafe methods with cookie auth need `Sec-Fetch-Site: same-origin` (the builder and API are configured same-site, the runtime is not) **and** the header `X-FR-Client: builder`; CORS denies the preflight from any other origin. No CSRF tokens. Active org from `X-FR-Org`, validated with `membership_for()`.
3. `rateLimit` (§3.5).
4. `authorize`: permission, form-level grants, `data.route` for routing endpoints, API key scope.
5. Handler inside `withTenant(ctx)`; one transaction per request; GETs read-only unless they write an audit row.
6. `idempotency` for flagged POSTs (§3.4).
7. Errors are RFC 9457 problem+json with a closed code enum: `DRAFT_REV_CONFLICT`, `LOCK_VIOLATION`, `TEMPLATE_*`, `VALIDATION_FAILED`, `PLAN_LIMIT_REACHED`, `FEATURE_UNAVAILABLE`, `NOTICE_NOT_APPROVED`, `DATA_ROUTE_FORBIDDEN`, `RATE_LIMITED`, `NOT_FOUND` (also for other tenants' ids, never 403). Denied requests are audited (§2.7).

### 3.3 Route map

**Auth and account** (P1; WSP-01, WSP-08, CMP-21) — in-house auth on the tables above (ADR-0017), `openid-client` for OAuth, `@node-rs/argon2`:

| Method and path | Notes |
|---|---|
| `POST /v1/auth/signup` · `login` · `logout` | Sign-up shows the platform's own privacy notice (CMP-21). Login returns `mfa_required` with a 5-min ticket when TOTP is on; constant-time, generic errors |
| `POST /v1/auth/magic-link` · `…/verify` | 15-min single-use |
| `GET /v1/auth/oauth/:provider/start` · `…/callback` | Google, Microsoft; PKCE + state + nonce; hidden when `EGRESS_POLICY=none` |
| `POST /v1/auth/password/forgot` · `…/reset` | Local top-100k password list everywhere; HIBP k-anonymity SaaS only |
| `POST /v1/auth/mfa/totp/setup` · `/verify` · `/disable` · `POST /v1/auth/mfa/recovery` | |
| `GET/PATCH /v1/me` · `GET/DELETE /v1/me/sessions[/:id]` · `POST /v1/me/export` · `POST /v1/me/delete` | Account self-service export and deletion (CMP-21) |
| (P3) `GET /v1/auth/sso/:connection/start` | BoxyHQ Jackson; LDAP behind the same seam |

**Org, members and workspace**

| Method and path | Notes |
|---|---|
| `GET /v1/orgs` (via `list_user_orgs`) · `POST /v1/orgs` · `GET/PATCH /v1/org` | |
| `GET /v1/org/members` · `POST /v1/org/invites` · `POST /v1/invites/:token/accept` · `PATCH/DELETE /v1/org/members/:userId` | Seat and licence checks |
| `GET/PUT /v1/org/profile` · `GET/PUT /v1/org/settings/templates` · `GET/PUT /v1/org/security-contacts` | TPL-06, CMP-14 |
| `GET/POST/PATCH/DELETE /v1/teams[/:id]` · `…/members` (P2) · `/v1/folders[/:id]` | |
| `GET /v1/meta/features` · `GET /v1/meta/registry` · `GET /v1/usage` | |
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

**Form operations**

| Method and path | Notes |
|---|---|
| `GET/PUT /v1/forms/:id/access` · `PUT/DELETE …/access/password` · `GET/PUT …/slug` | |
| `/v1/forms/:id/notifications[/:nid]` (+ `/test`) | External recipients need `data.route`; `purposeIds` required |
| `/v1/forms/:id/webhooks[/:wid]` (+ `rotate-secret`, `deliveries`, `replay`) | `data.route`; `purposeIds` required and must appear in the purposes' `recipients` |
| `/v1/connections…` · `/v1/forms/:id/integrations[/:iid]` (+ `runs`) | P2; `data.route` |
| `/v1/forms/:id/pdf-templates[/:pid]` (+ `preview`) | |
| `GET/PUT /v1/forms/:id/retention` | Can only shorten |
| `/v1/forms/:id/coupons` · `/stock` · `/payments` | P2 |
| `/v1/senders[/:id]` (+ `test`) | NOT-01 |

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
| `POST /v1/forms/:id/exports` → `GET /v1/exports/:jobId` | `includeSensitive` needs a reason; audited; disclosure rows |
| `/v1/forms/:id/views` (P2) · `GET …/submissions/stream` (SSE, P2) | |
| `GET/POST /v1/guardian-verifications` · `POST …/:id/decide` | CMP-13 manual review queue |

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

**Platform** (port 8081): health, licence, orgs, suspend, plan overrides, `POST /platform/break-glass` (`{ orgId, reason, ticket, ttlMinutes ≤ 60 }`, notifies the org's security contacts, dual audit), jobs and DLQ, audit verify, template packs, `POST /platform/incidents` (CERT-In report drafts).

### 3.4 Idempotency
- `Idempotency-Key` is **required** on `POST /f/:slug/submissions`, `POST /v1/templates/:id/use`, `POST /v1/forms`, `POST /v1/forms/:id/publish`, every public-API create, and exports.
- `idempotency_keys (org_id, scope, key)` with a SHA-256 of the canonical body: same key, different body → `422 IDEMPOTENCY_KEY_REUSED`; in flight → `409 IN_PROGRESS`; completed → stored response with `Idempotent-Replayed: true`. TTL 24 h.
- Runtime submits use `submission_idempotency` (org- and form-scoped, RLS, encrypted response).

### 3.5 Rate limits

`@fastify/rate-limit` with a Postgres store (UNLOGGED fixed window, `INSERT … ON CONFLICT DO UPDATE … RETURNING`) behind an in-process token bucket.

| Bucket | Key | Limit |
|---|---|---|
| `auth_login` | ipHash + emailNorm | 10 / 15 min, then captcha (PoW), then growing backoff |
| `auth_any` | ipHash | 60 / min |
| `builder_read` / `builder_write` | userId | 600 / min · 120 / min |
| `api_read` / `api_write` | apiKeyId | per plan; `RateLimit-*` headers |
| `runtime_session` | ipHash + form | 300 / min (CGNAT-friendly) |
| `runtime_submit` | **visit token** + form; ipHash + form as a signal | 10 / min per visit token. Per IP: **60 / min raises the spam score and triggers on-suspicion captcha; it does not reject** (schools, offices and mobile CGNAT share IPs). Per form: 500 / s guard |
| `runtime_upload` | visit token + form | 60 / 10 min, plus bytes per hour |
| `runtime_unlock` | **ipHash + visit token** + form | 5 / 15 min per visit token, exponential lockout per visit token; a high per-IP rate only adds captcha |
| `otp_send` | email bidx + form | 3 / 15 min, 10 / day |
| `exports` | org | 10 concurrent, 100 / day |

The rate-limit IP hash is `HMAC(daily_salt, ip)` (CMP-11). Uniqueness (ACC-07) uses the per-form salt instead.

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
- **Builder:** `script-src 'self'`, `style-src 'self'`, Trusted Types enforced, `frame-ancestors 'none'`. **API:** `default-src 'none'; frame-ancestors 'none'`. Runtime and builder send `Referrer-Policy: no-referrer` and `strict-origin-when-cross-origin` respectively.

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
- **Payloads carry ids only.** Where a job must carry a secret (magic link, OTP code, invite token for `email.send`), that field is encrypted with the secrets DEK, and auth queues have a 1-day archive retention.
- **Org-spanning jobs** (`retention.sweep`, `drafts.expire`, `analytics.rollup`, `audit.checkpoint`, `payment.reconcile`, `billing.meter`, `kms.rotate`, `dsr.overdue`) call `orgs_due_for(job)` and process one `withTenant` per org. Cross-tenant aggregates (`templates.stats`) use the `fr_system_agg` role only. `partitions.maintain` calls `create_partitions()` (F-1).
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

**Back-pressure:** queue depth and age are metrics; alerts when `email.send` age > 5 min, `webhook.deliver` > 15 min, `retention.sweep` lag > 6 h, `audit.chain` lag > 1 min; DLQ visible in `/platform/jobs`.

**Write volume:** at the 200 submits/s target, one fanout job per submission plus per-effect jobs is about 600–1,000 job rows/s. Analytics are batched in process (COPY every 5 s) and `field_focus` is sampled, so analytics do not add per-event writes. Installs above this run pg-boss in the separate queue database.

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
- `GuardianVerifier.start` also returns the `verificationId` that `complete` takes.
- `AuditSink` has a `kind` and `GeoIP` a `databaseVersion`. `EgressGuard.assertAllowed` takes the URL fields it reads (a `URL` satisfies it).
- `Queue` is spelled out: `send(name, JobRequest)` signs the request into a `JobEnvelope`, and `JOBS` gives each queue its scope (`org`, `system` or `any`).
- `SearchIndex` is a minimal Postgres-FTS-shaped port.
- Expected failures throw `PortError` with a typed code (`not_found`, `invalid_argument`, `unsupported`, `integrity`, `expired`, `rejected`, …).
- `Mailer.send` returns `{ messageId, refused }`: recipients the server refused while it accepted the message for others, each marked `permanent` (5xx, a hard bounce to suppress) or not (4xx, retry that address). A 5xx to every recipient or to the message itself throws `PortError('rejected')`; outages, sender or auth refusals and 4xx replies throw `unavailable`, so `email.send` retries them.
- `presignPost` validates `tags` against the S3 tag rules (`isValidObjectTags`) and the store applies them to the upload.
- `CountryCode` and `IsoInstant` are the `@form/schema` brands, re-exported by `@form/ports`; `toIsoInstant(date)` makes one (it stays in ports because the pure schema package never touches `Date`). `@form/config` re-exports `FeatureId` and `INTEGRATION_PROVIDERS` from the schema too.

The storage contract also exercises presigned URLs (size range, content type, key binding, tampering, expiry) when the store supplies a client for them, and the mailer contract checks refusals when the server under test can be told to refuse (the testkit SMTP sink can; a stock Mailpit cannot, so those cases skip there).

Contract suites exist so far for the families with dev implementations (storage, mailer, KMS, scanner, guardian verifier). Captcha, GeoIP, egress, queue, audit-sink and search get theirs in WP-1.03, with their first production implementations (delivery plan, WP-1.03; ADR-0002 §4). Adapters export only the package root for now; per-family subpath exports arrive with WP-1.03 together with the matching dependency-cruiser rule.

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

1. **ADR-0001:** Monorepo layout and names (`@form/*`, `packages/registry`, `ports` + `adapters`, source-only internal packages, dependency-cruiser).
2. **ADR-0002** (written): Phase 0 batch-2 decisions: strict zod twins, `answerScalar` as the scalar contract, signed formpack file hashes, `capability:*` feature ids, SeaweedFS for dev/CI S3, i18n test and formatting rules, builder clipboard ([`docs/adr/0002-phase0-batch2-decisions.md`](../adr/0002-phase0-batch2-decisions.md)).
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

**Open questions for review** (also in the README and the delivery plan §9): breach SLA (24 h preliminary from awareness, or stricter); consent-record retention after erasure (purpose retention + 1 year, pseudonymised); per-org KMS keys before P3 for high tiers; Postgres floor 16 for external databases; SaaS user-content domain name; bundled on-prem object store (none vs SeaweedFS / Ceph RGW).
