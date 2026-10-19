# fORM-

A form platform for multi-tenant SaaS and on-prem deployments, working toward feature parity with JotForm, with SOC 2 and India DPDP compliance built in. The plan, schema, architecture and delivery roadmap are in [`docs/platform/`](docs/platform/README.md).

> **Status:** Phase 0 (foundation) work packages are all merged on `dev`; see [Phase 0 exit gate](docs/platform/phase0-exit-gate.md) for what is still open. The builder edits v2 form definitions on the field registry, previews them with `@form/renderer`, keeps drafts in IndexedDB and creates forms from the signed system template pack. The API and worker are skeletons over Postgres with row-level security; the public runtime and server-side submissions arrive in Phase 1.

## Workspace

| Path | Package | What it is |
|---|---|---|
| `apps/builder` | `@form/builder` | Vite + React form builder |
| `apps/worker` | `@form/worker` | pg-boss worker skeleton: handler registry, signed job envelopes verified and the org re-derived with `resolve_job_org`, per-job tenant context, cron in UTC, graceful `SIGTERM`; jobs `system.heartbeat`, `partitions.maintain`, `templates.seed` (stub) |
| `apps/api` | `@form/api` | Fastify 5 API skeleton: `buildApp(config)`, zod type provider, problem+json errors, `/livez` and `/readyz`, OpenAPI, `GET /v1/forms` behind RLS, dev header auth stub |
| `packages/db` | `@form/db` | Drizzle tables, SQL migrations, roles (`fr_migrator`, `fr_app`, `fr_template_seeder`, `fr_system_agg`), null-safe RLS helpers, `withTenant()`, definer functions, RLS meta-checks |
| `packages/observability` | `@form/observability` | pino logger with redaction, URL and query scrubbing, NTP clock check, OpenTelemetry (OTLP only when configured) |
| `packages/i18n` | `@form/i18n` | ICU messages (`createI18n`), en-IN catalogues, en-XA pseudo-locale, lakh/crore number, money and `DD-MM-YYYY` date formatting, pinned grapheme segmenter |
| `packages/schema` | `@form/schema` | Form schema v2 types, strict zod twins, v1 reader, structural validation, JCS hashing, rich-text AST tools (`fromHtml` allowlist, `normalize`, `toPlain`) |
| `packages/registry` | `@form/registry` | Field registry (`REGISTRY: FieldRegistry`): config and answer schemas, operators, paths, compliance defaults, export columns and lint for every block type; `answerScalar` |
| `packages/logic` | `@form/logic` | The `logic@2` engine: `compile()` (plan, cycles, page order, taint), `evaluate()` (full and incremental), `validateDefinition`, `projectForRuntime`; deterministic across Node, Chromium, Firefox and WebKit |
| `packages/templates-core` | `@form/templates-core` | The template engine: `instantiate()` (deterministic `uuidv5` ids, remapped references, origin stamps, baked variables, optional parts, refs and bindings), `insertSnippet()`, `lockFingerprint()`, the save-as-template sanitiser with its PII scan; byte-identical across Node, Chromium, Firefox and WebKit |
| `packages/templates` | `@form/templates` | System templates authored as v2 data (`src/system/core`: contact, feedback, NPS, job application, event registration), `templates:build` (registry, logic and instance validation, then `dist/system-core-<version>.formpack` signed with the Ed25519 development key, or the key in `FORM_PACK_SIGNING_KEY`), and `readFormpack` (zip guards, signature with a trusted key of the named algorithm, every file's sha256) |
| `packages/validation` | `@form/validation` | Answer validation per page and on the visible set (`validateAnswers` over a logic `EvalState`), I9 `normalizeAnswers`, `FieldError` codes and en-IN messages, author regexes, presets and masks through re2js; same verdicts in Node, Chromium, Firefox and WebKit |
| `packages/renderer` | `@form/renderer` | Store-independent `FormRenderer` for runtime versions: logic@2 evaluated incrementally, page-scoped validation, one control per available type, status and ending screens, theme tokens as CSS variables, SSR and hydration; `RichTextView` (rich-text AST → React elements) |
| `packages/tsconfig` | `@form/tsconfig` | Shared TypeScript bases (`base.json`, `strict.json`) |
| `packages/ports` | `@form/ports` | Adapter interfaces (storage, mailer, KMS, search, captcha, AV scan, GeoIP, guardian, audit sink, egress, queue) and the `JobData` map; depends only on `@form/schema` (its brands) |
| `packages/adapters` | `@form/adapters` | Dev implementations: filesystem storage, SMTP mailer (Mailpit), local-keyfile KMS, no-op scanner, manual guardian review; the pg-boss queue (HMAC-signed envelopes, `installQueueSchema`) |
| `packages/config` | `@form/config` | Edition config schema (`DEPLOYMENT_MODE`, `EGRESS_POLICY`) and feature availability |
| `packages/testkit` | `@form/testkit` | Adapter contract suites (`runStorageContract`, …), the Postgres Testcontainers harness and test helpers; imported by tests only |

More apps and packages (`runtime`, `worker-pdf`, `cli`, `admin`, …) arrive in Phase 1 and later. The full layout is fixed in [ADR-0001](docs/adr/0001-monorepo.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 | Pinned in `.nvmrc`. With nvm or fnm: `nvm use` / `fnm use` |
| pnpm | 10 (exact version in `package.json` → `packageManager`) | Installed through Corepack, which ships with Node |
| Git | any recent | On Windows, run `git config core.longpaths true` once |

Do not use `npm install` or `yarn`: the workspace uses pnpm catalogs (`catalog:`), which only pnpm understands. The root `package-lock.json` is stale and kept for reference only.

## Run it locally

1. **Clone and enter the repo**
   ```sh
   git clone git@github.com:lokeshjaiswar-dev/fORM-.git
   cd fORM-
   git checkout dev
   ```

2. **Select Node 24 and enable pnpm**
   ```sh
   nvm use            # or: fnm use
   corepack enable pnpm
   pnpm -v            # should print the version from packageManager
   ```
   On Windows, if `corepack enable` fails with a permissions error, open the terminal as Administrator once, or use `corepack pnpm <command>` in place of `pnpm`.

3. **Install dependencies**
   ```sh
   pnpm install
   ```

4. **Start the builder**
   ```sh
   pnpm dev
   ```
   Open http://localhost:5173. It redirects to `/forms`, the forms saved in this browser (IndexedDB). **New form** opens `/builder/<id>`; type `/` on the canvas (or use the field picker) to add fields, then switch to **Preview** (`/builder/<id>/preview`) to fill in and submit the form. Edits save automatically. **Import v1 JSON** reads a v1 form export as a new form and lists what the reader repaired and what the v2 preview changes.

5. **API and database (optional; needs Docker)**
   ```sh
   docker compose -f deploy/docker/compose.dev.yaml up -d   # Postgres 18, S3 (SeaweedFS), Mailpit, Grafana LGTM
   pnpm dev:setup     # roles, migrations, demo org, pg-boss schema; writes apps/api/.env.local and apps/worker/.env.local
   pnpm dev:api       # tsx watch on http://127.0.0.1:8080
   pnpm dev:worker    # tsx watch; works the queues and runs cron (heartbeat, partition maintenance)
   curl -H 'X-FR-Dev-User: 01970000-0000-7000-8000-000000000002' \
        -H 'X-FR-Org: 01970000-0000-7000-8000-000000000001' http://127.0.0.1:8080/v1/forms
   ```
   Add `--profile av` to the compose command for ClamAV. If port 5432 is taken, set `FR_PG_PORT` for compose and `DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:<port>/form` for `pnpm dev:setup`. Until sign-in lands (WP-1.01), the API identifies callers by the `X-FR-Dev-User` header, and only when `AUTH_DEV_HEADERS=true` (refused with `NODE_ENV=production`). The OpenAPI document is at `/v1/openapi.json` and in `apps/api/dist/openapi.json` after a build. Tracing turns on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the compose collector listens on `http://127.0.0.1:4318`).

6. **Production build (optional)**
   ```sh
   pnpm build
   pnpm --filter @form/builder preview    # serves apps/builder/dist on http://localhost:4173
   ```

## Tests and checks

Run these from the repository root before pushing. CI (`.github/workflows/ci.yml`) runs the same commands.

| Command | What it does |
|---|---|
| `pnpm lint` | Lint with oxlint |
| `pnpm typecheck` | Type-check every project |
| `pnpm test` | Unit, component and type tests (Vitest) with coverage in `apps/*/coverage` and `packages/*/coverage` |
| `pnpm test:int` | Integration tests against Postgres 18 in Testcontainers: migrations, RLS isolation for every actor kind, RLS meta-tests, definer functions, the API, the worker (outbox enqueue, forged jobs, SIGTERM retries, partitions) (CI job `db`). Needs Docker |
| `pnpm build` | Build every app and package (the template pack first: the builder bundles it) |
| `pnpm templates:build` | Validate the system templates and write the signed `packages/templates/dist/system-core-<version>.formpack`; `pnpm dev` and `pnpm test` build it first, a bare `vite` or `vitest` in `apps/builder` needs it built |
| `pnpm e2e` | Builds, then runs Playwright end-to-end tests in Chromium |
| `pnpm test:determinism` | Runs the `@form/logic` corpus in Chromium, Firefox and WebKit and diffs every `EvalState` JSON byte-for-byte with Node's, plus the `@form/i18n` grapheme corpus, the `@form/templates-core` corpus (`instantiate`, snippets, sanitiser, lock fingerprints) and the `@form/validation` corpus (re2js regex verdicts, presets, masks, `FieldError`s) the same way (CI job `determinism`) |
| `pnpm test:perf` | Runs the `@form/logic` benchmark (300 blocks, 200 rules) alone and without coverage, and prints every trial's p95 (CI job `determinism`) |
| `pnpm deps` | Check dependency-layer rules (dependency-cruiser) |
| `git grep -nE 'innerHTML\|dangerouslySetInnerHTML\|execCommand' -- apps packages` | Must find nothing: rich text is an AST rendered as React elements (CI fails on any match) |
| `pnpm i18n:extract` | Regenerate `packages/i18n/locales/en-IN/*.json` from `defineMessages(…)` calls; `--check` only reports stale catalogues (CI runs it) |

**First e2e run:** download the browser once:
```sh
pnpm --filter @form/builder exec playwright install chromium
```

**First determinism run:** download the three engines once:
```sh
pnpm --filter @form/logic exec playwright install chromium firefox webkit
```

**Useful variations**
- One package: `pnpm --filter @form/builder <script>`
- Watch mode for unit tests: `pnpm --filter @form/builder exec vitest`
- One test file: `pnpm --filter @form/builder exec vitest run src/lib/logic.test.ts`
- Ignore the Turborepo cache: add `--force`, e.g. `pnpm test --force`
- Playwright report after a failure: `pnpm --filter @form/builder exec playwright show-report`
- Mailer contract against a real Mailpit as well as the in-process SMTP sink (CI does this in the `check` job):
  ```sh
  docker run -d --rm --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit:v1.31.3
  FORM_TEST_MAILPIT_SMTP=smtp://localhost:1025 FORM_TEST_MAILPIT_API=http://localhost:8025 pnpm test
  ```

- Integration tests against an existing server instead of a container: `FORM_TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test:int` (superuser; each test file creates its own database). `FORM_TEST_PG_IMAGE=postgres:16` checks the Postgres 16 floor.

Tests named after a bug id (for example `B7: …`) that use `it.fails` describe bugs not fixed yet. They count as passing while the bug exists and start failing once it is fixed; then switch them to `it`.

## Dependency policy

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 20160`, so pnpm only resolves versions published at least **14 days** ago. Renovate (`renovate.json`) follows the same rule for upgrades.
- Shared versions (React, zod, TypeScript, Vite, Vitest, …) live in the `catalog:` section of `pnpm-workspace.yaml`; packages reference them as `"catalog:"`.
- If `pnpm add` fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, pin the newest version that is at least 14 days old (`pnpm view <pkg> time`) instead of excluding the package.

## Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm: command not found` | Run `corepack enable pnpm`, or prefix commands with `corepack` |
| Turborepo: `Unable to find package manager binary` | pnpm is not on `PATH`; run `corepack enable pnpm` |
| Port 5173 or 4173 already in use | Stop the other process, or run `pnpm --filter @form/builder exec vite --port 5180` |
| e2e: `Executable doesn't exist` | Install the browser: `pnpm --filter @form/builder exec playwright install chromium` |
| Stale results after switching branches | Re-run with `--force`, or run `pnpm install` again |

## Branches

- `main`: the original builder.
- `dev`: integration branch for the platform work (Phase 0 onward).
- Work happens on short-lived branches, one commit per work package (`WP-x.xx`, see the [delivery plan](docs/platform/04-delivery-plan.md)).
