# ADR-0021: The `logic@2` engine: a compiled, acyclic plan evaluated in one pass, identical in every engine

- **Status:** Accepted. Four behaviours at the end of the decision are recorded as built and still await the spec owner's confirmation (BL-076, BL-077).
- **Date:** 2026-10-19 (written up; decided by the schema v2 design, §3, and delivered in WP-0.07)
- **Work package:** WP-0.07 (feature matrix row FND-06; semantics of LOG-03/04; bug B21)

## Context

The v1 builder evaluated one condition per block in the browser only (`logic.ts`), compared numbers as strings and allowed "hidden + required" traps. The platform needs the same answer in the builder preview, the runtime, the API and the worker, because **the server is the only authority**: it recomputes visibility, requirements, calculations and totals and drops answers that should not exist. Reviews found that a plain V8 test proves nothing about other browsers, that `Intl.Segmenter` and trigonometric functions differ by host (F-14), that writers of one cell were not ordered (F-16), that on-path membership was not a cell (F-17), that client and server clocks and metadata differed (F-18), and that the runtime projection lost the data the client needs for incremental updates (F-19). See [`docs/platform/02-form-schema-v2.md` §3](../platform/02-form-schema-v2.md).

## Decision

1. **Compile, then evaluate.** `compile(def, registry)` turns every rule, variable, calculation, capture and dynamic default into a step that reads and writes **cells** (`visible`, `onPath`, `enabled`, `required`, `value`, `var`, `optionHidden`, `jump`, `ending`, `submitBlock`, and server-only cells). A read of `value(b)` also reads `visible` of b and its ancestors and `onPath(pageOf(b))`; `onPath(p)` is its own `on_path` step.
2. **One total order.** Same-cell writers get edges in authored order ("last write wins in authored order"); any cycle is the publish error `logic_cycle` with its path and, when a writer edge closes it, a "conflicting writers" hint. Kahn's sort with ties broken by rule index, then document order, gives the plan stored in `CompiledForm.plan`; the API recomputes and compares it at publish.
3. **Single pass.** The graph is acyclic, so one pass over the plan reaches the result. `evaluate` is a pure, total function of `(version, answers, meta)` (I10): it never throws on answers or metadata; division by zero, overflow and invalid dates give `null` and a trace diagnostic.
4. **Page-order rule (I8), transitive.** A step that writes visibility, enablement, requirement, option visibility, jumps or submit blocks for page P reads only cells on pages ≤ P, through every cell it reads; validation bounds that reference another block obey it too (`validation_bound_page_order`). Next on page P therefore never passes and then fails at submit.
5. **Taint (I13).** `compile()` records, for every derived cell, the highest classification and the union of purposes of what it reads (`CompiledForm.taint`).
6. **Determinism.** No host clocks (`meta.now` is frozen at the session's `startedAt`; the server clamps it), no `Math.random` (shuffles use `meta.shuffleSeed`), no floats (decimal.js full build at precision 34), no locale-dependent string functions (a generated case-fold table), a grapheme segmenter pinned to one Unicode version (`unicode-segmenter` via `@form/i18n`), and `re2js` for regex on both sides. A fixture corpus runs in Node and in Playwright on Chromium, Firefox and WebKit, and every `EvalState` JSON must be byte-identical (CI job `determinism`).
7. **Engine versioning.** A version is always evaluated by the engine it was compiled with (`logic@2`). Changing semantics means a new engine id; old engines keep their contract tests. A change to the pinned determinism digest is a semantic change.
8. **Client and server split.** The runtime projection keeps client steps and their `reads` and drops server rule steps (`ClientRuleStep` / `ServerRuleStep`); the renderer re-runs only the steps downstream of a changed cell, and incremental equals full. On the server the same plan runs, then the path is re-simulated, invisible, disabled and unconsented answers are dropped, totals are recomputed, validation runs, and only then server effects.
9. **The P0 subset.** Condition groups with every comparison operator (dates included), actions show, hide, require, unrequire, enable and disable, and `Expr` limited to `lit`, `ref` and comparisons. Everything else is `missing_capability`, which `compile()` treats as fatal until WP-2.01 to 2.03 (ADR-0002 §2). Answers are read only through `answerScalar(block, value, path)` ([ADR-0022](0022-field-registry.md)).

Recorded as built in WP-0.07, pending the spec owner (BL-076, BL-077):

- **Null in conditions.** Null is false in conditions, except that the negated operators `not_contains`, `not_starts_with`, `not_ends_with` and `includes_none` are true when the left side is null, as in v1 (schema §3.1).
- **Host NFC.** NFC comes from the host's `String.prototype.normalize`, the one accepted exception to "no host Unicode tables"; a pinned NFC table is BL-075.
- **B21.** A rule whose condition reads a deleted block is disabled (left out of the plan, its targets keep their initial state), not refused; the dangling id stays a draft warning and a publish error (I4).
- **Loaded versions.** The 300-block / 200-rule target (< 5 ms p95 in Node, incremental < 1 ms) applies to a loaded version: the prepared plan is cached per `version.compiled` object, so the submission pipeline (WP-1.12) and the runtime (WP-1.09) keep one object per version id in memory. The cold path is measured and guarded only against gross regressions.

## Consequences

- The browser previews what the server decides; any difference is a bug caught by the corpus.
- Pure package rules apply: no React, DOM, `node:*`, `Date`, `Math.random`, `Intl` without an explicit locale, `Intl.Segmenter`, `crypto.randomUUID` or `performance.now` in `@form/logic` (enforced by oxlint and dependency-cruiser).
- `@form/validation` and `@form/templates-core` build on the compiled form; the builder preview compiles locally with `compile` and `projectForRuntime`.

## Links

- Schema spec §1 (engine versioning from design D3), §2 (invariants I8, I10, I13), §3.1–3.3
- Architecture §0 principles 4 and 6, §1.2, §1.4 (determinism)
- Delivery plan [WP-0.07](../platform/04-delivery-plan.md)
- Review log [F-14, F-16, F-17, F-18, F-19](../platform/05-review-log.md)
- Backlog [BL-075, BL-076, BL-077](../platform/backlog.md)
- [`packages/logic/README.md`](../../packages/logic/README.md)
- Related: [ADR-0002 §2](0002-phase0-batch2-decisions.md)
