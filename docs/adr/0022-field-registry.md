# ADR-0022: The field registry is the single source of type knowledge

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; decided by the schema v2 design and ADR-0001, delivered in WP-0.06)
- **Work package:** WP-0.06 (feature matrix row FND-03; FLD and PROP rows ported to the registry)

## Context

In v1, knowledge about each field type was spread over 7 to 9 files and about 15 hard-coded checks (codebase map §3a), so adding a type meant editing all of them and missing one produced bugs (B7, B8, B25, B27, B28). Logic, validation, templates, the builder, the renderer and exports all need the same facts about a type: its config, its answer shape, its operators and paths, its compliance default and its export columns. The review also found that the plan and the architecture disagreed on where the registry lives (C-m23, F-9). See [`docs/platform/02-form-schema-v2.md` §2](../platform/02-form-schema-v2.md) (`FieldDefinition`, `FieldRegistry`) and §2.2.

## Decision

1. **One `FieldDefinition<T>` per `BlockType`**, in the pure package `@form/registry` (`packages/registry`, ADR-0001). `FieldRegistry = { [T in BlockType]: FieldDefinition<T> }`, so adding a `BlockType` without a registry entry is a compile error.
2. A definition holds: `kind`, optional `capability`, `palette`, `configSchema` and `defaultConfig(locale)`, `defaultCompliance` (the CMP-03 PII default; authors may raise it, never silently lower `sensitive`), `answerSchema`, `paths` and `operators` per `ComparableKind`, `toScalar`, `isEmpty`, `translatable`, `export` (columns, cells, text), `lockableContent` and `lint`.
3. **No React in the registry.** React components live in the renderer, with their own exhaustive map of controls per available type (`Record<AvailableType, Control>`), and the builder's canvas, inspector, icons and tiles are views keyed by the same types.
4. **One scalar contract:** logic, validation and templates read answers only through `answerScalar(block, value, path)`; the per-type `toScalar` stays the primitive behind it (ADR-0002 §2).
5. **Stubs for types that are not available yet:** `defineStub` (value types) and `defineStubBlock` (plain blocks) give a real `configSchema` and `defaultConfig`, no palette and a `missing_capability` lint; capabilities without a named `Capability` use `x-field:<type>`; `DRAFT_DEFAULT_CONFIG_TYPES` lists the types whose default config is a draft the schema rejects (`repeating_group`).
6. **Twins first:** `configSchema` and `answerSchema` run the `@form/schema` zod twin, then the registry's cross-field checks. Unanswered is absent (I9): `isEmpty` is true exactly for the values the answer twin rejects as empty.

## Consequences

- No other package hard-codes type knowledge; Phase 0 ships the 20 P0 types in full and every other type as a stub, so a template or a migrated form may contain a stub block that never compiles.
- Lint severities are publish severities; callers validating drafts downgrade them.
- Table tests per type (default config parses, samples accepted, invalid samples rejected, `isEmpty` agrees with I9) and operator and export-header snapshots guard the registry.

## Links

- Schema spec §1 (`FieldRegistry` from design D1), §2 (`FieldDefinition`, `FieldRegistry`), §2.2 (registry conventions)
- Architecture §1.2 (`registry` owns / must not own), §1.3 (layer L1)
- Delivery plan [WP-0.06](../platform/04-delivery-plan.md)
- Feature matrix [FND-03](../platform/01-feature-matrix.md)
- Review log [C-m23, F-9](../platform/05-review-log.md)
- [`packages/registry/README.md`](../../packages/registry/README.md)
- Related: [ADR-0001](0001-monorepo.md), [ADR-0002 §2](0002-phase0-batch2-decisions.md)
