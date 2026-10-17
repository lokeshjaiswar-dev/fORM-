# ADR-0001: Monorepo layout

- **Status:** Accepted
- **Date:** 2026-10-17
- **Work package:** WP-0.01 (feature matrix row FND-01)

## Context

fORM- started as a single Vite app. The platform needs a public runtime, an API, background workers and pure shared packages (schema, logic, validation, renderer) that run identically in the browser and on the server, for both multi-tenant SaaS and on-prem editions. See [`docs/platform/03-architecture.md` §1](../platform/03-architecture.md).

## Decision

1. **pnpm 10 workspaces + Turborepo 2.** Shared dependency versions live in the `catalog:` of `pnpm-workspace.yaml`. Packages that run install scripts must be listed in `onlyBuiltDependencies`.
2. **Layout:**
   - `apps/`: `builder`, `runtime`, `api`, `worker`, `worker-pdf`, `cli`, `admin` (P3)
   - `packages/`: `schema`, `registry`, `logic`, `validation`, `templates-core`, `templates`, `renderer`, `ui`, `i18n`, `sdk`, `email`, `db`, `ports`, `adapters`, `crypto`, `config`, `observability`, `testkit`, `tsconfig`, `lint-config`
   - `deploy/`: `docker`, `helm/form`, `airgap`
3. **Scope:** every workspace package is named `@form/<dir>`.
4. **Internal packages are source-only.** `"exports": { ".": "./src/index.ts" }`, `"type": "module"`, no build step. Vite, Vitest and `tsx` consume TypeScript directly; Node apps are bundled with tsup for production.
5. **TypeScript bases** live in `@form/tsconfig`. New packages extend `strict.json`. `apps/builder` keeps its own config until WP-0.11b moves it to strict.
6. **Dependency layers** (enforced by dependency-cruiser from WP-0.02):
   ```
   L0  schema, i18n(core), lint-config, tsconfig
   L1  registry → L0; logic → registry, L0; validation → logic, registry, L0; templates-core → validation, logic, registry, L0
   L2  renderer → L1, L0, i18n, ui; ui → react only; sdk → schema
   L2s ports, crypto, config, observability, db, adapters, email
   L3  apps/*
   ```
   Pure packages (`schema`, `registry`, `logic`, `validation`, `templates-core`) never import React, the DOM or `node:*`.

## Consequences

- One install and one lockfile (`pnpm-lock.yaml`); `package-lock.json` is retired.
- The builder moved from `src/` to `apps/builder/src/` with no content changes; `git log --follow` keeps its history.
- Turborepo caches `build`, `typecheck` and `test` per package; remote caching is optional and stays off for air-gapped builds.
