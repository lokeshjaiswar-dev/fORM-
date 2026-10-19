# Phase 0 exit gate: status

Checked on `dev` on 2026-10-19 against "Phase 0 exit gate" in [04-delivery-plan.md](04-delivery-plan.md). Every Phase 0 work package is merged as one commit; open minor issues are in the [backlog](backlog.md).

**Verdict:** the code criteria pass, with the exceptions below. Phase 0 is not formally complete until the missing ADRs are written and the spec owner has made the open decisions.

## Work packages on `dev`

| WP | Commit |
|---|---|
| WP-0.01 | `0778ae2` move into `apps/builder`, `74acfb1` pnpm + Turborepo workspace |
| WP-0.16 | `cc4d2fd` dead code cleanup |
| WP-0.02 | `6e028e4`, `42c85af` test harness, characterisation tests, CI |
| WP-0.03 | `0d4bf6b` v1 hotfixes |
| WP-0.12 | `999119c`, `cb07db4` i18n |
| WP-0.15 | `214ae20` ports, adapters, contract suites |
| WP-0.04 | `2ce64cb` schema v2 and zod twins |
| WP-T0.1 | `320b1db` template payload schemas |
| WP-0.13 | `4bf6bfb` API skeleton, db, RLS |
| WP-0.06 | `27f34d3` field registry |
| WP-0.08 | `7476f5f` rich text AST and editors |
| DEC-B2 | `337e81d` (ADR-0002, backlog) |
| WP-0.14 | `2f2ac3b` worker on pg-boss |
| WP-0.07 | `de230b2` logic@2 engine |
| WP-T0.2 | `fc07ae4` templates-core |
| WP-0.09 | `9fbdeac` validation |
| WP-0.05 | `956835f` v1 → v2 migration |
| WP-T0.3 | `5914931` system template pack |
| WP-0.10 | `d74f0d7` renderer and builder preview |
| WP-0.11a | `027020d` builder stores, IndexedDB drafts, routing |
| WP-0.11b | `ec7e63b` builder on the registry and v2, New-form flow through templates |

## Checks

Run with the Turborepo cache (inputs unchanged since each WP's integration run).

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm lint` | Pass (1 existing warning) |
| `pnpm typecheck` | Pass |
| `pnpm test` | Pass, 32/32 tasks, after one re-run. In the first run, `apps/builder/src/pages/routes.test.tsx` "New form → Blank opens an empty v2 form (B23)" timed out while `pnpm test:int` loaded the machine in parallel. It passed alone (10/10), and the full builder suite then passed 327/327. The test is flaky under load |
| `pnpm build` | Pass |
| `pnpm deps` | Pass, no layer violations |
| `pnpm e2e` | Pass, 17/17 in Chromium |
| `pnpm test:int` | Pass: db 121, api 6, worker 10 |
| `git grep innerHTML\|dangerouslySetInnerHTML\|execCommand -- apps packages` | 0 matches |
| `pnpm test:determinism` | Not run at the gate (see below) |

## Criteria

| Criterion | Result | Evidence |
|---|---|---|
| All 46 P0 rows traced to merged WPs (§8) | Pass | Every Phase 0 WP in §2 is merged (table above) |
| The builder only edits v2 | Pass | WP-0.11b: store, commands and drafts hold a v2 `FormDefinition`; CI fails on any `V1.` in production source outside `packages/schema/src/migrate` |
| Preview runs `@form/renderer` | Pass | WP-0.10: `PreviewPane` renders `FormRenderer` |
| B1–B29 and S1–S4 fixed or carried to a named WP | Pass, with gaps in test naming | No `it.fails` bug tests remain. Named regression tests exist for every id except B3, B10, B11, B24, B26, B29 and S3. B3 is carried to LOG-25 (P1), B24 to PUB-03 (P1); B10, B11, B26 and B29 are fixed by the v2 schema and renderer design; S3 is replaced by the rich-text AST (WP-0.08). S9 → VAL-09 (P1), S11 → FND-20 |
| `schema`, `registry`, `logic`, `validation` ≥ 90% line coverage | Pass | Lines: schema 95.95%, registry 96.77%, logic 96.25%, validation 99.17%. Only logic and validation enforce a 90% threshold in `vitest.config.ts`; schema and registry have none |
| Determinism green in Node + Chromium + Firefox + WebKit | Not re-run at the gate | Skipped at the gate to save time. It passed at each integration (WP-0.07, T0.2, 0.09, T0.3) and runs in CI job `determinism` |
| API and worker run locally with RLS; meta-tests (partitions, actor kinds) in CI | Pass | `pnpm test:int` against Postgres 18 in Testcontainers: db 121, api 6, worker 10 tests passed (CI job `db`) |
| ADRs merged: 0001 monorepo, rich text, logic engine, registry, RLS model (0001, 0015, 0016) | **Fail** | Only ADR-0001 and ADR-0002 exist. The rich text, logic engine, registry and RLS decisions are in `docs/platform/` but not written up as ADRs |

## Open before Phase 0 is complete

1. **Write the missing ADRs** (rich text, logic engine, registry, RLS model). Docs only.
2. **Renderer size budget (BL-129, BL-136):** the initial load is about 131 KB gzipped against a 90 KB budget (excluding React and the catalogue). The shared engines alone are about 96 KB. The spec owner decides: raise the budget, or load the engines after first paint. The `bundle.test.ts` test measures only the renderer's own code, so it passes while the budget is missed.
3. **Scope decisions (BL-148, BL-153):** WP-0.11a/0.11b scope moves recorded in the delivery plan, and whether the "no `V1.`" rule covers tests.
4. **Release signing (BL-116):** the builder trusts the public development key. Needs a real key before any release build (owner WP-T1.2).
5. **Pack bytes depend on the time zone (BL-119):** one-line fix in `packages/templates/src/formpack.ts`.
6. **Form password stored in plain text in IndexedDB drafts (BL-145):** until WP-1.06.
7. **Flaky builder route test** (`routes.test.tsx`, B23) under parallel load; raise its `findBy` timeout or split the flow.
8. **Coverage thresholds:** add `thresholds: { lines: 90 }` to `packages/schema` and `packages/registry`.

Backlog: 162 rows, 110 open, 51 done, 1 moved to WP-1.03. The only open row marked major is BL-148 (scope decisions for the spec owner).
