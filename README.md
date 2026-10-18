# fORM-

A form platform for multi-tenant SaaS and on-prem deployments, working toward feature parity with JotForm, with SOC 2 and India DPDP compliance built in. The plan, schema, architecture and delivery roadmap are in [`docs/platform/`](docs/platform/README.md).

> **Status:** Phase 0 (foundation). Today the repo contains the form builder and an API skeleton over Postgres with row-level security. The builder keeps forms in memory, so a page refresh starts over; builder persistence and the public runtime arrive in later work packages.

## Workspace

| Path | Package | What it is |
|---|---|---|
| `apps/builder` | `@form/builder` | Vite + React form builder |
| `apps/api` | `@form/api` | Fastify 5 API skeleton: `buildApp(config)`, zod type provider, problem+json errors, `/livez` and `/readyz`, OpenAPI, `GET /v1/forms` behind RLS, dev header auth stub |
| `packages/db` | `@form/db` | Drizzle tables, SQL migrations, roles (`fr_migrator`, `fr_app`, `fr_template_seeder`, `fr_system_agg`), null-safe RLS helpers, `withTenant()`, definer functions, RLS meta-checks |
| `packages/observability` | `@form/observability` | pino logger with redaction, URL and query scrubbing, NTP clock check, OpenTelemetry (OTLP only when configured) |
| `packages/i18n` | `@form/i18n` | ICU messages (`createI18n`), en-IN catalogues, en-XA pseudo-locale, lakh/crore number, money and `DD-MM-YYYY` date formatting, pinned grapheme segmenter |
| `packages/schema` | `@form/schema` | Form schema v2 types, zod twins, v1 reader, structural validation, JCS hashing |
| `packages/registry` | `@form/registry` | Field registry (`REGISTRY: FieldRegistry`): config and answer schemas, operators, paths, compliance defaults, export columns and lint for every block type |
| `packages/tsconfig` | `@form/tsconfig` | Shared TypeScript bases (`base.json`, `strict.json`) |
| `packages/ports` | `@form/ports` | Adapter interfaces (storage, mailer, KMS, search, captcha, AV scan, GeoIP, guardian, audit sink, egress, queue) and the `JobData` map; no dependencies |
| `packages/adapters` | `@form/adapters` | Dev implementations: filesystem storage, SMTP mailer (Mailpit), local-keyfile KMS, no-op scanner, manual guardian review |
| `packages/config` | `@form/config` | Edition config schema (`DEPLOYMENT_MODE`, `EGRESS_POLICY`) and feature availability |
| `packages/testkit` | `@form/testkit` | Adapter contract suites (`runStorageContract`, …), the Postgres Testcontainers harness and test helpers; imported by tests only |

More apps and packages (`runtime`, `worker`, `registry`, `logic`, `validation`, `renderer`, …) arrive through the Phase 0 work packages. The full layout is fixed in [ADR-0001](docs/adr/0001-monorepo.md).

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
   Open http://localhost:5173. It redirects to `/builder/demo`. Type `/` on the canvas (or use the field picker) to add fields, then switch to **Preview** to fill in and submit the form.

5. **API and database (optional; needs Docker)**
   ```sh
   docker compose -f deploy/docker/compose.dev.yaml up -d   # Postgres 18, S3 (SeaweedFS), Mailpit, Grafana LGTM
   pnpm dev:setup     # roles, migrations, demo org; writes apps/api/.env.local
   pnpm dev:api       # tsx watch on http://127.0.0.1:8080
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
| `pnpm test:int` | Integration tests against Postgres 18 in Testcontainers: migrations, RLS isolation for every actor kind, RLS meta-tests, definer functions, the API (CI job `db`). Needs Docker |
| `pnpm build` | Build every app and package |
| `pnpm e2e` | Builds, then runs Playwright end-to-end tests in Chromium |
| `pnpm deps` | Check dependency-layer rules (dependency-cruiser) |
| `pnpm i18n:extract` | Regenerate `packages/i18n/locales/en-IN/*.json` from `defineMessages(…)` calls; `--check` only reports stale catalogues (CI runs it) |

**First e2e run:** download the browser once:
```sh
pnpm --filter @form/builder exec playwright install chromium
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
