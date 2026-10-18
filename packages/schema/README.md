# @form/schema

The form schema v2 contract (`docs/platform/02-form-schema-v2.md` §2) and everything that checks it. Pure and isomorphic: no React, DOM or Node built-ins.

| Path | What it holds |
|---|---|
| `src/v2/*.ts` | The verified v2 types, split by section (§0 `ids.ts` … §19 `entry-points.ts`) |
| `src/v2/zod/*.ts` | A zod twin `<Type>Schema` for every wire type; `BLOCK_SCHEMAS` / `ANSWER_VALUE_SCHEMAS` for the generic ones |
| `src/v1.ts` | The v1 builder types (`V1.*`), their twins and the lenient `parseV1` |
| `src/validate/structure.ts` | `validateStructure(def, { mode })`: invariants I1, I3, I4, I5/I6, I7, I12, I14 as `PublishIssue[]` |
| `src/hash.ts` | `canonicalJson` (RFC 8785), `sha256Jcs` and `contentHash = sha256(JCS(x))` |
| `src/migrate/index.ts` | `migrate(doc, ctx)` (§19 `Migrate`: the form steps from the document's version to `SCHEMA_VERSION`, `FORM_MIGRATIONS`), `migrateUnknown(json, ctx)` (parseV1 or the twin first) |
| `src/migrate/v1-to-v2.ts` | `migrateV1ToV2(v1, ctx)` → `V1MigrationResult` (schema §4.2): definition, ops (access, retention), `plaintextPasswordToHash`, `assetImports`, notes |
| `src/migrate/notes.ts` | `NOTE_MEANINGS`: what each `MigrationNote` code means |
| `src/migrate/templates.ts` | `migrateTemplatePayload(payload, { steps?, migrateDocument? })`: the template `migrate()` hooks (payload steps per kind, the form `migrate()` for `document`, inline refs as payloads), then the twin parse |
| `src/richtext/*.ts` | `fromHtml` / `fromHtmlInline` (v1 HTML → AST through an htmlparser2 allowlist; never a DOM), `normalizeRichDoc` / `normalizeInlineDoc` (editor JSON → canonical AST, with `RICH_TEXT_PROFILE` and `PASTE_PROFILE`), `toPlain`, `htmlToInline` / `htmlToPlain` for `MigrationContext` |

## Rules

- **Twins are exact.** `test/twins.test-d.ts` asserts `z.infer<typeof XSchema>` equals `X` for every export; `test/twins.coverage.test.ts` fails on any exported type without an asserted twin (the few contract types with methods are listed there with a reason).
- **Optional means absent.** Twins use `.exactOptional()`, matching `exactOptionalPropertyTypes`.
- **Recursion is bounded before parsing.** Every exported schema that can reach a `z.lazy` checks its input first: rich-text schemas (docs and single nodes) enforce ≤ 20k nodes, depth ≤ 8 and lists ≤ 3 deep; the logic and answer schemas (`Expr`, `Operand`, `Condition`, `ConditionGroup`, `ScalarValue`, answers) reject JSON nested deeper than 256. `test/guards.test.ts` walks every export to keep it that way.
- **No key is dropped silently.** Twins are strict (ADR-0002 §1): every object twin is a `z.strictObject`, so an unknown key is an `unrecognized_keys` issue, never stripped. zod skips an own `__proto__` key in records; every record goes through `keyed()`, which makes that a parse error. Ids and field keys never name `__proto__`, `constructor` or `prototype`.
- **Unanswered is absent (I9).** A present answer never holds `''` or an empty choice, a name or address without parts, a matrix without an answered row (or a row without an answered cell), a repeating group without rows, a consent without items, or a payment with neither items nor a custom amount.
- **Unknown block types survive.** `StoredBlockSchema` keeps them as `UnsupportedBlock` with the original in `raw`; `validateStructure` reports them as `unknown_block_type` (an error at publish) and never inspects `raw` or `x-*` extensions.
- **`parseV1` reports every repair**, including each unknown key it drops (`unknown_key`) and each option value it fills in from the label (`defaulted`). It is the only lenient reader.
- **Money is a `MinorUnits` string** (decision D1) that fits a Postgres bigint; numbers are `DecimalString`s, never JS floats.
- `test/types.negative.test-d.ts` holds the five checks that must keep failing to type-check.
- **Template payloads hold placeholders only.** A literal or member recipient fails to type-check (`test/templates.test-d.ts`) and to parse (`test/templates.test.ts`); every kind round-trips (`test/roundtrip.test.ts`). The system-template harness in `test/templates.test.ts` runs the five builder templates through `migrate()`, with their real i18n bundle and data inventory. `migrateTemplatePayload` runs the payload steps first, then the form `migrate()` on the document they produced.
- **Migration is pure and reports everything.** Ids come from `ctx.idFactory` (v1 block, page-break and option ids are kept when valid); there is no clock, randomness or host locale. Every change a reader could notice is a `MigrationNote`; the password leaves only through `plaintextPasswordToHash` (S5) and external images only through `assetImports` (S7). Kept v1 ids are claimed before any id is generated, and another `idFactory` changes only the generated ids (tested on the corpus and in the property test). A current document migrates to itself with no notes, which guards the twin round-trip. Rules v2 cannot keep (deleted or answerless source, a later page (I8), a cycle, an operator or value the source's type does not take, a condition on a rating or scale that the changed range makes constant) are disabled with a note, never dropped silently (schema §4.2.1).
- **The migration corpus** is `test/fixtures/v1/` (the 5 builder templates and 30 forms named after the bug they exercise; `@form/schema/migration-fixtures` for other packages' tests), with golden outputs in `test/fixtures/v2/` (seeded `idFactory`; refresh with `vitest -u` and review the diff). These tests use `test/fixtures/registry-en-IN.json`, a projection of `@form/registry` that `@form/logic`'s `test/migrate.test.ts` regenerates and checks; `@form/logic` also runs `validateDefinition(…, 'save')` and `compile()` (`test/migrate.test.ts`) and the v1 show/hide parity oracle (`test/parity.test.ts`) over the corpus.
- **HTML is only ever parsed here.** `fromHtml` is the one way in for v1 label HTML and clipboard HTML; it keeps `b i u s code a` (http(s), mailto and tel only), colours as `textColor`/`highlight`, paragraphs, headings, lists, quotes and rules, and unwraps or drops everything else. `test/fixtures/xss.ts` is the shared XSS corpus (also used by `@form/renderer` and the builder's unit and e2e tests).

```sh
pnpm --filter @form/schema typecheck
pnpm --filter @form/schema test     # runtime, property (fast-check) and type tests
pnpm --filter @form/schema twins    # only the twin coverage check
```
