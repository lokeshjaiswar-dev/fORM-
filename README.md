# fORM-

A form platform for multi-tenant SaaS and on-prem deployments, working toward feature parity with JotForm, with SOC 2 and India DPDP compliance built in. The plan, schema, architecture and delivery roadmap are in [`docs/platform/`](docs/platform/README.md).

## Workspace

| Path | Package | What it is |
|---|---|---|
| `apps/builder` | `@form/builder` | Vite + React form builder |
| `packages/tsconfig` | `@form/tsconfig` | Shared TypeScript bases (`base.json`, `strict.json`) |

More apps and packages (`runtime`, `api`, `worker`, `schema`, `logic`, `validation`, `renderer`, …) arrive through the Phase 0 work packages. The full layout is fixed in [ADR-0001](docs/adr/0001-monorepo.md).

## Prerequisites

- Node 24 (`.nvmrc`)
- pnpm 10 through Corepack: `corepack enable` (the exact version is pinned in `package.json` → `packageManager`)
- On Windows: `git config core.longpaths true`

## Commands

Run from the repository root:

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Start the builder dev server (http://localhost:5173/builder/demo) |
| `pnpm build` | Build every app and package (Turborepo) |
| `pnpm typecheck` | Type-check every project |
| `pnpm test` | Run unit tests |
| `pnpm lint` | Lint the repository with oxlint |

Run a task in one package with `pnpm --filter @form/builder <script>`.
