# fORM- × JotForm: feature-match matrix

**Baseline:** fORM- at commit `e1be409`: a front-end-only builder of about 3.3k lines of TS/TSX, with 26 field types and no backend. JotForm behaviour comes from the October 2026 research (help docs, product pages, support answers).
**Goal:** "Feature match" means every row in phases P0, P1 and P2 is shipped (306 rows, see the summary). Rows in P3 and later are outside feature match.
**Revision:** v1.1, after the compliance and feasibility reviews (`05-review-log.md`). Rows changed by the review cite it in their notes or in the log.

## How to read this

**Domain.** Each `##` section is one domain, and the row ID prefix names it. Rows were deduplicated across the five research domains. A feature that appears in several domains has one row only, placed where it is built, and other rows point to it with "→ ID".

**fORM- today:**
- **Have**: works end to end in the current builder and preview. It may still need porting to the registry.
- **Partial**: some code exists but is broken, unsafe, client-only or incomplete. The cell gives the evidence (file:line or bug ID from the codebase map).
- **Missing**: no code exists.

**Pointer rows.** BLD-13, DSN-03 and DSN-09 were superseded by the Templates domain (§2b). They stay in place with "→ TPL-nn" in the Phase column and are not counted.

**Edition.** Every row must work in SaaS, on-prem and air-gapped installs unless its notes say it needs the internet; those rows are off by default when `EGRESS_POLICY=none`.

**Phase:**

| Phase | Meaning |
|---|---|
| **P0** | Foundation: monorepo, shared packages, field registry, safety and correctness fixes. The builder keeps working at every step. |
| **P1** | SaaS MVP and on-prem v1: auth, orgs, persistence, publish, runtime, submissions, notifications, spam, analytics, and the compliance primitives (RLS, audit log, PII tagging, Consent block, retention, field encryption, Helm). |
| **P2** | Feature match: everything a mid-market JotForm customer (Bronze to Gold, teams of 5 to 200) relies on day to day. |
| **P3** | Enterprise: features that are Enterprise-only at JotForm, or only matter for admin at scale. |
| **P4** | Later: long-tail widgets, separate JotForm products, and low-usage features. |
| **Won't** | Deliberately not built. A rationale is given. |

**Cx (complexity):** S is 2 days or less, M is up to 2 weeks, L is up to 6 weeks, XL is more than 6 weeks. Estimates are for one engineer.

"(exceeds)" marks a row where our target goes beyond JotForm.

---

## 1. Platform foundation (FND): internal enablers, no direct JotForm equivalent

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| FND-01 | pnpm + Turborepo monorepo under the `@form/*` scope (`apps/builder`, `runtime`, `api`, `worker`, `worker-pdf`, `cli`; `packages/schema`, `registry`, `logic`, `validation`, `renderer`, `sdk`, `templates-core`, `templates`, `ports`, `adapters`, `db`, …) | n/a | Missing: single Vite app in `src/` | P0 | M | Move `src` to `apps/builder` unchanged first. Layout frozen in ADR-0001 (architecture §1.1) |
| FND-02 | `packages/schema`: zod schemas, `schemaVersion`, migration function | n/a | Missing: TS types only (`types/form.ts`), no version | P0 | M | Split settings into `theme` / `behavior` (published) and `access` (server-only) |
| FND-03 | Field registry (`FieldDefinition`: config schema, answer schema, logic operators, PII default, export) in `packages/registry` | n/a | Missing: type knowledge spread over 7–9 files and about 15 hard-coded checks (map §3a) | P0 | L | Prerequisite for every new field row below. Add a completeness test per type |
| FND-04 | `packages/renderer` extracted from `FormPreview` (props-driven, `onSubmit` / `uploader` / `onEvent`) | n/a | Partial: one store read at `FormPreview.tsx:31`. Toast, password gate, redirect and DeviceFrame are mixed in | P0 | M | Order of work in map §3c |
| FND-05 | `packages/validation`: same zod validation on client and server, scoped to the current page and visible fields | n/a | Partial: `zodFromBlocks.ts` is pure, but checks `FileList` (`:52`) and has no visibility or page scope | P0 | M | Server use comes in P1 (→ VAL-09) |
| FND-06 | `packages/logic` evaluator API (`evaluate(version, answers, meta)`) | n/a | Partial: `logic.ts` handles a single condition. The `blocks` param is ignored | P0 | M | P0 ships today's semantics behind the new API. The full rule model is P2 (LOG-*) |
| FND-07 | Stable identifiers: option `value` is an immutable id, each field gets a `key` (unique name), `label` / `content` split, drop `order` | Unique Name per field (it changes when the label is renamed) | Partial: block uuid only. Option value is regenerated from the label (B15), values can duplicate (B16), `label` is overloaded | P0 | M | (exceeds) Keys stay stable when a label is renamed. Prefill, piping, export and the API all key on them |
| FND-08 | Rich text stored as a constrained AST (TipTap/ProseMirror JSON) and rendered as React nodes | Paragraph allows HTML and inline CSS | Partial: `contentEditable` + `execCommand` stores raw HTML. Stored XSS S1–S4 (`RichText.tsx:40`, `FormPreview.tsx:233-246`) | P0 | M | Allow only `http(s)`, `mailto` and `tel` links. Sanitise again at API save and at publish |
| FND-09 | Correctness sweep: B4–B16, B20–B22, B25, B27–B29 | n/a | Partial: bugs CONFIRMED in the map §4.1 | P0 | M | B1/B2 → VAL-10, B3 → LOG-25, B17–B19 → BLD-06 |
| FND-10 | Split the store into a document store and a UI store, with a persistence adapter and `:id` routing | n/a | Missing: one store mixes document and UI state. Id is hard-coded to `'demo'` (B23) | P0 | M | The adapter starts local and is swapped for the API client in P1 |
| FND-11 | Error boundary, Vitest + Testing Library contract tests per field type, CI | n/a | Missing: no tests, and an invalid regex white-screens the app (B12) | P0 | M | Testcontainers is added with the API in P1 |
| FND-12 | i18n framework: string extraction, ICU messages, `en-IN` locale, date/number formatting | n/a | Missing: English strings are hard-coded throughout | P0 | M | Avoids a retrofit later. The translation UI is RSP-05. Latin digits in every locale; native digits are a later per-locale option (ADR-0002 §6) |
| FND-13 | Builder performance: per-block selectors, `useWatch`-based evaluator context | n/a | Partial: whole-form subscriptions, re-renders are O(n²) (map §4.5) | P0 | M | Needed before forms of 100 fields or more |
| FND-14 | Dead code and copy cleanup | n/a | Partial: `App.css`, unused assets, `sheet.tsx`, competitor copy in `ThemeSettings.tsx:19` | P0 | S | |
| FND-15 | `apps/api`: Fastify 5, fastify-type-provider-zod, Drizzle, Postgres, pino + OpenTelemetry | n/a | Missing | P0 | L | Skeleton, health checks, migrations, request context carrying `org_id` |
| FND-16 | `apps/worker`: pg-boss on Postgres (no Redis) | n/a | Missing | P0 | M | Runs emails, PDFs, retention, webhooks and exports |
| FND-17 | Adapters: object storage (S3 API), email (SMTP), KMS (cloud KMS / Vault / local keyfile), search (Postgres FTS), AV scan, GeoIP, captcha, guardian verification | n/a | Missing | P1 | L | Interfaces are designed in P0. Every adapter must have an air-gapped implementation. On-prem storage is bring-your-own S3 by default. Dev and CI use SeaweedFS (Apache-2.0, ADR-0002 §5); MinIO is not used or bundled (AGPL, see architecture §6) |
| FND-18 | Packaging: OCI images, Helm chart, air-gapped bundle (offline images, no outbound calls) | JotForm: dedicated Google Cloud instance only, no customer-hosted option | Missing | P1 | L | (exceeds) Fixed decision. External Postgres is the default profile. Multi-hop upgrade path in the bundle, third-party notices and source offers for GPL/AGPL parts |
| FND-19 | Edition and feature-flag config (SaaS vs on-prem: metering, external integrations, captcha provider) | n/a | Partial: `@form/config` edition config (WP-0.15) served by `GET /v1/meta/edition` and shown in the builder, which hides what the edition cannot run (WP-1.05). Metering and plan or licence features are later WPs | P1 | S | Integrations that need the internet are off by default on air-gapped installs |
| FND-20 | Security headers: strict hash-based CSP for builder and runtime, `frame-ancestors` per form, `Referrer-Policy: no-referrer` on the runtime; runtime and user files on a separate registrable domain (SaaS) | n/a | Partial: builder headers done (WP-1.05, [builder-security-headers.md](builder-security-headers.md)); runtime CSP and the separate domain are WP-1.09 | P1 | S | Subdomains of one site are the same site, so SaaS serves `forms` and `files` from their own domain (ADR-0013) |

## 2. Builder UX (BLD)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| BLD-01 | Drag-and-drop canvas: palette to canvas, reorder, side-by-side placement | WYSIWYG drag, reorder, gear icon opens properties | Have: `BuilderDnd.tsx`, `FieldPicker.tsx`, dnd-kit | P0 | S | Re-point at the registry. Fix the mutation bug (B19, via BLD-06) |
| BLD-02 | Element palette by category, with search / slash command | Tabs: Quick, Basic, Survey, Page, Payments, Widgets | Have: 6 categories plus a cmdk slash menu (`SlashMenu.tsx`) | P2 | S | Add Payments and "Advanced" categories as the new types land. The palette is generated from the registry |
| BLD-03 | Inline label editing on the canvas | Inline label edit | Partial: works, but through the unsafe `RichText` and the `innerHTML` sink | P0 | M | Delivered with FND-08 |
| BLD-04 | Properties panel with General / Options / Advanced sections per type | Gear panel with General, Options and Advanced tabs plus type-specific tabs | Partial: `BlockInspector.tsx` (640 lines) has hard-coded type groups (`:38-44`, `:169`, `:449`, `:567`) | P0 | M | Panels come from the registry. Fix inputs that cannot be cleared (`Number(v) or default`) |
| BLD-05 | Duplicate and delete a field | Duplicate Field, delete | Partial: `duplicateBlock` shares references and copies logic (B20). Delete leaves dangling rule references (B21) | P0 | S | |
| BLD-06 | Undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) | Session undo / redo | Partial: no `equality` (B17), a global 600 ms pause loses actions (B18), mutated snapshots (B19), redo not guarded while typing (B22) | P0 | S | `equality: a.form === b.form`, per-field debounce |
| BLD-07 | Server autosave of the draft | Every change autosaves | Missing: memory only | P1 | M | Optimistic concurrency with a `draft_rev` check |
| BLD-08 | Draft and published separation: edit a live form without changing it until publish | Enterprise-only "Draft Mode" | Missing | P1 | M | Falls out of immutable FormVersions. Core for us |
| BLD-09 | Revision history: list, preview and revert published versions and autosaved drafts | Revision History with Revert | Missing | P2 | M | P1 already stores the versions. P2 adds the UI and revert |
| BLD-10 | Version diff and named versions | Not offered | Missing | P2 | M | (exceeds) |
| BLD-11 | Preview with live logic and desktop / tablet / phone frames | Preview toggle, device previews | Partial: `FormPreview` + `DeviceFrame`. Paging is broken (B1). URL and mode drift (B23) | P0 | S | Preview runs the same renderer package in `mode="preview"` |
| BLD-12 | Logic and calculation badges on canvas blocks, calculated fields shown read-only | Not offered | Missing | P2 | S | (exceeds) |
| BLD-13 | Template gallery: search, preview, clone into the workspace | Over 20,000 templates in categories | Partial: 5 templates built at import time (`data/templates.ts`) | → TPL-07, TPL-12 | — | Pointer row, not counted. Gallery v1 is TPL-07 (P1); the curated catalogue is TPL-12 (P2) |
| BLD-14 | Multi-user editing: shared forms, presence indicator, conflict-safe saves | Collaboration link, real-time co-edit | Missing | P2 | M | Optimistic locking plus presence. Real-time CRDT → BLD-16 |
| BLD-15 | Import forms (JotForm through its API, Google Forms, CSV of questions) | AI import by URL or document | Missing | P2 | M | Supports migration in sales. JotForm API mapping to the registry |
| BLD-16 | Real-time CRDT co-editing (Yjs) | Real-time co-editing | Missing | P4 | L | Locking plus presence (BLD-14) covers the mid-market need |
| BLD-17 | Guest edit link that needs no account (expiring) | 72-hour collaboration link, no account needed | Missing | P4 | S | Security trade-off. Team invites (WSP-*) cover the need |
| BLD-18 | Builder keyboard navigation and builder accessibility (dialog focus trap, ARIA) | Not documented | Partial: `dialog.tsx` has no role, focus trap or Escape | P2 | M | Replace with Radix or Ark primitives |

## 2b. Templates (TPL)

The full spec is `06-templates.md`. These rows replace BLD-13, DSN-03 and DSN-09, which remain above only as pointer rows.

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| TPL-01 | Template payload schemas (7 kinds), `schemaVersion`, migrations, reserved `origin`, `var` and `locks` | n/a | Missing: `TEMPLATES` is an array of `FormSchema` | P0 | M | `packages/schema` |
| TPL-02 | `packages/templates`: system templates authored as data, validation CI, signed pack build, port of the 5 existing | Gallery of 20,000+ | Partial: 5 built at import time with `createBlock` | P0 | M | Completeness test: every template parses under the registry and logic |
| TPL-03 | `instantiate()` and `insertSnippet()` engine: id, key and rule remap, origin stamps, variable baking | Clone | Missing | P0 | M | The offline builder uses it before the API exists |
| TPL-04 | Template tables, RLS policies (incl. localizations and category links, null-safe for every actor kind), isolation tests | n/a | Missing | P1 | M | Spec §5.1–5.2 |
| TPL-05 | System pack seeding at boot and upgrade, signature check, Helm values, air-gapped | n/a | Missing | P1 | M | (exceeds) |
| TPL-06 | Org profile (incl. privacy contact) and template variables (live binding resolved at publish, `variables_snapshot`) | Not offered | Missing | P1 | M | (exceeds) Needed for the Consent block and privacy-contact details |
| TPL-07 | Templates API and gallery v1 (search, categories, preview with the real renderer, Use dialog), single-block snippet insertion (Consent), placeholder thumbnails | Gallery, Preview, Use Template | Partial: `TemplateModal.tsx` | P1 | M | Replaces the P1 part of BLD-13 |
| TPL-08 | Customise in P1: save a form as a personal or org template (sanitiser), fork a system template, open an org template, edit and publish vN, lifecycle (deprecate, archive, restore, delete), metadata and category editor | Share as Template | Missing | P1 | M | Policy `admins_only` by default. Upstream updates for forks → TPL-32 |
| TPL-09 | System default email and ending templates (notification, autoresponder, thank-you, closed, limit, not-yet-open, DSR response) | Default emails per form | Missing | P1 | S | With NOT-02/03, END-01, ACC-01–04 |
| TPL-10 | Compliance starter set (P1 variants): DPDP Consent snippet, DSR and grievance request forms with signed-link identity confirmation, consent withdrawal, guardian consent | Not offered | Missing | P1 | S | Content work. Legal review. Full versions (OTP, unique IDs) in TPL-12 |
| TPL-11 | Usage events, daily rollup, popularity sort | Popular, Trend sort | Missing | P1 | S | Popularity needs ≥ 5 distinct orgs |
| TPL-12 | Curated catalogue of about 150 (about 60 India-specific) plus about 30 snippets | 20,000+ | Missing | P2 | L | Volume parity is a non-goal |
| TPL-13 | Facets (industry, compliance, layout, features), locale filter, worker thumbnails, synonyms, zero-result log | Types, Industries, layout, sort | Missing | P2 | M | |
| TPL-14 | Theme templates, saved custom themes, brand kit v1 (one per org), brand refs in every kind | Themes, My Themes, Brand Kit (Enterprise) | Missing | P2 | M | About 20 presets incl. high-contrast. Without a kit, brand refs fall back to theme defaults with a warning |
| TPL-15 | Snippet templates: section container, save selection, slash-menu insert | Not found | Missing | P2 | M | Needs FLD-48 |
| TPL-16 | User-authored email, ending and PDF templates reused across forms | Per form only | Missing | P2 | M | With NOT-06, END-03, EXP-05 |
| TPL-17 | Team scope, org review and approval flow, org categories | Share as Template review, Admins Only | Missing | P2 | M | |
| TPL-18 | Template versions, three-way diff, opt-in update into the draft, variable and optional-part editor | Not offered | Missing | P2 | L | (exceeds) Shares the BLD-10 diff engine |
| TPL-19 | Template i18n: message bundles, localised metadata, completeness, XLIFF, hi-IN for the top 30 | Language field per template | Missing | P2 | M | The 22-language Consent notice is CMP-04 |
| TPL-20 | Signed bundle export and import (`.formpack`) | Not offered | Missing | P2 | M | (exceeds) |
| TPL-21 | Template analytics dashboard (library and author views) | Not offered | Missing | P2 | S | |
| TPL-22 | Workflow templates (bundled WFL-01 flows) | Workflow templates | Missing | P2 | S | With WFL-01 |
| TPL-23 | Locked regions, enforced in the builder and server; detach permission; audit | Not offered | Missing | P3 | M | (exceeds) Schema reserved in P0 |
| TPL-24 | Multiple brand kits, enforced org brand, bulk republish job | Brand Kit (single, default theme) | Missing | P3 | M | DSN-09 points here |
| TPL-25 | Mandatory updates with deadline for any template, governance dashboard (forms behind, detached) | Not offered | Missing | P3 | M | (exceeds) Consent snippets get this earlier through TPL-33 |
| TPL-26 | Gallery governance: hide the system gallery, category allow-list, restrict personal templates | Admin template toggle | Missing | P3 | S | With ENT-09 |
| TPL-27 | Third-party publisher trust store and industry packs | n/a | Missing | P3 | S | |
| TPL-28 | AI-generated templates from a prompt | AI template generation (Enterprise) | Missing | P4 | M | → AI-01. Needs an LLM adapter or a local model |
| TPL-29 | Moderated public community gallery (cross-tenant sharing) | User-submitted public gallery | Missing | P4 | L | Moderation, PII scanning, takedown |
| TPL-30 | Paid template or theme marketplace | Theme Store selling | Missing | Won't | — | Same rationale as DSN-10 |
| TPL-31 | App, Table, Board, Sign, Store and AI-Agent templates | Separate template families | Missing | Won't | — | Those products are non-goals (SUB-25, WFL-06, AI-03) |
| TPL-32 | Template forks receive upstream updates (template-to-template binding, three-way diff) | Not offered | Missing | P2 | M | (exceeds) An org's customised Consent or KYC template gets corrected legal text |
| TPL-33 | System legal-text updates for consent and compliance snippets: banner, bulk apply into drafts, mandatory with deadline | Not offered | Missing | P2 | S | Brought forward from TPL-25 because DPDP guidance may change after commencement |


## 3. Field types (FLD)

### 3a. Input fields

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| FLD-01 | Short text | Width, validation presets, character limits, mask, placeholder, default, read-only | Have: `text` with placeholder, default, prefix/suffix and pattern | P0 | S | Port to the registry. Limits → VAL-02, mask → PROP-12 |
| FLD-02 | Long text | Word or character limits, rich-text editor for respondents | Have: `long_text` with `showCharCount`. No word limits | P0 | S | Word limits → VAL-02. Respondent rich text → FLD-43 |
| FLD-03 | Full name (composite) | First and last; optional prefix (text or list), middle, suffix; per-part sublabels | Missing | P2 | S | First composite answer type (`{first,last,...}`). Logic and export need per-part paths |
| FLD-04 | Email | Format check, confirmation field, disallow free addresses, entry limit | Partial: `email` validates format. Pattern and error message offered but ignored (B13) | P2 | S | Confirmation field and free-domain blocklist. Server-side format check from P1 (VAL-09). OTP → SPM-04 |
| FLD-05 | Phone with country code | Country code selector, mask, allowed countries, default country | Partial: `phone` is free text, no country or format | P2 | M | libphonenumber-js, default `+91` for en-IN. Store E.164 |
| FLD-06 | Address (composite) | Street 1/2, city, state, postal code, country; toggle each part; US states dropdown; default country | Missing | P2 | M | Ship Indian state / UT and PIN code presets alongside US ones. Autocomplete → FLD-37 |
| FLD-07 | Number | Min/max, width, placeholder, default | Have: `number` with min/max | P0 | S | Fix B14 ("expected number, received NaN") |
| FLD-08 | Spinner (stepper) | +/- buttons, step, integers only, allow negatives | Missing | P2 | S | Number variant in the registry |
| FLD-09 | URL / link | Short Text with URL validation | Have: `url` | P0 | S | Port. Keep as its own type |
| FLD-10 | Dropdown (single) | Options, predefined lists, calculation values, placeholder, default | Have: `dropdown` via `NiceSelect` (no keyboard support or ARIA) | P0 | M | Accessibility fix or a native select on mobile. Predefined lists → PROP-10 |
| FLD-11 | Dropdown (multiple selection) | Multiple-selection toggle with visible-rows setting | Partial: `multi_select` shows as checkboxes in preview but as a dropdown in the editor (B25) | P0 | S | One rendering, decided in the registry |
| FLD-12 | Single choice (radio) | Other option with text, spread to columns, shuffle, calculation values, default | Partial: `multiple_choice`. "Other" has no text box (B25). No columns | P2 | S | Other text box, 1–4 column layout. Shuffle → PROP-11 |
| FLD-13 | Multiple choice (checkboxes) | Same as single choice, plus minimum/maximum selections | Partial: `checkbox`. No selection limits, "Other" has no text | P2 | S | Limits → VAL-06 |
| FLD-14 | Searchable dropdown | Dynamic Dropdowns widget (search) | Missing | P2 | S | Mode of FLD-10 for long lists (country, city) |
| FLD-15 | Image choice (single / multiple) | Image Choices / Image Picker widgets | Missing | P2 | M | Native block. Images come from the asset store (CMP-12) |
| FLD-16 | Date picker | Separator, format, default (none / today / custom), calendar popup, localised month names | Partial: native `<input type=date>`, no format or default options | P1 | M | Default `DD-MM-YYYY` for en-IN. Locale-aware |
| FLD-17 | Date limits | Age check, past/future, weekdays, start/end (relative), disabled dates and ranges | Missing | P2 | M | Enforced on client and server. Age check → VAL-12 |
| FLD-18 | Date with time | Optional time with 12/24-hour format and minute step | Missing | P2 | S | |
| FLD-19 | Time | AM/PM or 24h, AM-only or PM-only, default, start/end range with duration | Partial: native `time` input only | P2 | S | |
| FLD-20 | Star rating | Up to 8 icons, 1–10 stars (a 1–21 range is reported; to re-verify), low/high text, default | Partial: `rating` stars only. `ratingMax` unbounded, 1e7 hangs the page (B28) | P0 | S | Clamp to 1–10 in P0. Icon choices (star, heart, emoji) in P2 under the same row |
| FLD-21 | Scale rating / linear scale | Low/high text and values | Partial: `linear_scale`. Shows 0 selected when unanswered and min = 0 (B7) | P0 | S | |
| FLD-22 | NPS (0–10) | Via scale rating or widgets | Partial: `nps` shows "0" as selected when unanswered (B7) | P0 | S | (exceeds) First-class NPS with a score calculation |
| FLD-23 | Ranking | Widget | Partial: `ranking`. A required ranking can never fail (B8). No "Other" | P0 | S | (exceeds) native type |
| FLD-24 | Input table (matrix) | Radio, checkbox, text, number, dropdown or mixed columns; required per row or per cell; calculation values; shuffle rows | Missing | P2 | L | Each answer is a map from row to value. Export flattens to one cell per row |
| FLD-25 | Repeating group (Configurable List) | Configurable List widget: rows of mixed inputs, unlimited rows | Missing | P2 | L | Very common. Nested answer schema with min/max rows |
| FLD-26 | File upload | Size min/max (up to 1 GB), extension allowlist, file count, drag-and-drop, storage quota | Partial: `<input type=file>` held as an in-memory `FileList`. Nothing is stored | P1 | L | Presigned POST (enforces size) into an unversioned staging bucket, copied to the versioned bucket after inspection. Answer is `{fileId,name,size,mime}`. Uploads bind to the draft or submission, not the visit. MIME sniffing, ClamAV adapter, quota checks |
| FLD-27 | Take photo (camera) | Take Photo widget | Missing | P2 | S | FLD-26 with `capture`, plus EXIF/GPS stripped by default (DPDP) |
| FLD-28 | Signature | Draw-to-sign, width/height, pen colour, clear, embedded in the PDF | Partial: `SignaturePad.tsx`. Blank signature passes (B4), offset strokes and DPR ignored (B5), listener churn (B6), no clear button, stored as an unbounded data URL (S10) | P1 | M | P0 fixes the bugs. P1 uploads the PNG through `uploader`. Typed-signature alternative for accessibility. Audit metadata → WFL-07. A drawn signature is not an IT Act s.3A electronic signature: templates carry a disclaimer, legally recognised signing → WFL-08 |
| FLD-29 | Captcha | hCaptcha (default), reCAPTCHA (invisible), JotCAPTCHA | Missing | P1 | M | Self-hosted proof-of-work (ALTCHA-style) is the default in every edition (CMP-12). hCaptcha, Turnstile and reCAPTCHA are opt-in per form, declared as notice recipients and sub-processors; never available air-gapped |
| FLD-30 | Hidden field | Any field can be hidden and still receive prefill or calculations | Partial: `hidden` type is left out of both schema and defaults, so it captures nothing (B26) | P1 | S | Must accept URL prefill and UTM capture (PRE-01) |
| FLD-31 | Context capture (page URL, referrer, user agent, submission timestamp) | Get Page URL, Get Referrer and Get User Agent widgets | Missing | P2 | S | `meta` operands. Off by default and tagged as PII (CMP-03) |
| FLD-32 | Unique ID (per-form sequence number, e.g. `REG-000123`) | Unique ID widget | Missing | P2 | S | Assigned on the server at submit, gap-free per form |
| FLD-33 | Calculated / formula field (visible read-only result) | Form Calculation widget: decimals, comma decimal point, ignore hidden fields | Missing | P2 | L | Uses LOG-14 to LOG-19. Recomputed on the server (LOG-25). Inherits the highest classification and the purposes of the fields it reads (taint, CMP-03) |
| FLD-34 | Product list / payment field | Products, subscriptions, donations bound to a gateway | Missing | P2 | XL | Details in §11 (PAY-*) |
| FLD-35 | Appointment / booking | Weekly intervals, slot length, max per day, minimum notice, rolling days, blocked dates, capacity per slot, time zone, reminders | Missing | P2 | XL | Atomic slot reservation on the server. Reminders via pg-boss. ICS attachment. Calendar sync → INT-11 |
| FLD-36 | Terms and conditions (scroll-to-agree checkbox) | Terms & Conditions widget | Missing | P1 | S | Same block as the DPDP Consent block (CMP-04), in a non-consent mode |
| FLD-37 | Address autocomplete, geolocation, map picker | Card-form autocomplete, GPS and map widgets | Missing | P4 | M | Needs third-party map or geocoding APIs, which conflicts with air-gapped installs and the DPDP third-party stance. Optional adapter later |
| FLD-38 | Fill in the blank | Rich sentence with inline inputs | Missing | P4 | L | Low daily use. Needs inline inputs in the AST and the PDF |
| FLD-39 | Cascading / dependent dropdowns, data grid, spreadsheet input, inventory picker | Widgets | Missing | P4 | M | Long tail. Repeating group and matrix cover most cases. Stock → PAY-12 |
| FLD-40 | Video, audio and PDF embed blocks | YouTube and PDF Embedder widgets | Missing | P4 | S | Third-party embeds conflict with CMP-12. Allowlisted later |
| FLD-41 | Other long-tail widgets (about 700 in 19 categories) | Iframe widget marketplace | Missing | P4 | XL | Built natively case by case through the registry. Third-party SDK → INT-14 |
| FLD-42 | Third-party iframe widget marketplace | Iframe widgets, some unsupported in Cards | Missing | Won't | — | Security, CSP, DPDP third-party data flows and air-gapped installs. Native registry blocks instead |
| FLD-43 | Respondent rich-text input (long text editor mode) | Long Text "Editor Mode" | Missing | P4 | M | Low use. Stored-XSS surface. Would reuse the AST |

### 3b. Content and layout blocks

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| FLD-44 | Heading with subheading, size and alignment | Heading with subheading, three sizes | Partial: `heading` / `heading_2` / `heading_3`, no subheading | P2 | S | Collapse into one `heading` type with a `level` setting |
| FLD-45 | Paragraph (rich text with links, images, answer piping) | Rich text, HTML/CSS, piping | Partial: `paragraph` with unsafe HTML (S1/S2), no images or piping | P2 | M | The safe AST lands in P0 (FND-08). Images and piping come here. Piping → PRE-02 |
| FLD-46 | Image block (alt text, width, alignment, link) | Image element | Missing: only form-level `logoUrl` / `coverUrl` external URLs (S7) | P2 | S | Uploaded to the asset store. Alt text required (RSP-06, checked by RSP-08) |
| FLD-47 | Divider (style, colour, spacing) | Solid / dashed / dotted, colour, spacing | Partial: `divider`, no style options | P2 | S | |
| FLD-48 | Section collapse (expandable group, shown or hidden as a unit) | Starts open or closed, toggle visibility, target for logic | Missing | P2 | M | Introduces a group container in the schema, also used by LOG-09 |
| FLD-49 | Page break with Next/Back labels and button visibility | Custom labels, hide buttons, per-page validation | Partial: `page_break` exists. A trailing empty thank-you page (B10). No labels | P2 | S | Validation scope → VAL-10 (P0) |
| FLD-50 | Submit button: text, alignment, style, plus Print and Save buttons | Submit element with Print and Save-and-continue | Partial: `settings.submitButtonText`. The submit button on the canvas is fake (`FormCanvas.tsx`) | P2 | S | Save button → RSP-03 |

## 4. Common field properties (PROP)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| PROP-01 | Label and Required toggle | All inputs | Partial: works, but the label is unsafe HTML and Required is shown only by a hard-coded black `*` | P0 | S | With FND-08 and RSP-08 |
| PROP-02 | Description, help text and per-part sublabels | Sublabels, descriptions (Cards), all translatable | Partial: `helpText` only | P2 | S | Sublabels arrive with the composite fields |
| PROP-03 | Placeholder | All text inputs | Have: `placeholder` (default `Enter …` for every type) | P0 | S | Drop the generic default |
| PROP-04 | Hover text (tooltip) | Classic layout only | Missing | P4 | S | Help text covers the need. Tooltips are poor on mobile and for accessibility |
| PROP-05 | Default value, selected by default, dynamic defaults (today, now) | Default value, default date/time, selected-by-default | Partial: `customize.defaultValue` is a single string. No preselected options or dynamic defaults | P2 | S | Typed per field type through the registry |
| PROP-06 | Read-only / disabled | Read Only toggle | Partial: `customize.disabled`. Disabled plus required can never be satisfied (B27) | P0 | S | Read-only fields keep their value. Publish validation flags the conflict |
| PROP-07 | Hide field (kept in the schema for calculations or prefill) | Hide Field on any input | Partial: only through the separate `hidden` type | P2 | S | A `hidden` flag on any block |
| PROP-08 | Half width / side by side / columns | Shrink, Move to a New Line, Enable Columns | Have: `width: half`, `besidePrevious`, `packRows` (two columns only) | P2 | S | Extend to 1/2/3 columns. Collapse to one column on mobile |
| PROP-09 | Label alignment (top / left / right), set as form default | Per field, with a form default | Partial: `customize.align` left or center only | P2 | S | |
| PROP-10 | Predefined option lists (countries, Indian states, months, days, gender) and bulk paste | Predefined Options | Missing | P2 | S | |
| PROP-11 | Shuffle options / rows | Shuffle Options (Surveying tab) | Partial: `customize.randomize` flag exists, renderer support not verified | P2 | S | Seeded per session so Back keeps the order |
| PROP-12 | Input masks (`#` digit, `@` letter, `*` either, optional `[ ]`) | Short Text and Phone | Missing | P2 | M | Masks enforced on the server as well |
| PROP-13 | Calculation values on options | Numeric value per option, summed for checkboxes | Missing | P2 | S | Uses the stable option id (FND-07) |
| PROP-14 | Per-field style overrides (label/input colour, size, weight) | Custom CSS only | Have: `blockStyle.ts` | P0 | S | (exceeds) Move to theme tokens (DSN-01) |
| PROP-15 | Prefix / suffix and autofocus | Not offered natively | Have: `customize.prefix/suffix/autoFocus` | P0 | S | (exceeds) Keep |

## 5. Validation (VAL)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| VAL-01 | Required validation with a visible error | All inputs | Partial: broken by B1/B2 | P0 | S | |
| VAL-02 | Length limits (characters, words) | Character limits (Short Text), word or character limits (Long Text) | Partial: `validation.min/max`, applied inconsistently by type. No word mode | P2 | S | Character limits in P0 with the registry port. Word mode in P2 |
| VAL-03 | Validation presets (alphabetic, numeric, alphanumeric, URL, email) | Short Text Validation | Partial: free-form regex only | P2 | S | Add Indian presets: PAN, GSTIN, PIN code, IFSC. Aadhaar captures the last 4 digits only (no checksum, no full number anywhere). Full-number capture only through an Aadhaar Data Vault adapter (P4, off by default, UIDAI-authorised entities only) |
| VAL-04 | Custom regex, safe on the server | Not offered (presets only) | Partial: `new RegExp` throws inside `useMemo` (B12). ReDoS risk on the server (S8) | P1 | S | try/catch in P0. One engine on both sides: `re2js` (pure-JS RE2) in browser and server, length caps at publish in P1 |
| VAL-05 | Numeric min/max with friendly messages | Number entry limits | Have: min/max (bad message, B14) | P0 | S | |
| VAL-06 | Selection count limits (minimum / maximum checked) | Multiple choice entry limits | Missing | P2 | S | |
| VAL-07 | Custom error message per field | Per-form warning texts | Partial: `errorMessage` ignored for every type except the default (B13) | P0 | S | |
| VAL-08 | Customisable system messages ("Required", "Only one entry", …), translatable | Form Warnings editor, per language | Missing: hard-coded English | P2 | M | Built on FND-12 |
| VAL-09 | Server-side re-validation with the same package, 422 with per-field errors | Server-enforced | Missing: everything is client-only (S9) | P1 | M | Never trust the client for required, limits, calculations or access |
| VAL-10 | Per-page validation, visible fields only | Validation per page; hidden fields skipped | Partial: Next validates every page (B1). Hidden required fields block submit (B2) | P0 | M | Hidden + required cannot block submit by design (effective required set) |
| VAL-11 | Unique field (one value per form, e.g. email or ID) | Settings > Unique Field, custom warning | Missing | P2 | M | Server check over normalised values. Uses a blind index for encrypted fields (CMP-08) |
| VAL-12 | Age verification on a date field | Date Limits > Age | Missing | P2 | S | Shares a building block with the children's-data flow (CMP-13) |
| VAL-13 | First-class cross-field validation ("end date after start date") with a message | Workaround: hide Submit through a condition | Missing | P2 | M | (exceeds) Logic action `block_submit {message}` |

## 6. Conditional logic and calculations (LOG)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| LOG-01 | Form-level rules list (IF / DO) with search, filter by type or field, enable/disable, duplicate | Settings > Conditions; no naming or grouping | Missing: one `BlockLogic` per block | P2 | L | Rule builder UI (map §3b). The per-block Logic tab becomes a filtered view |
| LOG-02 | Rule names, groups and drag reordering | Not offered | Missing | P2 | S | (exceeds) |
| LOG-03 | Text and choice operators: equals, not equals, contains, starts with, ends with (and negations), empty, filled | Same set, varies by type | Partial: 11 operators. `equals` is case-sensitive and `contains` is not. Arrays compared as joined strings. Duplicate operators | P2 | M | P0 fixes the semantics inside FND-06. P2 adds the per-type operator matrix from the registry |
| LOG-04 | Numeric operators: greater/less than and greater/less or equal | Greater/less than only (Number and calculation fields) | Partial: lexicographic fallback (`logic.ts:55`) | P2 | S | (exceeds) adds ≥ and ≤ |
| LOG-05 | Date and time operators (before, after, equal; against a fixed value, another field or now) | Supported, in the browser's time zone | Missing | P2 | M | Time-zone-explicit |
| LOG-06 | Compare to another field | TARGET = FIELD | Missing | P2 | S | `Operand` model |
| LOG-07 | ALL / ANY combinators | Per condition. Mixing and nesting not supported | Missing: single condition | P2 | M | |
| LOG-08 | Nested AND/OR groups with negation | Not supported | Missing | P2 | S | (exceeds) Built into the `ConditionGroup` model |
| LOG-09 | Show / hide one or several fields, sections or text blocks | Show/Hide (Multiple) | Partial: per-block show/hide only. Hidden sources are not transitive. Dangling references (B21) | P2 | M | Evaluated to a fixpoint. A hidden source counts as unanswered |
| LOG-10 | Require / unrequire | Enable/Require/Mask | Missing | P2 | S | Dynamic required set feeds VAL-10 |
| LOG-11 | Enable / disable fields | Enable/Disable (multiple targets) | Missing | P2 | S | |
| LOG-12 | Conditional input mask | Mask Field action | Missing | P4 | S | Rare. Phone with country (FLD-05) removes the main use case |
| LOG-13 | Skip to page / hide page, with consistent Back navigation | Skip To / Hide Page | Missing | P2 | L | Skipped pages' answers are dropped (LOG-25) |
| LOG-14 | Calculate a field's value (formula editor; field references and literals) | Update/Calculate Field action plus the calculation widget | Missing | P2 | L | Pratt parser to an AST. No `eval`. The AST is stored in the FormVersion |
| LOG-15 | Copy field value | Copy Field Value | Missing | P2 | S | |
| LOG-16 | Text building (concatenation, URL or email assembly) | Text blocks in Calculate | Missing | P2 | S | Adds `upper`, `lower`, `trim`, `len` (exceeds) |
| LOG-17 | Math function library (abs … tan, constants, avg, avgNoZero, nth, count, commaSeparate, round) | Documented list | Missing | P2 | M | Whitelisted functions only |
| LOG-18 | Date math (add/subtract days, difference, date string, units) plus age and working days | Add/subtract days, no age or workday functions | Missing | P2 | M | (exceeds) Age and working days with an Indian holiday calendar option |
| LOG-19 | Decimal-safe arithmetic and number formatting (decimal places, comma decimal, lakh/crore grouping) | Decimals 0–10, comma decimal point | Missing | P2 | S | decimal.js (full build, which includes the trigonometric functions). Required for payment amounts |
| LOG-20 | Variables (named intermediate calculations, e.g. quiz score) | Hidden calculation fields used as variables | Missing | P2 | S | `Variable` in the schema |
| LOG-21 | Evaluation order, conflict and cycle detection at publish, no dangling ids | Top to bottom, last write wins, no detector | Missing | P2 | M | (exceeds) Same last-write-wins semantics, documented |
| LOG-22 | Rule trace in preview ("which rules fired") | Not offered | Missing | P2 | S | (exceeds) |
| LOG-23 | Time-window availability (show or hide by current date/time) | Recipe: hidden time field plus a condition | Missing | P2 | S | `meta.now` operand. Form-level schedule → ACC-06 |
| LOG-24 | Quiz scoring (correct answers, score, result bands → endings) | Calculation plus conditional thank-you recipe | Missing | P2 | M | Built on variables and endings. Covers JotForm's quiz templates |
| LOG-25 | Server-side logic enforcement: recompute calculations, required set, strip answers to hidden or skipped fields | Hidden and skipped fields excluded | Missing: hidden answers are kept and would be submitted (B3) | P1 | M | DPDP data minimisation. P1 covers show/hide. Extended automatically when the P2 actions land |

## 7. Prefill and piping (PRE)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| PRE-01 | URL parameter prefill by field key (composite sub-keys, comma-separated multiples, hidden fields, UTM), with a prefill URL builder | `?uniqueName=value`, `name[first]=`, Field Prepopulator | Missing | P1 | M | Keyed on FND-07. Works through the embed SDK. Sensitive fields cannot be prefilled by default. Prefill is applied on the client only, removed from the address bar after reading, excluded from the CDN cache key, and query strings are stripped from logs and traces |
| PRE-02 | Answer piping into labels, paragraphs, endings and option text | `{field}` tags in paragraphs and thank-you (labels unreliable) | Missing | P2 | M | (exceeds) Works in labels too. AST mention node, resolved live |
| PRE-03 | Personalised prefilled links (manual or CSV), lock prefilled fields, send by email | Prefill: links from Tables, spreadsheets, CRMs; send up to 5 at a time | Missing | P2 | M | Prefill data held on the server behind an opaque token, not in the URL |
| PRE-04 | Fill Again / prefill from the respondent's previous submission | Thank-you "Fill Again" | Missing | P2 | S | Through END-04 |
| PRE-05 | Prefill from CRMs (HubSpot, Salesforce, Airtable, monday) | Prefill data sources | Missing | P4 | M | After the integrations framework is mature. Personalised links (PRE-03) cover it |
| PRE-06 | Spreadsheet-to-form lookup prefill | Widget | Missing | P4 | M | Long tail |

## 8. Design and theming (DSN)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| DSN-01 | Theme: colours (page, form, font, input), font family, logo, cover, progress bar | Form Designer Colors and Styles | Partial: `FormSettings` has theme, background, text and accent colours, font, progress bar, `logoUrl` / `coverUrl` (external URLs, S7) | P1 | M | Theme becomes CSS custom properties. Images are uploaded to our store. Fix progress bar counting (B10) |
| DSN-02 | Form width, label alignment, base font size, spacing | Styles tab | Partial: per-block styles only | P2 | S | |
| DSN-03 | Theme presets gallery and saved custom themes | Themes tab (Featured, Used, Liked) | Missing | → TPL-14 | — | Pointer row, not counted |
| DSN-04 | Custom CSS (scoped and sanitised) | Inject Custom CSS, Classic only | Missing | P2 | M | Scoped under `.fr-root`. External `url()` blocked (exfiltration risk) |
| DSN-05 | Card layout (one question per screen, welcome card, keyboard navigation) alongside Classic | Classic and Card layouts | Missing: Classic multi-page only | P2 | L | Second renderer mode in `packages/renderer` |
| DSN-06 | Self-hosted font library | Google Fonts | Partial: inline font map (`FormPreview.tsx:49`) | P2 | S | Bundled fonts, Indic scripts included (Noto). No Google Fonts call from the runtime (CMP-12) |
| DSN-07 | Remove "Powered by fORM-" branding | Paid plans | Missing (no branding yet) | P1 | S | Plan-gated flag. On-prem: off |
| DSN-08 | Advanced Designer (CSS helper by pointing, padding sliders, logo position) | Classic-only Advanced Designer | Missing | P4 | L | Design tokens plus custom CSS cover it |
| DSN-09 | Org-enforced themes and brand kit | Enterprise themes, AI brand kit | Missing | → TPL-24 | — | Pointer row, not counted |
| DSN-10 | Theme store with selling | Users can sell themes | Missing | Won't | — | Marketplace economics outside our scope |
| DSN-11 | Success animation (confetti) | Not offered | Have: `Confetti.tsx` | P0 | S | (exceeds) Respect `prefers-reduced-motion` |

## 9. Form access, status and limits (ACC)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| ACC-01 | Enable / disable form with a custom closed message | Form Status, warning message | Partial: `settings.closed` checked client-side only | P1 | S | Enforced on the server. The runtime receives `status` |
| ACC-02 | Scheduled close (date and time) | Close on a date (fixed time zone) | Missing | P1 | S | Time-zone-aware `close_at` |
| ACC-03 | Scheduled open | Not offered | Missing | P1 | S | (exceeds) `open_at` |
| ACC-04 | Submission limit (total), and close at whichever of date or limit comes first | Submission limit, combined mode | Missing | P1 | S | Atomic counter in the submit transaction |
| ACC-05 | Password-protected form | Password checked at view and submit | Partial: plaintext password in the schema, compared in the browser (S5) | P1 | S | argon2id hash in `form_access`. `POST /f/:slug/unlock` returns a short-lived token. Rate-limited and audited |
| ACC-06 | Recurring availability windows (e.g. Mon–Fri 09:00–18:00 IST) | Not offered (support confirms) | Missing | P2 | S | (exceeds) |
| ACC-07 | Unique submission (cookie / device token / IP) | No check, cookies, or cookies plus IP | Missing | P2 | M | IP stored as a hash with a per-form salt whose lifetime equals the uniqueness window, then destroyed (CMP-11). IP alone never rejects (CGNAT) |
| ACC-08 | Embed domain allowlist | Not offered | Missing | P1 | S | (exceeds) Drives `frame-ancestors` (FND-20) |
| ACC-09 | Per-respondent limit for verified identities (one per verified email) | Through email verification | Missing | P2 | S | Builds on SPM-04 |
| ACC-10 | End-to-end encrypted forms (client-side key, owner-held private key) | Encrypt Form Data: disables integrations, filters and PDFs | Missing | P3 | XL | Server-side field encryption covers the mid-market (CMP-07). E2E is for high-sensitivity buyers |
| ACC-11 | Prevent cloning of public forms | Account setting | Missing | Won't | — | Not applicable: public runtime URLs expose no clone path |

## 10. Publishing, sharing and embedding (PUB)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| PUB-01 | Publish creates an immutable FormVersion (with server validation of rules, regexes and URLs) | Live form updates in place | Missing | P1 | M | Fixed decision. Submissions reference `form_version_id` |
| PUB-02 | Public runtime app (`apps/runtime`): fast first render, cache-friendly, server-checked access | jotform.com hosted form | Missing | P1 | L | Renders `packages/renderer`. No secrets in the version JSON |
| PUB-03 | Direct link with a custom slug; open in a new tab | `form.jotform.com/<id>`, custom slug | Partial: "Share" copies the builder URL (B24) | P1 | S | Old slugs redirect |
| PUB-04 | Iframe embed | Iframe code | Missing | P1 | S | |
| PUB-05 | Script embed with auto-resize and URL parameter pass-through | Default JS embed | Missing | P1 | M | `packages/sdk`. postMessage resize with origin checks |
| PUB-06 | Lightbox modal, pop-up link, floating feedback button | Lightbox, Feedback button, Pop-up | Missing | P2 | M | SDK modes |
| PUB-07 | QR code (PNG/SVG download) | QR code download | Missing | P2 | S | Generated locally (works air-gapped) |
| PUB-08 | Social share and invite by email | Share buttons, invite by email | Missing | P2 | S | Invites sent by the worker through SMTP |
| PUB-09 | Platform embed guides (WordPress, Wix, Squarespace, Shopify, Webflow) | Publish > Platforms | Missing | P2 | S | Documentation plus snippets. A WordPress plugin is P4 |
| PUB-10 | Custom domain, self-serve (CNAME verification, automatic TLS) | Enterprise only | Missing | P3 | L | ACME / cert-manager. On-prem already serves on the customer's own domain |
| PUB-11 | Inline Shadow-DOM embed (no iframe, inherits host fonts) | Cards "Smart Embed" | Missing | P4 | M | Iframe and script embeds cover the need |
| PUB-12 | Full source code download | Downloadable HTML | Missing | Won't | — | Breaks immutable versions, server validation and security patching |
| PUB-13 | Scheduled reminder emails to fill the form | Daily, weekly or monthly reminders | Missing | P4 | M | Low usage |
| PUB-14 | Assign form to named assignees (submit-only, view later, edit later; sentbox; per-assignee tracking) | Assign Form | Missing | P3 | L | Needs respondent accounts and SSO. Prefilled personal links (PRE-03) cover mid-market cases |
| PUB-15 | Kiosk mode (locked, inactivity reset, PIN exit) | Mobile app kiosk | Missing | P4 | M | A PWA kiosk route later |
| PUB-16 | Offline fill with sync (PWA, IndexedDB queue, idempotent submit) | Mobile app offline | Missing | P4 | XL | Valuable for field data collection in India. After feature match |
| PUB-17 | Native iOS / Android apps and push notifications | Jotform Mobile Forms | Missing | Won't | — | A responsive runtime plus a PWA instead |

## 11. Notifications and email (NOT)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| NOT-01 | SMTP sender configuration per org (host, port, TLS, test email), plus a platform default sender | Account senders: OAuth or custom SMTP | Missing | P1 | M | SMTP adapter (FND-17). Credentials encrypted with KMS |
| NOT-02 | Owner notification email(s) on submission: To/CC/BCC, default answers table, hide empty fields, several per form | Notification email | Missing | P1 | M | Sent through pg-boss. Sensitive fields masked in emails by default (CMP-03) |
| NOT-03 | Autoresponder to the respondent (to an email field), several per form | Autoresponder | Missing | P1 | M | |
| NOT-04 | Merge tags in subject, body, recipients and reply-to; sender name; reply-to from a field | Form field tags, Reply-To | Missing | P1 | S | |
| NOT-05 | Email delivery log with retries | Account History > Emails | Missing | P1 | S | SOC 2 evidence |
| NOT-06 | Rich email template editor: sanitised, preview, test send, action buttons | WYSIWYG, HTML source, Email Copilot | Missing | P2 | M | Uses the same AST as rich text. P1 ships a plain template with tags |
| NOT-07 | Attachments: uploaded files, submission PDF, PDF password, one static file | Attachments tab | Missing | P2 | M | Size caps. Sensitive files sent as links instead |
| NOT-08 | Send on submission edit / "update email" sync | When a Submission is Edited | Missing | P2 | S | |
| NOT-09 | Delayed or scheduled autoresponder (delay, exact time, date field) | Send Email Later | Missing | P2 | M | pg-boss delayed jobs |
| NOT-10 | Conditional recipients and template choice | Change E-mail Recipient condition | Missing | P2 | M | Server-only logic action (`route_email`) |
| NOT-11 | Bounce / suppression list with removal | Bounce List | Missing | P2 | S | |
| NOT-12 | Per-language email templates | Through conditions | Missing | P2 | S | Chosen automatically from the respondent's locale (exceeds) |
| NOT-13 | Daily or weekly digest of submissions | Digest emails | Missing | P4 | S | Low usage |
| NOT-14 | SMS / WhatsApp notifications | Through integrations | Missing | P4 | M | India demand is real, but needs DLT-registered providers. Add after feature match |

## 12. Thank-you pages and endings (END)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| END-01 | Custom thank-you message (rich text) | Thank You Page message | Partial: `successMessage` and the first `thank_you` block. HTML rendered as text (B11) | P1 | S | `<Ending>` block in AST form |
| END-02 | Redirect to an external URL (scheme-validated, same tab) | Redirect | Partial: unvalidated `window.open` in a new tab (S6) | P1 | S | Only `https?:`. Optional per-org allowlist |
| END-03 | Multiple endings and conditional ending or redirect, with field values in the message or URL | Change Thank You Page condition | Missing | P2 | M | Chosen by `evaluate().ending` |
| END-04 | Ending action buttons: fill again, download PDF, edit submission, visit URL, fill another form | Action buttons | Missing | P2 | M | Signed, expiring tokens |
| END-05 | Redirect with HTTP POST of the submission data | Redirect with POST | Missing | Won't | — | Leaks PII to arbitrary endpoints from the browser. Signed webhooks (INT-01) instead |

## 13. Respondent experience (RSP)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| RSP-01 | Mobile-responsive runtime | Responsive | Partial: Tailwind responsive. Signature broken on phones (B5) | P1 | S | |
| RSP-02 | Multi-page flow with progress bar and Back | Page breaks, progress | Partial: paging exists but is broken (B1, B10) | P0 | S | Fixes come from VAL-10 and FND-09 |
| RSP-03 | Save and continue later: draft saved on the server, resume link by email or copy, expiry, "continue or start over" | Save and Continue Later, drafts deleted after 60 days | Missing | P2 | L | Drafts are encrypted like submissions and fall under retention. A draft carries only legitimate-use fields and fields whose consent is already granted ("save for later" is its own disclosed purpose) |
| RSP-04 | Local autosave of in-progress answers (browser) | Autofill (legacy) | Missing | P2 | S | Off by default for forms with sensitive fields, and always off for consent-based fields before consent and for forms with a children policy |
| RSP-05 | Multilingual forms: translations per language, switcher, browser detection, `?lang=`, RTL, completeness meter | 130+ languages, auto-translate | Missing | P2 | L | Ships the 22 Eighth Schedule languages with Noto fonts. The Consent notice language switcher ships earlier, in P1 (CMP-04). Machine translation → RSP-07 |
| RSP-06 | WCAG 2.1 AA renderer (labels, fieldset/legend, ARIA radiogroups, error focus, `aria-describedby`) | Claims WCAG 2.1 AA and Section 508 | Partial: no `htmlFor` or `id`, no `fieldset`, rating buttons without ARIA, `NiceSelect` without keyboard (map §4.4) | P1 | L | Government and enterprise buyers in India (GIGW) need this. axe tests in CI |
| RSP-07 | Machine translation assist for authors | Auto-translate suggestions | Missing | P4 | M | Needs an external MT or LLM API. Air-gapped conflict |
| RSP-08 | Accessibility checker in the builder (alt text, labels, contrast) | Form Accessibility mode | Missing | P2 | M | |
| RSP-09 | Respondent edits their own submission via a signed link | Edit link `/edit/{id}` | Missing | P2 | M | Revision trail (SUB-10). Resubmit re-triggers side effects |
| RSP-10 | Respondent receipt / copy of answers (download PDF on the ending page) | Download PDF action | Missing | P2 | S | Through END-04 and EXP-03 |

## 14. Spam and abuse (SPM)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| SPM-01 | Honeypot field and minimum time to fill | Not documented | Missing | P1 | S | (exceeds) On by default, invisible to respondents |
| SPM-02 | Rate limiting per IP and per form, request size caps | Implicit | Missing | P1 | S | Postgres-backed limiter (no Redis) |
| SPM-03 | Spam quarantine folder with "not spam" restore, and a disposable-email blocklist | Not offered natively | Missing | P2 | M | (exceeds) Local rules, no external ML (air-gapped) |
| SPM-04 | Email verification code (OTP) before submit | Cards "Use verification code" | Missing | P2 | M | Uses the SMTP adapter. SMS OTP is P4 |

Captcha → FLD-29. Unique submission → ACC-07.

## 15. Submissions management (SUB)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| SUB-01 | Submission store: answers keyed by block id, `form_version_id`, idempotency key, metadata | Server store | Missing: answers live only in react-hook-form memory | P1 | L | Encrypted fields per CMP-07. Files stored as references |
| SUB-02 | Submissions grid per form (columns from the version history, pagination, sort) | Tables grid | Missing | P1 | M | Columns are the union of keys across versions |
| SUB-03 | Submission detail view (inbox-style reader, read/unread, star) | Inbox | Missing | P1 | M | Every submission read is audited (detail, grid page, API, export, download), not only sensitive ones (CMP-02) |
| SUB-04 | Full-text search across submissions | Tables and Inbox search | Missing | P1 | M | Postgres FTS. Encrypted fields are excluded or searched through a blind index (CMP-08) |
| SUB-05 | Basic filters: date range, read/unread/starred, spam | Date and status filters | Missing | P1 | S | |
| SUB-06 | Advanced filters by field value or operator (stackable) and saved views (tabs) per user | Advanced filters, tabs, locked filters | Missing | P2 | M | Saved views stored on the server |
| SUB-07 | Column show, hide, reorder, freeze and rename | Column management | Missing | P2 | S | |
| SUB-08 | Bulk actions: select, mark read, archive, delete, export | Bulk actions | Missing | P1 | S | |
| SUB-09 | Owner edit: inline cell edit without side effects, or edit through the form with side effects | Both modes | Missing | P2 | M | Explicit choice in the UI |
| SUB-10 | Per-submission revision trail (who changed what, when) | Not offered for submissions | Missing | P2 | M | (exceeds) Covers the DPDP right to correction and SOC 2 |
| SUB-11 | Request update (email the edit link to the respondent) | Request Update action | Missing | P2 | S | |
| SUB-12 | Archive, and trash with 30-day restore then purge | Archive, trash for 30 days | Missing | P1 | M | Purge runs on pg-boss. Integrates with retention (CMP-06) |
| SUB-13 | Tags, comments and @mentions on submissions | Inbox tags and comments | Missing | P2 | M | |
| SUB-14 | Reply to and forward a submission by email | Inbox reply/forward | Missing | P2 | S | |
| SUB-15 | Assign submissions to teammates, with a status column | Assignee column | Missing | P2 | S | |
| SUB-16 | Uploads gallery and calendar view (bookings, date fields) | Uploads and Calendar views | Missing | P2 | M | Calendar view is needed with appointments (FLD-35) |
| SUB-17 | Per-question summary charts | "Summarize with a chart" | Missing | P2 | M | Shared with ANA-04 |
| SUB-18 | Import submissions from CSV/XLSX with column mapping | Import data | Missing | P2 | M | Also the migration path from JotForm. Imported rows get `received_at` = import time and keep the original date in metadata. Needs a lawful-basis declaration and a retrospective-notice campaign (DPDP s.5(2)) |
| SUB-19 | Incomplete submissions (drafts) view | Incomplete submissions | Missing | P2 | S | With RSP-03 |
| SUB-20 | Pending / failed payments view | Pending payments panel | Missing | P2 | S | With PAY-* |
| SUB-21 | Row actions: re-send email, re-run webhook or integration, send PDF | Action button columns | Missing | P2 | M | |
| SUB-22 | Share the submissions view with roles (viewer, commenter, collaborator) and expiring invites | Table sharing incl. public read-only | Missing | P2 | M | Role-based only. Public anonymous links to PII → Won't (see non-goals) |
| SUB-23 | Live updates (new rows appear without a refresh) | Real-time | Missing | P2 | S | Server-sent events |
| SUB-24 | Cards view, group-by, column lock | Cards view, grouping, Lock Data | Missing | P4 | M | Low daily use |
| SUB-25 | Jotform Tables as a standalone database: formula, lookup and rollup columns, blank tables | Separate product | Missing | Won't | — | An Airtable-style database is a different product. Export and integrations cover it |
| SUB-26 | AI columns and AI data assistant (summarise, categorise, sentiment, chat) | AI columns and assistant | Missing | P4 | L | Needs an LLM provider adapter. Air-gapped needs local models |

## 16. Export, PDF and print (EXP)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| EXP-01 | Export all, selected or filtered submissions to CSV / Excel | Download All | Missing | P1 | M | Async worker job. CSV formula-injection escaping. Every export is audited |
| EXP-02 | Download uploaded files (single and zip) | Download files | Missing | P1 | S | Short-lived signed URLs |
| EXP-03 | Default submission PDF and print view | Automatic default PDF | Missing | P1 | M | Headless Chromium in an isolated worker image with no network, bundled Noto fonts (correct Indic shaping), works air-gapped. No pdf-lib text path: it cannot shape Indic scripts |
| EXP-04 | Bulk PDF export (zip) | Default document zipped and emailed | Missing | P2 | S | |
| EXP-05 | Custom PDF templates: several per form, header/logo, field selection, page size, hide empty | PDF Editor | Missing | P2 | L | Template options on top of EXP-03 |
| EXP-06 | PDF password protection | Fixed password per email | Missing | P2 | S | |
| EXP-07 | Drag-and-drop PDF designer with a large template library | PDF Editor (about 1,900 templates) | Missing | P4 | XL | EXP-05 covers the daily need |
| EXP-08 | Fillable "Smart PDF" forms | Fillable PDF submitted online | Missing | Won't | — | Niche and hard to secure. The web runtime is the channel |
| EXP-09 | Scheduled exports and SFTP drop | Not offered | Missing | P4 | M | On-prem demand. After feature match |

## 17. Analytics and reports (ANA)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| ANA-01 | Form analytics: views, starts, submissions, conversion, average completion time | Form Analytics KPIs | Missing | P1 | M | Renderer `onEvent`. Stored as aggregates with no cookies |
| ANA-02 | Device, browser, OS and country breakdowns | Device, Platform and Location tabs | Missing | P2 | S | Local GeoIP database (works air-gapped). The IP is discarded after lookup |
| ANA-03 | Drop-off funnel by field and page | Not offered | Missing | P2 | M | (exceeds) |
| ANA-04 | Auto-generated summary report (chart per question), shareable with a password, PDF export | Report Builder (auto-generated) | Missing | P2 | L | Reuses SUB-17 charts |
| ANA-05 | GA4 / GTM / Meta Pixel on the runtime | Through widgets | Missing | P2 | S | Opt-in per form, consent-gated, off on air-gapped installs |
| ANA-06 | Drag-and-drop slide report builder (images, shapes, layouts) | Report Builder | Missing | P4 | L | Summary reports cover the daily need |
| ANA-07 | Listing reports (HTML table, grid, RSS, live Excel/CSV URLs) | Reports | Missing | P4 | M | Exports and the API cover it. RSS of PII is not built |
| ANA-08 | Per-visit traffic list with IP address and submitter | Traffic tab | Missing | Won't | — | DPDP data minimisation. Aggregates only |
| ANA-09 | Org-wide usage analytics dashboards | Enterprise admin console | Missing | P3 | M | |

## 18. Workflows, approvals and e-signature (WFL)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| WFL-01 | Approval flow v1: sequential approval steps, approver by email or form field, approve/deny, signed-link action page, outcome emails, status on the submission | Workflows (free on all plans) | Missing | P2 | L | Runs on pg-boss state machine. Each action is audited |
| WFL-02 | If/else and N-way branches in a flow | Condition and branch elements | Missing | P2 | M | Reuses `packages/logic` |
| WFL-03 | Parallel branches and merge; team approval rules (all, any, majority) | Split/Merge, Team Approval | Missing | P3 | M | Mid-market flows are mostly linear |
| WFL-04 | Escalation, expiry, reassign, request more info, reminders | Approval advanced options | Missing | P3 | M | |
| WFL-05 | Task elements, Approve & Sign, flow reports, integration steps in flows | Workflow elements | Missing | P4 | L | |
| WFL-06 | Document e-signature product (upload PDF, signer roles, signing order, audit trail) | Jotform Sign | Missing | P4 | XL | A separate product |
| WFL-07 | Signature field audit metadata (timestamp, IP hash, version hash, consent statement) | Sign audit trail only | Missing | P2 | S | (exceeds) Basic e-sign evidence on the form signature |
| WFL-08 | Aadhaar eSign / DSC signing (Indian IT Act 2000) | Not offered | Missing | P4 | L | (exceeds) Regional differentiator after feature match. Needs an ESP partner |

## 19. Payments (PAY)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| PAY-01 | Gateway adapter framework: hosted fields or checkout only (PCI SAQ-A), webhook reconciliation, idempotency, currency per form, test mode | 35+ gateways, sandbox mode | Missing | P2 | L | Amount computed on the server (LOG-25). Submission is held "pending" until the payment is confirmed |
| PAY-02 | Stripe: cards, Apple Pay / Google Pay, ACH, Link | Stripe and Stripe Checkout | Missing | P2 | M | Fixed decision. SaaS and on-prem with outbound access |
| PAY-03 | Razorpay: UPI, cards, netbanking, wallets | Not supported (only PayU India) | Missing | P2 | M | (exceeds) Fixed decision |
| PAY-04 | Product list: name, price, description, images, quantity, options with prices, single or multiple selection | Product List | Missing | P2 | L | The FLD-34 block |
| PAY-05 | Subscriptions: interval, trial, setup fee, fixed number of payments | Sell Subscriptions | Missing | P2 | M | Stripe Billing and Razorpay Subscriptions. UPI Autopay limits noted |
| PAY-06 | Donations / user-defined amount with suggestions and a minimum | User-defined amount | Missing | P2 | S | |
| PAY-07 | Amount from a calculation | Payment from the calculation widget | Missing | P2 | S | |
| PAY-08 | Coupons: percentage or fixed, product-scoped, usage limits, expiry | Coupons | Missing | P2 | M | Redemption counted atomically |
| PAY-09 | Tax: base rate and by location; GST split (CGST/SGST/IGST) by place of supply | Base tax plus location-based tax | Missing | P2 | M | (exceeds) GST handling |
| PAY-10 | Shipping: per item (first and additional) or per transaction | Shipping tab | Missing | P2 | S | |
| PAY-11 | Receipts and invoices, GST-compliant invoice numbering | Receipts and invoices | Missing | P2 | M | |
| PAY-12 | Stock / inventory with "sold out" and low-stock email | Stock control | Missing | P2 | S | Atomic decrement |
| PAY-13 | Authorise now, capture later | Supported on some gateways | Missing | P4 | S | Low usage |
| PAY-14 | Refund from the submission view | Not documented | Missing | P4 | S | The gateway dashboard covers it |
| PAY-15 | PayPal adapter | PayPal (several variants), Venmo | Missing | P4 | M | Fixed decision limits feature match to Stripe and Razorpay. PayPal is the first adapter to add after that |
| PAY-16 | Long-tail gateway catalogue (Square, Authorize.Net, Mollie, …) | 35+ gateways | Missing | Won't | — | Adding adapters on demand only. Catalogue parity is not a goal |

## 20. Integrations, webhooks and API (INT)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| INT-01 | Webhooks per form: several, HMAC-signed, retries with backoff, delivery log, replay | Webhooks (POST, 30 s timeout) | Missing | P1 | M | (exceeds) Signing and replay. Every webhook declares purposes and is listed as a notice recipient; only fields of those purposes that are granted or legitimate-use are sent. Configuring one needs `data.route`. Works on-prem to internal endpoints |
| INT-02 | Public REST API (forms, versions, questions, submissions, files, webhooks, reports), OpenAPI generated from the zod schemas | REST API (user, forms, questions, properties, submissions, reports, folders) | Missing | P2 | L | The P1 internal API is designed with the same shape |
| INT-03 | API keys with scopes (read / full / per-form), rotation, per-plan rate limits | Read or Full keys, daily limits | Missing | P2 | M | Key use is audited |
| INT-04 | Zapier and Make apps; n8n node (on-prem friendly) | Official Zapier app, Make, Power Automate (Enterprise) | Missing | P2 | M | Covers the long tail of the catalogue |
| INT-05 | Google Sheets sync (append, update on edit) | Real-time sync | Missing | P2 | M | SaaS only (OAuth). Off on air-gapped installs |
| INT-06 | Cloud storage: Google Drive, Dropbox, OneDrive (PDF and uploads, subfolder per submission) | Drive, Dropbox, OneDrive, Box | Missing | P2 | M | Box → INT-12 |
| INT-07 | Slack and Microsoft Teams notifications | Communication integrations | Missing | P2 | S | |
| INT-08 | Email marketing: Mailchimp | Mailchimp and 60 others | Missing | P2 | S | Respects consent (CMP-04): sync only rows with marketing consent |
| INT-09 | CRMs: HubSpot, Salesforce, Zoho CRM (field mapping, create or update) | 186 CRM integrations | Missing | P2 | L | Zoho is included for the Indian market |
| INT-10 | Integration framework: OAuth connection store, field mapping UI, run log, retry | Per-form integrations tab | Missing | P2 | L | Prerequisite for INT-05 to INT-09 |
| INT-11 | Calendar sync for appointments (Google, Microsoft busy-blocking and event creation) | Google/Outlook/Calendly sync, Meet/Teams links | Missing | P2 | M | SaaS only. CalDAV/Exchange for on-prem later. Auto video links P4 |
| INT-12 | Airtable, monday.com, Asana, Trello, Notion, Box and the rest of the catalogue | 1,000+ directory entries | Missing | P4 | L | Zapier, Make and n8n cover them in feature match |
| INT-13 | Official TypeScript SDK (`packages/sdk`) | Node.js, PHP, Python and 7 more SDKs | Missing | P2 | S | Other languages P4 (generated from OpenAPI) |
| INT-14 | Custom field-type plugin SDK for third parties | Widget marketplace | Missing | P4 | L | After the registry stabilises |
| INT-15 | MCP server for AI assistants | `mcp.jotform.com` | Missing | P4 | M | Thin layer over INT-02 |
| INT-16 | Microsoft Power Automate connector | Enterprise | Missing | P3 | M | |
| INT-17 | OAuth apps for third-party developers | JS SDK login | Missing | P4 | M | |

## 21. Accounts, workspace, teams and plans (WSP)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| WSP-01 | Sign-up and sign-in: email/password, magic link, Google/Microsoft OAuth, sessions, password reset | Account login | Missing | P1 | M | OAuth is SaaS only |
| WSP-02 | Organisations (tenants) and member invites | Teams with shared workspaces (plan availability to re-verify) | Missing | P1 | M | Multi-user from day one |
| WSP-03 | Basic roles: Owner, Admin, Editor, Viewer | Teams roles | Missing | P1 | M | Enforced in the API and by RLS |
| WSP-04 | Full role model: Team Admin, Creator (no data access), Data Collaborator, Data Viewer; per-form sharing | Four team roles | Missing | P2 | M | Separating form editing from data access matters for DPDP. Routing data out (webhooks, integrations, recipients, attachments, redirects that pipe answers) needs `data.route`, held only by roles with data access |
| WSP-05 | Team workspaces with team-owned assets; assets stay when a member leaves; ownership transfer | Teams | Missing | P2 | M | |
| WSP-06 | Forms list: search, sort, favourite, clone, archive, trash/restore | My Workspace | Missing | P1 | M | |
| WSP-07 | Labels / folders for assets | Labels and sublabels | Missing | P2 | S | |
| WSP-08 | TOTP 2FA with recovery codes | 2FA | Missing | P1 | M | SOC 2. Org-wide enforcement → ENT-07 |
| WSP-09 | Org defaults: locale, time zone, date format (en-IN, IST, DD-MM-YYYY) | Account settings | Missing | P1 | S | |
| WSP-10 | Plans, quotas and metering (forms, submissions, views, storage, fields per form) with a usage page | Per-plan limits, `/user/usage` | Missing | P1 | M | SaaS only. Disabled by the edition flag on-prem |
| WSP-11 | Billing: Stripe Billing and Razorpay for INR, GST invoices | Plan billing | Missing | P1 | M | |

## 22. Enterprise and administration (ENT)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| ENT-01 | SAML / OIDC SSO through BoxyHQ SAML Jackson: several IdPs, SP and IdP initiated, single logout | Enterprise SAML | Missing | P3 | L | Fixed decision. Enterprise-only at JotForm |
| ENT-02 | JIT provisioning and SCIM (users and groups) | JIT, SCIM (Okta) | Missing | P3 | M | |
| ENT-03 | LDAP / Active Directory for on-prem | Not offered | Missing | P3 | M | (exceeds) Fixed decision: later |
| ENT-04 | SSO-protected forms (respondents must sign in) and SSO attribute prefill | Enterprise | Missing | P3 | M | |
| ENT-05 | Admin console: users, seats, force logout, all-assets view, org-wide submission search | Admin Console | Missing | P3 | XL | |
| ENT-06 | Activity log UI: filters, CSV export, SIEM streaming (syslog/OTLP) | Enterprise Activity Log | Missing | P3 | M | Capture ships in P1 (CMP-02). Internal access only until then |
| ENT-07 | Security policies: enforce 2FA, session timeout, password policy, IP allowlist | 2FA enforcement, session timeout | Missing | P3 | M | (exceeds) IP allowlist |
| ENT-08 | Org-wide SMTP senders: default or required sender, restrict personal senders | Server-wide senders | Missing | P3 | S | Per-org SMTP already ships in P1 (NOT-01) |
| ENT-09 | Admin control of allowed field types, integrations and gateways | Form Builder Customization | Missing | P3 | S | |
| ENT-10 | White-label: login pages, logos, favicons, email chrome | Enterprise white-label | Missing | P3 | M | |
| ENT-11 | SaaS data residency regions and dedicated single-tenant SaaS | Dedicated instance in 19 data centres | Missing | P3 | L | The India region is P1 (CMP-16). On-prem covers sovereignty (FND-18) |
| ENT-12 | Admin views of integrations and email logs org-wide | Connections tab | Missing | P3 | S | |
| ENT-13 | HIPAA mode and BAA | Gold and Enterprise | Missing | P4 | L | India-first compliance (DPDP, SOC 2). Revisit for US healthcare demand |
| ENT-14 | FedRAMP / StateRAMP / TX-RAMP authorisations | Jotform Government | Missing | Won't | — | US government market is not a target |

## 23. Compliance primitives: SOC 2 and DPDP Act 2023 + Rules 2025 (CMP, ours)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| CMP-01 | Postgres row-level security per `org_id`, with tenant-isolation tests | Not exposed | Missing | P1 | M | Policies written with the first table in P0. Testcontainers suite |
| CMP-02 | Append-only, hash-chained audit log: auth, builder changes, publish, every submission read/export/edit/delete, denied and failed actions, admin and support access | Enterprise activity log | Partial: capture, chain, checkpoints, verify and archive (WP-1.04, [architecture §2.7](03-architecture.md)), with denied and failed API requests and audited submission reads. Emitters for auth, builder, publish and admin events come with their WPs; the UI is ENT-06 | P1 | M | SOC 2 CC7 and DPDP Rule 6. Denied events are written outside the rolled-back transaction. Kept 13 months online. UI → ENT-06 |
| CMP-03 | PII classification per field (none / personal / sensitive), registry defaults, data inventory per form, taint propagation to derived values | Not offered | Missing | P1 | M | (exceeds) Drives masking, encryption, retention and export warnings. "Sensitive" is a product protection tier, not a DPDP category. Calculations, copies, variables and pipes inherit the highest classification they read unless explicitly declassified |
| CMP-04 | DPDP Consent block: standalone notice with itemised data and purposes, how to withdraw, how to exercise rights, how to complain to the Board; separate unbundled checkboxes; notice hash over the fully rendered notice per locale; consent record; notice language switcher (English or any Eighth Schedule language) | Terms widget only | Missing | P1 | L | (exceeds) Platform is the Processor and the customer is the Fiduciary (DPDP s.5–6, Rule 3). P1 ships English + Hindi notices and a "request this notice in another language" workflow; all 22 languages by P2 week 4. A consent block must precede consent-based fields |
| CMP-05 | Consent withdrawal: one-click signed link on the ending and in the autoresponder, withdrawal record, erasure of consent-only data (subject to the statutory floor), cancellation of scheduled sends and workflows, `consent.withdrawn` webhook; delete calls to integrations once INT-10 exists | Not offered | Missing | P1 | M | (exceeds) DPDP s.6(4), s.6(6), s.8(7)(a). Moved to P1 because the Rules apply from about 13 May 2027, before P2 |
| CMP-06 | Retention policies: per form, org default, purpose-linked, statutory minimums (e.g. PMLA 5 years), inactivity erasure with 48 h notice; auto-delete through pg-boss; trash; legal hold | Auto-delete submissions (Enterprise-promoted) | Missing | P1 | M | (exceeds) Legal hold. Covers JotForm auto-delete. Statutory floor → CMP-23 |
| CMP-07 | Field-level encryption: envelope encryption, KMS adapter (cloud KMS / Vault / keyfile), per-org KEK and purpose DEKs | HIPAA-only field encryption | Missing | P1 | L | Fixed decision. Sensitive-tagged fields are encrypted by default. Erasure is deletion and completes when backups expire (≤ 35 days); real crypto-shredding needs a per-org root key (BYOK, P3) |
| CMP-08 | Blind index (HMAC) for search, uniqueness and DSR lookup on encrypted fields | Filters disabled on encrypted forms | Missing | P2 | M | (exceeds) |
| CMP-09 | DSR tooling v1: find a data principal across forms by email or phone, export (with the disclosures ledger: who received the data), correct, erase; all audited; a PII-coverage matrix enforced by test | Not offered | Missing | P1 | M | (exceeds) Lets the Fiduciary answer DPDP s.11–13 requests. Every responder message carries the privacy contact (Rule 9) |
| CMP-10 | Grievance and DSR intake and tracker: intake form template, due dates (≤ 90 days, Rule 14(3)), overdue alerts, response templates with the privacy contact | Not offered | Missing | P1 | M | (exceeds) Moved to P1 for Rules commencement. Identity confirmation by signed email link in P1; OTP (SPM-04) in P2 |
| CMP-11 | IP and user-agent minimisation: salted hash or truncation, TTL for spam and uniqueness signals, TTL sweep that nulls stored hashes | Stores full IP | Missing | P1 | S | (exceeds) Daily salt for rate limiting; per-form salt for uniqueness (ACC-07); e-sign evidence stores a hash of the evidence, not a bare IP hash |
| CMP-12 | No third-party requests from respondent pages by default (assets, fonts, analytics, captcha) | Third-party widgets and fonts | Partial: external `logoUrl` / `coverUrl` loaded on the respondent page (S7) | P1 | S | (exceeds) Asset store, self-hosted fonts, proof-of-work captcha by default |
| CMP-13 | Children's and guardian data: age gate on the data principal (respondent or subject of the form), verifiable parental consent (Rule 10) by existing verified adult account or manual document review, lawful guardian of a person with disability (Rule 11), Fourth Schedule exemption declaration (Rule 12), `pending_guardian_consent` hold, no tracking | Not offered | Missing | P1 | L | (exceeds) DPDP s.9. Email OTP alone is a contact step, never verification. DigiLocker token → CMP-22 |
| CMP-14 | Breach and incident response: runbook, contact registry per tenant, Processor→Fiduciary notice (preliminary within 24 h of awareness, updates every 24 h), fiduciary tooling for principal notices (Rule 7(1) contents), Board intimation and 72 h report drafts, CERT-In 6 h reporting (SaaS) | Not offered as a feature | Missing | P1 | M | Platform duty as Processor. On-prem: the customer runs the same tooling. CERT-In also needs 180-day ICT logs in India and NTP sync |
| CMP-15 | DPA, sub-processor list, processing records (RoPA export per form and org) | DPA / BAA documents | Missing | P1 | S | |
| CMP-16 | SaaS hosting region in India, DR region in India, sub-processor regions named | US / EU shared servers | Missing | P1 | S | Cross-border transfer is allowed except to restricted countries, but Indian buyers expect India residency. Mumbai ↔ Hyderabad |
| CMP-17 | Org data export and deletion at contract end, with a deletion certificate that states the method and the backup-expiry date | Not documented | Missing | P2 | M | (exceeds) |
| CMP-18 | SOC 2 operational controls: access reviews, break-glass support access with audit, encrypted backups with PITR and restore tests, SBOM, signed images, dependency scanning, incident tabletop, sub-processor change notice, on-prem shared-responsibility (CUEC) matrix and hardening guide | SOC 2 (Enterprise environment) | Missing | P1 | M | Evidence collection for the Type I audit after P1 |
| CMP-19 | Hidden and skipped answers never stored | Excluded | Missing (B3) | P1 | S | Implemented by LOG-25. Listed here for traceability |
| CMP-20 | Integration with a registered DPDP Consent Manager | n/a | Missing | P4 | M | The Consent Manager ecosystem is still forming |
| CMP-21 | Platform as Data Fiduciary for its own users: builder-user notice at sign-up, self-service account export and deletion, privacy contact and grievance route, DPA clause for anonymised cross-tenant statistics (k ≥ 5 distinct orgs), support-access DPA for on-prem bundles | Privacy policy | Missing | P1 | S | Covers `users`, sessions, billing contacts, template usage events |
| CMP-22 | DigiLocker (or other authorised entity) virtual-token adapter for verifiable parental consent | Not offered | Missing | P2 | M | SaaS only. Air-gapped installs use manual document review or existing verified adult accounts |
| CMP-23 | Statutory retention floor: data, traffic data and processing logs kept ≥ 1 year (Rule 6(1)(e), Rule 8(3)) in a restricted hold store with its own DEK, no processing, audited access only | Not offered | Missing | P1 | M | Purge at max(purpose expiry, processed + floor). The erasure response tells the principal why and until when. Counsel to confirm the rule mapping |
| CMP-24 | Notice approval gate: `compliance.approve_notice` permission; publish is blocked when the notice, purposes or lawful bases differ from the last approved version | Not offered | Missing | P1 | S | Every approval is audited. System legal-text updates for consent snippets → TPL-33 |

## 24. AI (AI)

| ID | Feature | JotForm behaviour | fORM- today | Phase | Cx | Notes |
|---|---|---|---|---|---|---|
| AI-01 | Generate a form from a prompt or document | Jotform AI form generator | Missing | P4 | L | Needs an LLM provider adapter (local model for air-gapped). Templates and import cover feature match |
| AI-02 | Chat-based form editing and email copilot | In-builder assistant, Email Copilot | Missing | P4 | M | |
| AI-03 | AI agents (website chat, voice, SMS, WhatsApp) | Jotform AI Agents | Missing | Won't | — | A separate conversational-AI product line |

---

## Summary: rows per phase

Each row is counted once, at its own Phase. The three pointer rows (BLD-13, DSN-03, DSN-09) are not counted.

| Domain | P0 | P1 | P2 | P3 | P4 | Won't | Total |
|---|---|---|---|---|---|---|---|
| Platform foundation (FND) | 16 | 4 | 0 | 0 | 0 | 0 | 20 |
| Builder UX (BLD) | 6 | 2 | 7 | 0 | 2 | 0 | 17 |
| Templates (TPL) | 3 | 8 | 13 | 5 | 2 | 2 | 33 |
| Field types (FLD) | 10 | 6 | 27 | 0 | 6 | 1 | 50 |
| Common field properties (PROP) | 5 | 0 | 9 | 0 | 1 | 0 | 15 |
| Validation (VAL) | 4 | 2 | 7 | 0 | 0 | 0 | 13 |
| Logic & calculations (LOG) | 0 | 1 | 23 | 0 | 1 | 0 | 25 |
| Prefill & piping (PRE) | 0 | 1 | 3 | 0 | 2 | 0 | 6 |
| Design & theming (DSN) | 1 | 2 | 4 | 0 | 1 | 1 | 9 |
| Access, status & limits (ACC) | 0 | 6 | 3 | 1 | 0 | 1 | 11 |
| Publishing & embed (PUB) | 0 | 5 | 4 | 2 | 4 | 2 | 17 |
| Notifications & email (NOT) | 0 | 5 | 7 | 0 | 2 | 0 | 14 |
| Endings (END) | 0 | 2 | 2 | 0 | 0 | 1 | 5 |
| Respondent experience (RSP) | 1 | 2 | 6 | 0 | 1 | 0 | 10 |
| Spam & abuse (SPM) | 0 | 2 | 2 | 0 | 0 | 0 | 4 |
| Submissions management (SUB) | 0 | 7 | 16 | 0 | 2 | 1 | 26 |
| Export, PDF & print (EXP) | 0 | 3 | 3 | 0 | 2 | 1 | 9 |
| Analytics & reports (ANA) | 0 | 1 | 4 | 1 | 2 | 1 | 9 |
| Workflows & e-sign (WFL) | 0 | 0 | 3 | 2 | 3 | 0 | 8 |
| Payments (PAY) | 0 | 0 | 12 | 0 | 3 | 1 | 16 |
| Integrations & API (INT) | 0 | 1 | 11 | 1 | 4 | 0 | 17 |
| Accounts, teams & plans (WSP) | 0 | 8 | 3 | 0 | 0 | 0 | 11 |
| Enterprise & admin (ENT) | 0 | 0 | 0 | 12 | 1 | 1 | 14 |
| Compliance (ours) (CMP) | 0 | 20 | 3 | 0 | 1 | 0 | 24 |
| AI (AI) | 0 | 0 | 0 | 0 | 2 | 1 | 3 |
| **Total** | **46** | **88** | **172** | **24** | **42** | **14** | **386** |

**Feature match is done when every P0, P1 and P2 row has shipped: 306 rows** (P0 46, P1 88, P2 172).

**Changes in v1.1** (see `05-review-log.md`): +33 TPL rows; BLD-13, DSN-03 and DSN-09 became pointers; CMP-05, CMP-10 and CMP-13 moved from P2 to P1 for DPDP Rules commencement; new rows CMP-21 to CMP-24, TPL-32 and TPL-33.

## Explicit non-goals for feature match

1. **Widget marketplace parity.** That means about 700 iframe widgets (FLD-41, FLD-42). We build the most-used widgets natively instead: repeating group, image choice, terms, take photo, unique ID, page URL, searchable dropdown, calculation.
2. **Template volume parity.** JotForm has over 20,000 templates. Our target is about 150 curated ones (TPL-12).
3. **Payment-gateway catalogue parity.** JotForm has 35+ gateways. Feature match covers Stripe and Razorpay (fixed decision). PayPal is the first adapter after that (PAY-15, PAY-16).
4. **Integrations directory parity.** JotForm lists 1,000+ entries. Feature match has about 10 native integrations plus Zapier, Make, n8n and webhooks (INT-12).
5. **Jotform Tables as a standalone spreadsheet database.** Formula, lookup and rollup columns and blank tables are out (SUB-25).
6. **Jotform Sign as a document-signing product.** Feature match covers the signature field with audit metadata only (WFL-06, WFL-07).
7. **Advanced workflow features.** Parallel branches, team approval rules, escalation and task boards are out. Linear approvals with branches are in (WFL-03 to WFL-05).
8. **Native mobile apps, kiosk mode, offline sync and push notifications** (PUB-15 to PUB-17).
9. **AI features.** This covers form generation, AI columns, the data assistant and multichannel AI agents (AI-*, SUB-26).
10. **Enterprise identity and administration.** SAML/OIDC SSO, SCIM, LDAP, the admin console, white-label, enforced brand kits (TPL-24), template locks (TPL-23), custom domains, dedicated regions, end-to-end encrypted forms and forms that require login are all deferred to P3.
11. **US-specific regulated offerings.** HIPAA/BAA is P4. FedRAMP, StateRAMP and TX-RAMP are Won't.
12. **Things we will not copy for security or DPDP reasons:**
    - downloading the full form source code (PUB-12)
    - redirect with HTTP POST of answers (END-05)
    - per-visit IP traffic logs (ANA-08)
    - public anonymous links to submission data (SUB-22 is role-based only)
    - fillable Smart PDFs (EXP-08)
    - the theme store marketplace (DSN-10)
13. **Pixel-level designer parity.** JotForm's Advanced Designer, the drag-and-drop PDF designer and the slide report builder are out (DSN-08, EXP-07, ANA-06). Design tokens, custom CSS, PDF templates and summary reports cover the daily need.
14. **Real-time CRDT co-editing.** Optimistic locking with presence is the feature-match bar (BLD-14, BLD-16).
