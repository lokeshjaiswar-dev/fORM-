# @form/schema

The form schema v2 contract (`docs/platform/02-form-schema-v2.md` §2) and everything that checks it. Pure and isomorphic: no React, DOM or Node built-ins.

| Path | What it holds |
|---|---|
| `src/v2/*.ts` | The verified v2 types, split by section (§0 `ids.ts` … §19 `entry-points.ts`) |
| `src/v2/zod/*.ts` | A zod twin `<Type>Schema` for every wire type; `BLOCK_SCHEMAS` / `ANSWER_VALUE_SCHEMAS` for the generic ones |
| `src/v1.ts` | The v1 builder types (`V1.*`), their twins and the lenient `parseV1` |
| `src/validate/structure.ts` | `validateStructure(def, { mode })`: invariants I1, I3, I4, I5/I6, I7, I12, I14 as `PublishIssue[]` |
| `src/hash.ts` | `canonicalJson` (RFC 8785), `sha256Jcs` and `contentHash = sha256(JCS(x))` |

## Rules

- **Twins are exact.** `test/twins.test-d.ts` asserts `z.infer<typeof XSchema>` equals `X` for every export; `test/twins.coverage.test.ts` fails on any exported type without an asserted twin (the few contract types with methods are listed there with a reason).
- **Optional means absent.** Twins use `.exactOptional()`, matching `exactOptionalPropertyTypes`.
- **Recursion is bounded before parsing.** Every exported schema that can reach a `z.lazy` checks its input first: rich-text schemas (docs and single nodes) enforce ≤ 20k nodes, depth ≤ 8 and lists ≤ 3 deep; the logic and answer schemas (`Expr`, `Operand`, `Condition`, `ConditionGroup`, `ScalarValue`, answers) reject JSON nested deeper than 256. `test/guards.test.ts` walks every export to keep it that way.
- **No key is dropped silently.** zod skips an own `__proto__` key in records; every record goes through `keyed()`, which makes that a parse error. Ids and field keys never name `__proto__`, `constructor` or `prototype`.
- **Unanswered is absent (I9).** A present answer never holds `''`, an empty choice or a name/address without parts.
- **Unknown block types survive.** `StoredBlockSchema` keeps them as `UnsupportedBlock` with the original in `raw`; `validateStructure` reports them as `unknown_block_type` (an error at publish) and never inspects `raw` or `x-*` extensions.
- **`parseV1` reports every repair**, including each unknown key it drops (`unknown_key`).
- **Money is a `MinorUnits` string** (decision D1); numbers are `DecimalString`s, never JS floats.
- `test/types.negative.test-d.ts` holds the five checks that must keep failing to type-check.

```sh
pnpm --filter @form/schema typecheck
pnpm --filter @form/schema test     # runtime, property (fast-check) and type tests
pnpm --filter @form/schema twins    # only the twin coverage check
```
