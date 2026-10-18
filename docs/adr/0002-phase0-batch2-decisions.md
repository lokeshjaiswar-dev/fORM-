# ADR-0002: Phase 0 batch-2 decisions

- **Status:** Accepted (approved by the product owner on 2026-10-18)
- **Date:** 2026-10-18
- **Work packages:** decisions raised by WP-0.04, WP-0.06, WP-T0.1, WP-0.15, WP-0.13, WP-0.12 and WP-0.08; applied in one change before the remaining Phase 0 WPs (WP-0.05, WP-0.07, WP-0.14 onwards)

## Context

The second Phase 0 batch (WP-0.12, 0.15, 0.04, T0.1, 0.13, 0.06, 0.08) merged into `dev` with seven questions its reviewers could not settle alone. Each one either changes a frozen contract (`@form/schema` twins, the registry's scalar function, the formpack manifest) or decides how a later WP must behave (WP-0.07 compile, WP-1.03 contract suites). They are recorded here together because they were decided together. ADR numbers in `03-architecture.md` §10 were planned before any were written; the planned "one `fr-server` image" ADR moves from 0002 to 0019.

The open minor reviewer issues from the same batch are in [`docs/platform/backlog.md`](../platform/backlog.md).

## 1. Zod twins are strict

**Context.** The twins used `z.object`, which strips unknown keys. A writer that added `enc` to a `StoredAnswer`, or `order` to a block, got a successful parse with the data silently gone. The batch also left three spec items for sign-off: the PublishIssue code `invalid_rich_text`, the §19 entry points shipped as function types, and the narrowed dependency-cruiser exemption.

**Decision.**
- Every wire and storage twin rejects unknown keys: object twins are `z.strictObject` (zod issue `unrecognized_keys`). This covers the v2 twins and the V1 twins; `parseV1` stays the only lenient reader and reports every key it drops. Records still go through `keyed()`, so an own `__proto__` key is an error too.
- `invalid_rich_text` is a PublishIssue code (I5/I6: rich text outside the allowed AST).
- The §19 entry points are function-type aliases (`ValidateDefinition`, `Compile`, `ResolveForPublish`, `Evaluate`, `ProjectForRuntime`, `Migrate`, `Instantiate`, `InsertSnippet`, `LockFingerprint`, `SanitizeForTemplate`, `DiffTemplate`), not `declare function`s; the implementing packages export functions of those types.
- Type-only import cycles are allowed only inside `packages/schema/src/v2` (rule `no-circular-schema-runtime`); runtime cycles fail everywhere.

**Consequences.** Forward compatibility comes only from `UnsupportedBlock` (unknown block types) and the `x-*` extension bags, so adding a field to a stored shape needs a schema version and a migration step. Readers older than the writer refuse new keys instead of losing them. The schema spec §2 and the twins now agree on all four points.

## 2. `answerScalar` is the one scalar contract

**Context.** `FieldDefinition.toScalar(value, path)` has no block, so option scalars come out with `blockId: ''`. WP-0.06 added `answerScalar(block, value, path)` and `bindScalar`, and asked whether `toScalar` should take a block parameter instead.

**Decision.**
- Logic, validation and templates read answers as scalars only through `@form/registry` `answerScalar(block, value, path)`. `toScalar` keeps its signature as the per-type primitive behind it; no block-parameter variant is added.
- The registry conventions become spec (schema §2.2): `defineStub` (value types) and `defineStubBlock` (plain blocks) for unavailable types; `x-field:<type>` as the capability of a stub without a named `Capability`; `DRAFT_DEFAULT_CONFIG_TYPES` (today `repeating_group`) for defaults the schema rejects.
- WP-0.07's `compile()` treats `missing_capability` as fatal.

**Consequences.** WP-0.07 has one function to call and cannot mix bound and unbound option scalars. A form using a stub type, or logic outside the P0 subset, never compiles.

## 3. Schema §17 follows the templates spec; manifest entries carry a sha256

**Context.** WP-T0.1 implemented `06-templates.md` (ES256 signatures, the attestations file, `OrgProfile.rightsUrl` and `boardComplaintInfo`), but the schema spec §17 still showed the earlier shapes. The manifest listed `categories` and `attestations` as bare paths, outside the signed file hashes.

**Decision.** Schema §17 now matches the code and `06-templates.md`. In `FormpackManifest`, `categories` and the optional `attestations` are `{ path, sha256 }` like every other file, validated by the twin (`Sha256HexSchema`).

**Consequences.** The one signature over the manifest covers every file in a `.formpack`, so an import can reject a tampered categories or attestations file by hash (WP-T0.3 builds and verifies packs).

## 4. Feature ids, contract-suite owners and edition settings

**Decision.**
- The `capability:*` names gated by the edition are accepted: `capability:payments`, `capability:guardian_digilocker`, `capability:captcha_<provider>` and `capability:analytics_<provider>`, alongside `field:payment` and `integration:<provider>` (architecture §1.5).
- The contract suites deferred by WP-0.15 (captcha, GeoIP, egress, queue, audit-sink, search) belong to WP-1.03, with the first production implementation of each port. WP-0.13 shipped no implementation of these ports, so nothing is left for it; the queue suite runs against WP-0.14's pg-boss adapter.
- `CAPTCHA_PROVIDERS` and `INTEGRATIONS_ENABLED` are documented in architecture §1.5.
- The WP-0.15 stand-ins are gone: `@form/ports` re-exports `CountryCode` and `IsoInstant` from `@form/schema`, and `@form/config` re-exports `FeatureId` and `INTEGRATION_PROVIDERS` (now a schema constant behind `IntegrationBinding['provider']`). `toIsoInstant(date)` stays in ports, because the pure schema package never touches `Date`.

**Consequences.** Ports depend on `@form/schema` for types (allowed by the layer rules). Port data and schema data share one set of brands.

## 5. SeaweedFS for dev and CI S3

**Context.** MinIO no longer publishes images, and it is AGPL. WP-0.13 used SeaweedFS (Apache-2.0) in `compose.dev.yaml`.

**Decision.** SeaweedFS replaces MinIO for the dev and CI S3 API, pinned by version and digest (`chrislusf/seaweedfs:4.48@sha256:…`). This is recorded in architecture §1.4, §6 and §7.2 and as a note on decision D14. It does **not** decide D14: the on-prem bundle stays bring-your-own S3 unless D14 says otherwise. pnpm's "ignored build scripts" notice is silenced explicitly through `ignoredBuiltDependencies` (`cpu-features`, `protobufjs`, `ssh2`: optional native or informational scripts).

**Consequences.** Storage contract tests in WP-1.03 run against SeaweedFS. Nothing AGPL is in the dev stack.

## 6. i18n: system keys, segmenter, digits

**Decision.**
- The i18n tests import `SYSTEM_MESSAGE_KEYS` from `@form/schema` (a devDependency; dependency-cruiser allows i18n tests to read schema) and the hand copy is deleted. The i18n runtime still does not depend on the schema.
- `unicode-segmenter` (pinned exactly) is the grapheme segmenter; the docs no longer name `graphemer`.
- Numbers use Latin digits in every locale. Native digits (Devanagari, Tamil, …) are a later per-locale option.

**Consequences.** A key added to the schema fails the i18n catalogue test until `en-IN` has a message. Formatting stays identical across engines, and digit input and output need no transliteration in P0–P1.

## 7. Builder copy and paste keeps formatting

**Context.** Every paste went through the strict paste profile (bold, italic, underline, links, lists), so copying a label to another label inside the builder lost colour, strike, code, headings and quotes.

**Decision.** Copy and cut in a builder editor put the selection on the clipboard three ways: the builder's own AST payload (`application/x-form-rich-text+json`, `{ format: 'fORM-rich-text', version: 1, doc }`), HTML from `toV1Html` and plain text from `toPlain`. Paste prefers the payload and normalizes it with the full rich-text profile, then checks it against `RichDocSchema` (limits included), because any page can write that type. A missing or invalid payload falls back to the strict rules: HTML through `fromHtml` with the paste profile, or plain text.

**Consequences.** Copy and paste between builder editors keeps everything the AST allows; paste from Docs, Word or the web keeps only the strict set. ProseMirror still never parses clipboard HTML, and nothing reads or writes `innerHTML`.
