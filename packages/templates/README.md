# @form/templates

System templates authored as data and the signed `.formpack` they ship in (TPL-02, WP-T0.3; `docs/platform/06-templates.md` §8). The templates are v2 `FormpackTemplateFile`s: the WP-0.05 `migrate()` output of the five builder templates, hand-edited (real options, required fields, placeholders, the NPS labels the v1 page break had shifted). `createBlock` no longer builds anything at import time.

| Path | What it holds |
|---|---|
| `src/system/core/*.json` | `pack.json` (publisher, name, CalVer version, slugs and versions), `categories.json`, one file per template: `payload`, `localizations` (gallery text), `categorySlugs` |
| `src/build.ts` | `validatePackSource` and `buildFormpack(source, signer)` |
| `src/formpack.ts` | `writeFormpack`, `readFormpack`, `verifySignature`, the zip guards (`FORMPACK_LIMITS`) |
| `src/version.ts` | `packTemplateVersion`: a pack template as the published `TemplateVersion` `instantiate()` takes, with ids `uuidv5(PACK_NAMESPACE, '<publisher>/<pack>/<slug>[@<version>]')` |
| `src/keys.ts` | `DEV_TRUSTED_KEY`, the public half of the development key |
| `scripts/` | `templates:build` (Node): reads `src/system/core`, signs with `signerFromEnv()`, writes `dist/system-core-<version>.formpack` |

## Build

`pnpm templates:build` (also the package's `build`, so `pnpm build`, `pnpm dev` and `pnpm test` run it before the builder) fails on any error and prints publish warnings. Per template it checks:

- the file against `FormpackTemplateFileSchema` after `migrateTemplatePayload` with no form `migrate()` bound, so sources stay at the current schema;
- the document with `validateDefinition(…, 'publish', REGISTRY)`: registry lints (`required_and_disabled`, `missing_capability` for stub types, …) and logic (operand types, cycles, page order); warnings are reported, errors stop the build;
- an instance: `instantiate()` with the declared defaults, then `validateDefinition(…, 'save')`;
- every `var` declared (`org.*`, `brand.*`, `form.*` are built in), the data inventory against the document's purposes and fields, refs inlined (a `TemplateRef` cannot resolve inside a pack), gallery text in the default locale, known categories, unique slugs.

The manifest lists `templates/<slug>.v<version>.json`, `categories.json` and the optional `attestations.json` with their sha256, `requiredFeatures` (the payload's plus `field:<type>` per block type) and `dependsOn` (empty while refs are inline). `signature.json` is `{ alg, keyId, sig: base64(sign(JCS(manifest))) }`; the key decides `alg`: Ed25519, or ES256 for a P-256 key. Zip entries carry a fixed timestamp built in local time (fflate writes DOS times from the local-time fields), so a build is byte-for-byte repeatable on any machine and in any time zone; `test/formpack.test.ts` pins the system-core pack's sha256. The signature does not depend on the timestamps.

Signing keys: without configuration the development key signs (`fORM-dev-2026`, an Ed25519 key from a published seed, so it proves only that the pack came out of `templates:build`). `FORM_PACK_SIGNING_KEY` (a PKCS#8 PEM file, Ed25519 or P-256) and `FORM_PACK_KEY_ID` select another key.

## Reading a pack

`readFormpack(bytes, { trustedKeys })` refuses, with a `FormpackError` code: more than 200 MB, 2,000 files, 64 MB per file, 512 MB in all or a 200× expansion (checked before inflating); absolute, drive-letter, backslash, dot-segment or control-character paths and duplicate entries; an untrusted key id, a key of another algorithm, a signature that does not verify over JCS(manifest); a listed file that is missing or whose sha256 differs; any file the manifest does not list; template, category and attestation files their twins reject. It does not migrate or re-validate templates (the importer's step 3, WP-T1.2 / WP-T2.9). Verification uses WebCrypto, so the same code runs in Node and the browser.

The builder imports `dist/system-core-<version>.formpack?inline` (bundled, no network), reads it with `DEV_TRUSTED_KEY` and makes a form with `instantiate()`.

```sh
pnpm --filter @form/templates templates:build
pnpm --filter @form/templates test        # the system pack, negative fixtures (registry, logic), tamper and guard cases, ES256
```
