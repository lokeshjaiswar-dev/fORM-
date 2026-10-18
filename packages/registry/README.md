# @form/registry

The field registry (FND-03, `docs/platform/02-form-schema-v2.md` §7): one `FieldDefinition` per `BlockType`, so no other package hard-codes type knowledge. Pure and isomorphic: no React, DOM or Node built-ins.

| Path | What it holds |
|---|---|
| `src/index.ts` | `REGISTRY: FieldRegistry` (a missing type is a compile error), `valueDefinition`, `answerScalar` / `bindScalar` |
| `src/define.ts` | `defineField`, `defineBlock`, `defineStub`, `defineStubBlock` and the shared field rules (B27 lint, text keys, lockable paths) |
| `src/fields/<type>.ts` | The 20 P0 types, fully implemented |
| `src/stubs.ts` | Every other type: real config schema and default config, no palette, `missing_capability` at lint |
| `src/availability.ts` | `AVAILABLE_TYPES` (P0) and the phase of each stub |
| `src/compliance.ts` | CMP-03 defaults per value type; `COMPLIANCE_UNDER_REVIEW` |
| `src/operators.ts` | Operator sets per `ComparableKind` |
| `src/messages.ts` | Palette labels and default texts (`builder` catalogue) |

## Rules

- **The twins come first.** `configSchema` and `answerSchema` run the `@form/schema` zod twin, then the registry's cross-field and config-dependent checks, only on input the twin accepted.
- **Answer issues carry a `ValidationErrorCode`** as the zod message and in `params.code`; `@form/validation` maps the twin's own issues. Regex patterns, presets, masks, relative date bounds, age and uniqueness are not checked here (they need re2js, `meta.today` or the server).
- **Unanswered is absent (I9).** `isEmpty` is true exactly for the values the answer twin rejects as empty; ratings, scales and NPS have no empty value, so 0 is a real NPS answer (B7) and a ranking exists only once ranked (B8).
- **One answer shape per type** whatever the display (B25). Rating `max` is 1–10 (B28). A required field that starts disabled, or is read-only without a value source, is a lint error (B27).
- **Option scalars are unbound.** `toScalar(value, path)` has no block, so options carry `blockId: ''`; use `answerScalar(block, value, path)` or `bindScalar`.
- **Every `defaultConfig` parses** except the types in `DRAFT_DEFAULT_CONFIG_TYPES` (`repeating_group`: its children are blocks the builder inserts, and the schema needs at least one). Code that builds and validates defaults generically (migration, template checks) skips them.
- **Lint severities are publish severities.** Callers that validate drafts downgrade them.
- Stub capabilities without a named `Capability` use `x-field:<type>`.

```sh
pnpm --filter @form/registry typecheck
pnpm --filter @form/registry test   # table tests per type, operator and export-header snapshots, type tests
```
