# Form schema v2

**Status:** v2.1, revised after the compliance and feasibility reviews (`05-review-log.md`). **Package:** `@form/schema` (`packages/schema/src/v2.ts`), with the zod twins in `v2.zod.ts`.
**Verification:** the TypeScript in §2 type-checks with TypeScript 6.0.3 under `--strict --exactOptionalPropertyTypes --noUnusedLocals` with no errors. A companion negative-test file has five `@ts-expect-error` checks that all still fail as intended:
- a server-only action inside `Rule<ClientAction>`;
- a JS number given as a `number` answer;
- a literal email address used as a template recipient;
- `dropAnswersWithoutConsent: false` (storing answers without consent is not configurable);
- a server-only rule step in the runtime plan.

**Related documents:** feature matrix (`01-feature-matrix.md`), architecture (`03-architecture.md`), delivery plan (`04-delivery-plan.md`), templates spec (`06-templates.md`).

---

## 1. How this schema was chosen

Three candidate designs were scored. Weights: expressiveness 20%, determinism 20%, compliance 20%, migration 10%, builder ergonomics 15%, simplicity 15%.

| Criterion | D1 jsonschema-aligned | D2 builder-UX-first | D3 compliance-runtime-first |
|---|---|---|---|
| Expressiveness vs the P0–P2 matrix | 9 | 8 | 9 |
| Client/server determinism | 8 | 7 | **9** |
| Compliance (DPDP / SOC 2) | 7 | 7 | **10** |
| Migration from v1 | 7 | **9** | 7 |
| Builder ergonomics | 7 | **9** | 6 |
| Simplicity | 7 | **8** | 6 |
| **Weighted** | **7.6** | **7.85** | **8.1** |

**Design 3 is the base**, with structural grafts from Design 1 and authoring and migration grafts from Design 2.

**Kept from D3 (base):** `PrivacyConfig`, `Purpose`, `LawfulBasis` and `FieldCompliance`, all mandatory; consent items that are never pre-ticked; `CompiledForm` with a stored plan, engine versioning (`logic@2`), the page-order rule, a frozen clock and a total evaluator; `FormOps` as the live layer; the edition `Capability` list; deterministic id remapping in `instantiate` (`uuidv5(seed, sourceId)`); explicit `initiallyHidden`.

**From D1:** the envelope plus `config` with `BlockConfigMap`, `AnswerValueMap` and `FieldRegistry` and their exact-key compile checks; the collapsed choice catalogue (`single_choice` / `multi_choice` + `display`); answers tagged by type; the `ACTION_SCOPE` split checked at compile time; `PublishIssue`, `AnswerCodec`, notification `variants`.

**From D2:** TipTap-compatible rich text (`InlineDoc` / `RichDoc`, `PipeNode`, `SubmissionRef`); option `code`; `UnsupportedBlock`; `show_options` / `hide_options`; the typed `options` operand; `startNewRow`; the concrete migration rules.

**From the templates spec:** the `var` node and brand refs; `Origin` stamps; the 7-kind `TemplateVersionPayload`; `LockSpec`, `BrandKit`, `OrgProfile`, bindings, lineage and the variables snapshot; diff items; the `.formpack` manifest; `ConsentConfig.noticeVersion` shared with template versions.

**Dropped:** D3's stored expression `source` text (the builder prints the AST instead); D3's display-dependent answer tags; D2's five separate choice types; D1's fixpoint pass cap.

### 1.1 What changed in v2.1 (review fixes)

| Area | Change | Review item |
|---|---|---|
| Children's data | `ChildrenDataPolicy` gains `subject` (respondent or subject of the form), a `lawful_guardian` mode (Rule 11), an `exempt` mode (Rule 12) and `GuardianConsentConfig` with real verification methods; email OTP is only a contact step. New status `pending_guardian_consent`; `ConsentRecord.vpc` stores evidence | C-B2, F-6 |
| Retention | `RetentionRule` adds `statutory` (may extend) and `inactivity`; a platform statutory floor applies on top; `retention.statutoryHoldUntil` | C-B3, C-m21 |
| Notices | `FiduciaryInfo` gets `privacyContact`, optional `dpo`, required `rightsUrl` and `boardComplaintInfo`; `withdrawalText` is required in dpdp mode; `noticeVersion` and `noticeHash` cover the fully rendered notice per locale; invariant I14 puts consent before consent-based fields | C-M2, C-M4, C-m6 |
| Consent | `dropAnswersWithoutConsent` is the literal `true`; `ConsentRecord.source` adds `consent_manager` | C-M3, C-m10 |
| Legitimate uses | `LegitimateUseGround` is one value per s.7 clause | C-m7 |
| Derived data | Invariant I13 (taint), `CompiledForm.taint`, `declassify`, encrypted computed values (`EncryptedScalar`), repeating-group children stored as `StoredAnswer` | C-M14, F-30 |
| Purpose gating | `purposeIds` is required on notifications, webhooks and integrations; webhook default is `all_in_purposes` | C-M15 |
| Disclosures | New `Disclosure` ledger type | C-M6 |
| Aadhaar | Preset renamed `in_aadhaar_last4`: last 4 digits only, no checksum | C-M16, F-38 |
| Determinism | `PlanStep` splits into `ClientRuleStep` / `ServerRuleStep`; runtime projection keeps `reads` and drops server rule steps; `on_path` steps; I8 is transitive and covers validation bounds; client clock frozen at `startedAt`; `SubmissionRequest.client` carries `pageUrl`, `referrer`, `device` | F-16–F-19 |
| Labels | `LabelText = string \| PlainTemplate` for options, matrix rows, page titles, nav and submit labels (piping and variables) | F-36 |
| Status names | `RuntimeStatus` uses `not_yet_open` and `password`; no `quarantined` screen | F-39 |
| Versions | `FormOps.acceptPreviousVersionsHours` (default 72) defines when `version_superseded` applies | F-34 |
| Templates | Email roles `dsr_response`, `breach_notice`, `guardian_consent_request`; `TemplateForkBinding` (TPL-32); `rejected` is terminal; `OrgProfileTextField` widens localised fields | C-M21, F-40, F-46 |
| Signatures | `SignatureValue.audit.evidenceHash` replaces a bare IP hash | C-m9 |
| Wording | No "crypto-shred" claims: deleting a DEK is not erasure while backups hold it | C-M1, F-31 |

---

## 2. Final TypeScript definitions (`packages/schema/src/v2.ts`)

This is the verified file in full. In the package it is split by section; every exported type has a zod twin with a `z.infer<> === T` assertion test.

```ts
/**
 * packages/schema/src/v2.ts — fORM- FORM SCHEMA v2 (v2.1: synthesised, then revised after the
 * compliance and feasibility reviews; see docs/platform/05-review-log.md)
 *
 * One contract for apps/builder, apps/runtime, apps/api, apps/worker and
 * packages/{registry,logic,validation,renderer,sdk,templates-core}. Package scope: @form/*. Pure types; every exported
 * type has a zod twin in ./v2.zod.ts with a `z.infer<> === T` assertion test.
 *
 * Invariants (validateDefinition(def, 'save' | 'publish')):
 *  I1  Ids are opaque, generated once, never derived from text, never reused.
 *      BlockId, PageId and EndingId share ONE namespace per definition.
 *  I2  The answer SHAPE of a block is a function of block.type only (AnswerValueMap).
 *  I3  FieldKey is unique per form (repeating-group children and logic variables included).
 *  I4  Every reference is by id; dangling ids are draft warnings and publish errors.
 *  I5  No HTML anywhere. Rich text is a TipTap/ProseMirror-compatible JSON subset.
 *  I6  No external media URLs (AssetRef only). Links are scheme-allowlisted.
 *  I7  Every value-carrying block has `compliance` (classification + purposes).
 *  I8  Visibility / required / enabled / option-visibility / page jumps / validation bounds
 *      (e.g. DateBound {kind:'field'}) may read only blocks on the SAME or EARLIER pages, and
 *      this holds TRANSITIVELY through every cell they read (page-order rule). Calculations,
 *      variables, endings and server actions may read anything.
 *  I9  Unanswered === key absent. Never '' / null / [] in Answers.
 *  I10 Logic evaluation is a pure, total function of (version, answers, meta).
 *  I11 A published FormVersion contains no `var` nodes, no brand refs, no secrets and no
 *      live operational state; the runtime projection also drops server-only actions,
 *      builder notes and template origin stamps.
 *  I12 Array order is canonical (pages, children, options, rules). There is no `order` field.
 *  I13 Taint: a calculation, variable, set_value target or pipe inherits the highest
 *      classification and the union of purposes of every cell it reads; lowering it needs an
 *      explicit `declassify` with a reason (audited).
 *  I14 In a form with a 'dpdp' consent block, that block is on a page before (or the same page
 *      as, and above) the first block whose purposes are consent-based.
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * §0  IDENTIFIERS AND PRIMITIVES
 * ═════════════════════════════════════════════════════════════════════════ */

declare const __brand: unique symbol;
/** Nominal typing, erased at runtime. Ids are plain strings on the wire. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type OrgId = Brand<string, 'OrgId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type UserId = Brand<string, 'UserId'>;
export type FormId = Brand<string, 'FormId'>;
export type FormVersionId = Brand<string, 'FormVersionId'>;
export type SubmissionId = Brand<string, 'SubmissionId'>;

/** Element namespace (unique across the whole definition). uuidv7 or nanoid(12); v1 uuids stay valid. */
export type BlockId = Brand<string, 'BlockId'>;
export type PageId = Brand<string, 'PageId'>;
export type EndingId = Brand<string, 'EndingId'>;

/** Scoped to their parent (unique within it). */
export type OptionId = Brand<string, 'OptionId'>;
export type MatrixRowId = Brand<string, 'MatrixRowId'>;
export type MatrixColumnId = Brand<string, 'MatrixColumnId'>;
export type GroupRowId = Brand<string, 'GroupRowId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type ProductOptionId = Brand<string, 'ProductOptionId'>;
export type ConsentItemId = Brand<string, 'ConsentItemId'>;
export type PurposeId = Brand<string, 'PurposeId'>;

/** Logic namespace. */
export type RuleId = Brand<string, 'RuleId'>;
export type RuleGroupId = Brand<string, 'RuleGroupId'>;
export type ConditionId = Brand<string, 'ConditionId'>;
export type VariableId = Brand<string, 'VariableId'>;

/** Live (unversioned) server entities referenced from a version. */
export type NotificationId = Brand<string, 'NotificationId'>;
export type NotificationVariantId = Brand<string, 'NotificationVariantId'>;
export type WebhookId = Brand<string, 'WebhookId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type SenderId = Brand<string, 'SenderId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type WorkflowStepId = Brand<string, 'WorkflowStepId'>;
export type PdfTemplateId = Brand<string, 'PdfTemplateId'>;
export type HolidayCalendarId = Brand<string, 'HolidayCalendarId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type FileId = Brand<string, 'FileId'>;
export type FontId = Brand<string, 'FontId'>;

/** Templates namespace. */
export type TemplateId = Brand<string, 'TemplateId'>;
export type TemplateVersionId = Brand<string, 'TemplateVersionId'>;
export type TemplateBindingId = Brand<string, 'TemplateBindingId'>;
export type TemplateCategoryId = Brand<string, 'TemplateCategoryId'>;
export type TemplatePackId = Brand<string, 'TemplatePackId'>;
export type BrandKitId = Brand<string, 'BrandKitId'>;
export type LockId = Brand<string, 'LockId'>;
export type TemplatePartId = Brand<string, 'TemplatePartId'>;

/** Stable machine name `^[a-z][a-z0-9_]{0,63}$` (FND-07). Prefill param, CSV header, API/webhook key. */
export type FieldKey = Brand<string, 'FieldKey'>;

export type Locale = Brand<string, 'Locale'>;            // BCP-47: en-IN, hi-IN, ta-IN, ur-IN (RTL)
export type TimeZone = Brand<string, 'TimeZone'>;        // IANA: Asia/Kolkata
export type CountryCode = Brand<string, 'CountryCode'>;  // ISO 3166-1 alpha-2
export type CurrencyCode = Brand<string, 'CurrencyCode'>;// ISO 4217
/** Exact decimal `^-?(0|[1-9]\d*)(\.\d{1,10})?$`, ≤ 34 significant digits. Never a JS float. */
export type DecimalString = Brand<string, 'DecimalString'>;
/** Integer minor units as a string (paise, cents): '49900' = ₹499.00. */
export type MinorUnits = Brand<string, 'MinorUnits'>;
export type IsoDate = Brand<string, 'IsoDate'>;                  // YYYY-MM-DD
export type IsoTime = Brand<string, 'IsoTime'>;                  // HH:mm (24h wall clock)
export type IsoLocalDateTime = Brand<string, 'IsoLocalDateTime'>;// YYYY-MM-DDTHH:mm, paired with a TimeZone
export type IsoInstant = Brand<string, 'IsoInstant'>;            // RFC 3339 UTC 'Z'
export type Sha256Hex = Brand<string, 'Sha256Hex'>;              // sha256 of RFC 8785 canonical JSON
export type HexColor = Brand<string, 'HexColor'>;                // #rrggbb or #rrggbbaa only
export type EmailAddress = Brand<string, 'EmailAddress'>;
/** https/http only; validated and normalised at save and publish. */
export type SafeUrl = Brand<string, 'SafeUrl'>;
/** SafeUrl | mailto: | tel: — the only link targets rich text may hold (S4). */
export type SafeHref = Brand<string, 'SafeHref'>;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;                 // 0 = Sunday
export type TextAlign = 'left' | 'center' | 'right';

/** Namespaced extension bag; readers ignore, writers and migrations preserve verbatim. */
export type Extensions = { readonly [key: `x-${string}`]: unknown };

/** Platform asset store reference (S3/MinIO adapter). External URLs are unrepresentable (CMP-12, S7). */
export interface AssetRef {
  assetId: AssetId;
  /** Required for content images (RSP-06/08) unless `decorative`. */
  alt?: string;
  decorative?: boolean;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §1  TEMPLATE-AWARE PRIMITIVES (used throughout; full template model in §17)
 * ═════════════════════════════════════════════════════════════════════════ */

/** `org.legal_name`, `brand.primary`, `form.retention_days`, `custom.event_name`. */
export type TemplateVariableName = `${'org' | 'brand' | 'form' | 'custom'}.${string}`;
/** Brand-kit token reference used in theme / email / PDF (§17.3). */
export type BrandToken =
  | 'primary' | 'secondary' | 'accent' | 'background' | 'surface' | 'text' | 'muted' | 'error' | 'success'
  | 'logo' | 'logo_dark' | 'logo_square' | 'favicon' | 'font_heading' | 'font_body' | 'radius';
export interface BrandRef { ref: `brand.${BrandToken}` }

/**
 * Lineage stamp on every block, page, rule, variable, ending, notification, PDF and status
 * screen that came from a template. Invisible to respondents; stripped from the runtime
 * projection; used by the 3-way template diff (§17.6) and lock fingerprints (§17.4).
 */
export interface Origin {
  bindingId: TemplateBindingId;
  /** Id of the same item inside the template version payload. */
  sourceId: string;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  RICH TEXT (FND-08) — TipTap/ProseMirror JSON subset; piping (PRE-02); template vars
 * ═════════════════════════════════════════════════════════════════════════ */

export type ThemeColorToken =
  | 'page' | 'surface' | 'text' | 'muted' | 'accent' | 'accentText'
  | 'inputBg' | 'inputBorder' | 'inputText' | 'error' | 'success';
/** Literal colour, theme token (preferred; survives theme changes) or brand-kit reference. */
export type ColorValue = HexColor | { token: ThemeColorToken } | BrandRef;

export type Mark =
  | { type: 'bold' } | { type: 'italic' } | { type: 'underline' } | { type: 'strike' } | { type: 'code' }
  /** rel="noopener noreferrer nofollow" and target are added by the renderer, never stored. */
  | { type: 'link'; attrs: { href: SafeHref } }
  | { type: 'textColor'; attrs: { color: ColorValue } }
  | { type: 'highlight'; attrs: { color: ColorValue } };

/** Request metadata readable by logic, pipes and expressions. */
export const META_KEYS = [
  'now', 'today', 'locale', 'time_zone', 'device', 'url_param', 'page_url', 'referrer', 'embed_origin',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'is_preview', 'row_index',
] as const;
export type MetaKey = (typeof META_KEYS)[number];

/**
 * Sub-path into a composite answer; the registry declares legal paths and their ComparableKind:
 *   full_name 'prefix'|'first'|'middle'|'last'|'suffix'   address 'line1'|…|'country'
 *   phone 'e164'|'country'   single/multi_choice 'other'|'score'|'count'|'labels'
 *   matrix '<rowId>'|'<rowId>.<colId>'   time 'start'|'end'   appointment 'start'|'end'
 *   payment 'total'|'subtotal'|'tax'   file_upload 'count'   consent '<consentItemId>'
 *   repeating_group 'count'
 */
export type AnswerPath = string;

/** Readable values. `row:'current'` binds to the same repeating-group row inside a row-scoped rule. */
export type ValueRef =
  | { kind: 'answer'; blockId: BlockId; path?: AnswerPath; row?: 'current' }
  | { kind: 'variable'; varId: VariableId }
  | { kind: 'meta'; key: MetaKey; name?: string };

/** Only valid after submit (endings, emails, PDFs, webhooks). Rejected in labels. */
export interface SubmissionRef {
  kind: 'submission';
  key: 'unique_id' | 'submission_id' | 'submitted_at' | 'edit_url' | 'pdf_url' | 'form_title' | 'withdraw_consent_url' | 'resume_url';
}
export type PipeSource = ValueRef | SubmissionRef;

/** Display formatting (LOG-19). Pure; never changes stored values. */
export type ValueFormat =
  | { kind: 'number'; decimals?: number; grouping?: 'none' | 'indian' | 'international'; decimalSeparator?: '.' | ','; prefix?: string; suffix?: string }
  | { kind: 'money'; currency?: CurrencyCode; grouping?: 'indian' | 'international' }
  | { kind: 'percent'; decimals?: number }
  | { kind: 'date'; pattern: DatePattern }
  | { kind: 'datetime'; pattern: DatePattern; hourCycle: 'h12' | 'h23' }
  | { kind: 'time'; hourCycle: 'h12' | 'h23' }
  | { kind: 'option'; show: 'label' | 'code' }
  | { kind: 'list'; separator: string }
  | { kind: 'text'; transform?: 'none' | 'upper' | 'lower' | 'title' };

export const DATE_PATTERNS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY', 'MMMM D, YYYY'] as const;
export type DatePattern = (typeof DATE_PATTERNS)[number];

export interface PipeAttrs {
  source: PipeSource;
  format?: ValueFormat;
  /** Shown when the source is empty / hidden. Translatable. */
  fallback?: string;
  /** URL contexts only (redirects, buttons): percent-encode the value. */
  encode?: 'none' | 'url';
}
/** Answer piping atom (TipTap "mention"-style). Resolved live in the runtime, server-side in emails/PDFs. */
export interface PipeNode { type: 'pipe'; attrs: PipeAttrs }

/**
 * Template variable atom (§17.2). Allowed in drafts and template payloads; `live` vars stay as
 * nodes until publish resolves them (I11); `bake` vars are substituted at template use.
 */
export interface VarNode { type: 'var'; attrs: { name: TemplateVariableName; fallback?: string } }

export interface TextNode { type: 'text'; text: string; marks?: Mark[] }
export interface HardBreakNode { type: 'hardBreak' }
export type InlineNode = TextNode | HardBreakNode | PipeNode | VarNode;

export interface ParagraphNode { type: 'paragraph'; attrs?: { align?: TextAlign }; content?: InlineNode[] }
export interface HeadingNode { type: 'heading'; attrs: { level: 1 | 2 | 3; align?: TextAlign }; content?: InlineNode[] }
export interface ListItemNode { type: 'listItem'; content: Array<ParagraphNode | BulletListNode | OrderedListNode> }
export interface BulletListNode { type: 'bulletList'; content: ListItemNode[] }
export interface OrderedListNode { type: 'orderedList'; attrs?: { start?: number }; content: ListItemNode[] }
export interface BlockquoteNode { type: 'blockquote'; content: ParagraphNode[] }
export interface HorizontalRuleNode { type: 'horizontalRule' }
export interface ImageNode { type: 'image'; attrs: { asset: AssetRef | BrandRef; widthPct?: number; align?: TextAlign; href?: SafeUrl } }

export type RichBlockNode =
  | ParagraphNode | HeadingNode | BulletListNode | OrderedListNode | BlockquoteNode | HorizontalRuleNode | ImageNode;

/** Multi-block rich text: paragraphs, descriptions, endings, notices. ≤ 20k nodes, depth ≤ 8, lists depth ≤ 3. */
export interface RichDoc { type: 'doc'; content: RichBlockNode[] }
/** Exactly one paragraph: labels, sub-headings, option-free titles. */
export interface InlineDoc { type: 'doc'; content: [ParagraphNode] }

/** Single-line plain template: email subjects, sender names, redirect URLs, unique-ID prefixes, PDF footers. */
export type PlainTemplate = Array<string | { pipe: PipeAttrs } | { var: VarNode['attrs'] }>;
/** Short UI labels (option text, page titles, nav and submit labels, matrix rows) may pipe answers (PRE-02) and hold template vars. */
export type LabelText = string | PlainTemplate;

/* ═══════════════════════════════════════════════════════════════════════════
 * §3  COMPLIANCE PRIMITIVES — SOC 2 + DPDP Act 2023 / Rules 2025
 *     Platform = Data Processor; customer org = Data Fiduciary.
 * ═════════════════════════════════════════════════════════════════════════ */

export type DataClassification = 'none' | 'personal' | 'sensitive';
export type DataCategory =
  | 'contact' | 'identity' | 'government_id' | 'financial' | 'health' | 'biometric'
  | 'location' | 'child' | 'device' | 'free_text' | 'other';

/** CMP-03/06/07/08/09. Required on every value block (I7); defaults come from the field registry. */
export interface FieldCompliance {
  /** 'sensitive' is a product protection tier (encrypt, mask, restrict prefill), NOT a DPDP category. */
  classification: DataClassification;
  category?: DataCategory;
  /** Non-empty when classification !== 'none'; ids resolve in definition.privacy.purposes. */
  purposeIds: PurposeId[];
  /** Envelope encryption at rest with the org DEK. Forced true for 'sensitive'. */
  encrypt: boolean;
  /** HMAC blind index for search / uniqueness / DSR on encrypted values (CMP-08). */
  blindIndex?: boolean;
  /** URL / personalised prefill may target this field. Default false for 'sensitive'. */
  allowPrefill: boolean;
  /** Owner emails, Slack, attached PDFs. Default 'mask' for 'sensitive'. */
  inNotifications: 'include' | 'mask' | 'omit';
  /** CSV/XLSX default; audited opt-in may override 'mask'. */
  inExports: 'include' | 'mask' | 'omit';
  /** Field-level deletion earlier than the submission (must be ≤ effective form retention; statutory floor still applies). */
  retentionDaysOverride?: number;
  /** Data-principal identifier used by DSR lookup (CMP-09). */
  principalIdentifier?: 'email' | 'phone' | 'external_id';
}

/**
 * DPDP s.7 "certain legitimate uses", one value per clause (counsel to confirm wording).
 * s7a lapses for a principal once they indicate non-consent; objections are recorded per principal
 * (server-side) and stop s7a processing for that principal.
 */
export type LegitimateUseGround =
  | 's7a_voluntarily_provided_for_specified_purpose' | 's7b_state_subsidy_benefit_service_licence'
  | 's7c_state_function_or_sovereignty' | 's7d_disclosure_to_state_under_law' | 's7e_judgment_order_or_foreign_claim'
  | 's7f_medical_emergency' | 's7g_epidemic_or_public_health' | 's7h_disaster_or_public_order' | 's7i_employment';

export type LawfulBasis =
  | { kind: 'consent' }
  | { kind: 'legitimate_use'; ground: LegitimateUseGround; justification: string };

/**
 * Purpose retention. A platform statutory floor (default 365 days, DPDP Rules 6(1)(e) and 8(3)) applies on
 * top: data whose purpose expires earlier moves to the restricted statutory-hold store until the floor.
 */
export type RetentionRule =
  | { kind: 'days'; days: number }                     // 1..3650
  | { kind: 'until_purpose_served'; maxDays: number }  // hard cap required
  | { kind: 'org_default' }
  /** Sectoral minimum that may EXTEND retention beyond the purpose (e.g. PMLA / RBI KYC 5 years). */
  | { kind: 'statutory'; years: number; citation: string }
  /** Third Schedule classes: erase after inactivity, notify the principal 48 h before. */
  | { kind: 'inactivity'; days: number; noticeHours: 48 };

/** Declared in the notice, so it is versioned with the form. */
export interface Purpose {
  id: PurposeId;
  name: string;
  description: InlineDoc;
  lawfulBasis: LawfulBasis;
  retention: RetentionRule;
  /** Gates marketing integrations (INT-08) and withdrawal propagation (CMP-05). */
  marketing?: boolean;
  /** Downstream recipients declared in the notice; integrations must be listed to receive data. */
  recipients?: string[];
  origin?: Origin;
}

/** Defaults to org-profile template variables (`org.legal_name`, `org.privacy_contact.*`), resolved at publish. */
export interface FiduciaryInfo {
  legalName: PlainTemplate;
  contactEmail: PlainTemplate;
  /** s.8(9): business contact of a DPO (SDFs) or of a person able to answer questions; included in every rights response (Rule 9). */
  privacyContact: { name: PlainTemplate; email: PlainTemplate; phone?: PlainTemplate };
  /** Only Significant Data Fiduciaries must appoint a DPO (s.10). */
  dpo?: { name: PlainTemplate; email: PlainTemplate };
  /** s.5(1)(ii)-(iii), Rule 3: how to exercise rights, and how to complain to the Data Protection Board. Required. */
  rightsUrl: PlainTemplate;
  boardComplaintInfo: PlainTemplate;
  noticeUrl?: PlainTemplate;
}

/**
 * Rule 10: verify that the person consenting as parent is an identifiable adult. Email OTP is only a
 * contact step and never satisfies this. Air-gapped installs offer the first two methods only.
 */
export type GuardianVerificationMethod = 'existing_verified_adult_account' | 'manual_document_review' | 'digilocker_token';
export interface GuardianConsentConfig {
  guardianEmailBlockId: BlockId;
  methods: GuardianVerificationMethod[];   // non-empty
  /** Unverified submissions in 'pending_guardian_consent' are deleted after this. */
  expiryHours: number;
  evidenceUploadBlockId?: BlockId;          // manual_document_review
  pageId?: PageId;                          // optional dedicated guardian page
}
/** CMP-13 / DPDP s.9, Rules 10–12. */
export type ChildrenDataPolicy =
  | { mode: 'not_applicable' }
  | {
      mode: 'age_gate';
      /** Whose age is checked: the person filling in the form, or the person the form is about (school admission). */
      subject: 'respondent' | 'subject_of_form';
      dobBlockId: BlockId;
      adultAge: number; // 18 under DPDP
      underAge: { kind: 'block' } | { kind: 'parental_consent'; guardian: GuardianConsentConfig };
      /** Forced: no analytics (incl. field-level events), no local autosave, no pixels for the WHOLE form. */
      disableTrackingForMinors: true;
    }
  /** Rule 11: person with disability who has a lawful guardian. */
  | { mode: 'lawful_guardian'; guardian: GuardianConsentConfig; guardianshipEvidenceBlockId: BlockId; disableTracking: true }
  /** Rule 12 / Fourth Schedule exemption (e.g. educational institution, clinic, creche), declared and audited. */
  | { mode: 'exempt'; fourthScheduleItem: string; justification: string };

export interface PrivacyConfig {
  fiduciary: FiduciaryInfo;
  purposes: Purpose[];
  children: ChildrenDataPolicy;
  /** 'e2e' reserved for P3 (ACC-10); disables server logic for encrypted fields. */
  encryption: { mode: 'server' } | { mode: 'e2e'; publicKeyId: string; alg: 'RSA-OAEP-256+A256GCM' };
  /** Answers whose purposes are all consent-based and not granted are never stored (DPDP s.4, s.6). Not configurable. */
  dropAnswersWithoutConsent: true;
  /** CMP-11. */
  networkSignals: { ipHash: boolean; userAgentHash: boolean; ttlDays: number };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §4  FIELD TYPE CATALOGUE
 * ═════════════════════════════════════════════════════════════════════════ */

/** Respondent inputs whose answers are stored. */
export const INPUT_FIELD_TYPES = [
  'short_text',      // FLD-01 (v1 text)
  'long_text',       // FLD-02
  'full_name',       // FLD-03
  'email',           // FLD-04
  'phone',           // FLD-05
  'address',         // FLD-06
  'number',          // FLD-07 / FLD-08 (display: stepper)
  'url',             // FLD-09
  'single_choice',   // FLD-10/12/14/15 (display: radio | dropdown | image)
  'multi_choice',    // FLD-11/13/15  (display: checkbox | dropdown | image)
  'date',            // FLD-16/17
  'datetime',        // FLD-18
  'time',            // FLD-19 (range mode)
  'rating',          // FLD-20
  'linear_scale',    // FLD-21
  'nps',             // FLD-22
  'ranking',         // FLD-23
  'matrix',          // FLD-24
  'repeating_group', // FLD-25
  'file_upload',     // FLD-26/27 (capture)
  'signature',       // FLD-28
  'hidden',          // FLD-30
  'consent',         // FLD-36 + CMP-04 (mode: terms | dpdp)
  'payment',         // FLD-34 / PAY-*
  'appointment',     // FLD-35
] as const;
/** System-produced, stored, read-only. */
export const COMPUTED_FIELD_TYPES = ['calculation', 'context', 'unique_id'] as const; // FLD-33/31/32
/** Verified then discarded. */
export const TRANSIENT_BLOCK_TYPES = ['captcha'] as const;                           // FLD-29
export const CONTENT_BLOCK_TYPES = ['heading', 'paragraph', 'image', 'divider'] as const; // FLD-44..47
export const CONTAINER_BLOCK_TYPES = ['section'] as const;                            // FLD-48

export type InputFieldType = (typeof INPUT_FIELD_TYPES)[number];
export type ComputedFieldType = (typeof COMPUTED_FIELD_TYPES)[number];
export type TransientBlockType = (typeof TRANSIENT_BLOCK_TYPES)[number];
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];
export type ContainerBlockType = (typeof CONTAINER_BLOCK_TYPES)[number];
/** Carry a value in Answers. */
export type ValueFieldType = InputFieldType | ComputedFieldType;
export type BlockType = ValueFieldType | TransientBlockType | ContentBlockType | ContainerBlockType;

/** Allowed as repeating-group children (no nesting, money, bookings, consent, server-assigned values). */
export type RepeatableBlockType =
  | Exclude<InputFieldType, 'repeating_group' | 'payment' | 'appointment' | 'consent' | 'hidden'>
  | 'calculation' | 'heading' | 'paragraph' | 'divider';

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  BLOCK ENVELOPE (PROP-*)
 * ═════════════════════════════════════════════════════════════════════════ */

/** PROP-08/09. Rows are auto-packed; collapses to one column below 640px. */
export interface BlockLayout {
  width: 'full' | 'half' | 'third' | 'two_thirds';
  /** Force a new row even if the block would fit beside the previous one. */
  startNewRow?: boolean;
  labelAlign?: 'top' | 'left' | 'right';
}

/** PROP-14. Tokens preferred. */
export interface BlockStyle {
  labelColor?: ColorValue; inputTextColor?: ColorValue; inputBg?: ColorValue;
  borderColor?: ColorValue; placeholderColor?: ColorValue;
  labelSizePx?: number;  // 10..48
  inputSizePx?: number;  // 10..32
  labelWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  align?: 'left' | 'center';
}

export interface BlockBase<T extends BlockType> {
  id: BlockId;
  type: T;
  layout?: BlockLayout;
  style?: BlockStyle;
  /**
   * Explicit initial logic state (no implicit "a show rule means hidden"). The builder sets it
   * when an author adds a show rule and shows "Hidden until a rule shows it". Publish warns when
   * true and no show rule targets the block.
   */
  initiallyHidden?: boolean;
  /** DSN-04 scoped CSS hook. */
  className?: string;
  /** Builder-only author note; stripped from the runtime. */
  note?: string;
  origin?: Origin;
  x?: Extensions;
}

export const VALIDATION_ERROR_CODES = [
  'required', 'invalid_format', 'too_short', 'too_long', 'too_few_words', 'too_many_words', 'pattern', 'mask', 'preset',
  'invalid_email', 'email_mismatch', 'email_domain_blocked', 'email_disposable', 'email_not_verified',
  'invalid_phone', 'country_not_allowed', 'invalid_url', 'not_a_number', 'not_integer', 'below_min', 'above_max', 'step',
  'not_in_options', 'too_few_selected', 'too_many_selected', 'other_text_required',
  'invalid_date', 'date_out_of_range', 'date_not_allowed', 'age_out_of_range', 'invalid_time', 'time_out_of_range',
  'file_too_large', 'file_too_small', 'file_type_not_allowed', 'too_many_files', 'too_few_files', 'file_missing', 'file_infected',
  'row_incomplete', 'too_few_rows', 'too_many_rows', 'not_unique', 'slot_unavailable', 'out_of_stock', 'coupon_invalid',
  'payment_required', 'payment_failed', 'amount_changed', 'consent_required', 'captcha_failed', 'blocked_by_rule', 'stale_version',
] as const;
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];
/** VAL-07. Translated as `block:<id>:msg:<code>`. */
export type FieldMessages = Partial<Record<ValidationErrorCode, string>>;

/** PRE-01/03. Effective only when compliance.allowPrefill. Param defaults to `key`; composite `key[part]`. */
export interface PrefillConfig { urlParam?: string; lockWhenPrefilled?: boolean }

/** VAL-11. Server-checked; blind index when encrypted. */
export interface UniqueConstraint { normalize: 'exact' | 'trim_lower' | 'e164' | 'digits'; message?: string }

export interface FieldBase<T extends ValueFieldType> extends BlockBase<T> {
  key: FieldKey;
  label: InlineDoc;
  hideLabel?: boolean;
  description?: RichDoc;            // PROP-02
  /** Static; LOG-10 rules override per evaluation. Must be false for computed types. */
  required: boolean;
  /** PROP-06: shown, kept, submitted, not editable. readOnly+required needs a value source (publish check). */
  readOnly?: boolean;
  /** PROP-07: never rendered, still prefilled / calculated / validated / stored. ≠ logic-hidden (which DROPS the answer). */
  concealed?: boolean;
  /** Initial LOG-11 state; a disabled field's value is not submitted. */
  initiallyDisabled?: boolean;
  autoFocus?: boolean;
  messages?: FieldMessages;
  compliance: FieldCompliance;
  prefill?: PrefillConfig;
  unique?: UniqueConstraint;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  PER-TYPE CONFIGURATION (`config`). registry.configSchema is the zod mirror.
 * ═════════════════════════════════════════════════════════════════════════ */

interface TextChrome { placeholder?: string; prefix?: string; suffix?: string } // PROP-03/15

export const TEXT_PRESETS = [
  'alphabetic', 'alphanumeric', 'numeric', 'no_spaces',
  'in_pan', 'in_gstin', 'in_pincode', 'in_ifsc', 'in_vehicle_reg',
  /** Captures the LAST 4 digits only (no checksum; the full number is never sent or stored). Forces 'sensitive'.
   *  Full-number capture needs the Aadhaar Data Vault adapter (P4, UIDAI-authorised entities only). */
  'in_aadhaar_last4',
] as const;
export type TextPreset = (typeof TEXT_PRESETS)[number];

/** VAL-04: RE2 subset (no backrefs / lookaround), ≤ 256 chars; re2 on the server. */
export interface SafePattern { source: string; flags?: '' | 'i' }
/** PROP-12: '#' digit, '@' letter, '*' either, '[…]' optional tail. Server-enforced. */
export interface InputMask { pattern: string; storeMasked: boolean }

/** Default value: static, piped template (evaluated once on load) or expression. */
export type DefaultText = { kind: 'static'; value: string } | { kind: 'template'; value: PlainTemplate };

export interface ShortTextConfig extends TextChrome {
  defaultValue?: DefaultText;
  minLength?: number; maxLength?: number; // hard cap 10_000
  preset?: TextPreset; pattern?: SafePattern; mask?: InputMask;
}
export interface LongTextConfig {
  placeholder?: string; defaultValue?: DefaultText; rows?: number;
  limit?: { unit: 'characters' | 'words'; min?: number; max?: number }; // VAL-02; chars cap 50_000
  showCounter?: boolean;
}

export const NAME_PARTS = ['prefix', 'first', 'middle', 'last', 'suffix'] as const;
export type NamePart = (typeof NAME_PARTS)[number];
export interface FullNameConfig {
  parts: NamePart[];                 // 'first' always present
  requiredParts: NamePart[];         // default ['first','last']
  prefixInput?: { kind: 'text' } | { kind: 'list'; options: string[] };
  sublabels?: Partial<Record<NamePart, string>>;
  placeholders?: Partial<Record<NamePart, string>>;
}

export interface EmailConfig extends TextChrome {
  defaultValue?: DefaultText;
  confirm?: boolean;
  blockFreeProviders?: boolean;
  blockDisposable?: boolean;         // SPM-03 (bundled list, no lookup)
  allowedDomains?: string[];
  verify?: { enabled: boolean; codeLength: 4 | 6; ttlMinutes: number }; // SPM-04 / ACC-09
}

export interface PhoneConfig {
  placeholder?: string;
  defaultCountry: CountryCode;       // 'IN' for en-IN
  allowedCountries?: CountryCode[];
  showCountrySelect: boolean;
  mask?: InputMask;
}

export const ADDRESS_PARTS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;
export type AddressPart = (typeof ADDRESS_PARTS)[number];
export interface AddressConfig {
  parts: AddressPart[];
  requiredParts: AddressPart[];
  country: { mode: 'any' | 'fixed' | 'list'; default?: CountryCode; allowed?: CountryCode[] };
  /** 'auto' = by country (Indian states/UTs + PIN, US states + ZIP), else free text. */
  stateInput: 'auto' | 'text';
  validatePostalCode: boolean;
  sublabels?: Partial<Record<AddressPart, string>>;
}

export interface NumberConfig extends TextChrome {
  display: 'input' | 'stepper';      // FLD-08
  defaultValue?: DecimalString;
  min?: DecimalString; max?: DecimalString; step?: DecimalString;
  integerOnly?: boolean; allowNegative?: boolean;
  format?: Extract<ValueFormat, { kind: 'number' | 'money' | 'percent' }>;
}

export interface UrlConfig extends TextChrome { defaultValue?: DefaultText; schemes: Array<'https' | 'http'> }

/** Stored answer is the option `id` (FND-07; fixes B15/B16). */
export interface ChoiceOption {
  id: OptionId;
  label: LabelText;                  // translatable `option:<blockId>/<optionId>`; may pipe (PRE-02)
  /** Editable export/integration code (v1 `value` migrates here). Exports default to label. */
  code?: string;
  image?: AssetRef;                  // FLD-15
  score?: DecimalString;             // PROP-13 calculation value / quiz score
  correct?: boolean;                 // LOG-24
  origin?: Origin;
}

/** PROP-10. Materialised into options at insert (ids = official codes) so versions are self-contained. */
export const OPTION_PRESETS = ['countries', 'in_states_uts', 'us_states', 'months', 'weekdays', 'gender', 'yes_no', 'agree_5', 'satisfaction_5', 'languages_in'] as const;
export type OptionPreset = (typeof OPTION_PRESETS)[number];

export interface OtherOption { enabled: boolean; label?: string; placeholder?: string; textRequired: boolean; maxLength?: number }

interface ChoiceCommon {
  options: ChoiceOption[];           // 1..5000
  preset?: OptionPreset;             // provenance only
  other?: OtherOption;
  /** PROP-11: seeded per session so Back keeps order; Other stays last; keepLast pins N options. */
  shuffle?: false | { keepLast: number };
  columns?: 1 | 2 | 3 | 4;
  searchable?: boolean;              // FLD-14 (dropdown display)
  placeholder?: string;
}
export interface SingleChoiceConfig extends ChoiceCommon {
  display: 'radio' | 'dropdown' | 'image';
  defaultOptionId?: OptionId;
}
export interface MultiChoiceConfig extends ChoiceCommon {
  display: 'checkbox' | 'dropdown' | 'image';
  defaultOptionIds?: OptionId[];
  minSelected?: number; maxSelected?: number;  // VAL-06
  exclusiveOptionIds?: OptionId[];             // "None of the above"
}

/** FLD-17. */
export type DateBound =
  | { kind: 'absolute'; date: IsoDate }
  | { kind: 'relative'; offset: number; unit: 'day' | 'week' | 'month' | 'year' }   // from meta.today in form tz
  | { kind: 'field'; blockId: BlockId; offsetDays?: number };   // same or earlier page only (I8)
export interface DateLimits {
  min?: DateBound; max?: DateBound;
  disallowWeekdays?: Weekday[];
  disallowDates?: Array<IsoDate | { from: IsoDate; to: IsoDate }>;
  holidayCalendarId?: HolidayCalendarId;
  age?: { min?: number; max?: number };      // VAL-12, against meta.today in the form tz
}
export interface DateConfig {
  pattern: DatePattern; separator?: '-' | '/' | '.';
  picker: 'calendar' | 'selects' | 'native';
  defaultValue?: { kind: 'today' } | { kind: 'fixed'; date: IsoDate };
  limits?: DateLimits;
}
export interface DateTimeConfig {
  pattern: DatePattern; hourCycle: 'h12' | 'h23'; minuteStep: 1 | 5 | 10 | 15 | 30;
  timeZone: TimeZone | 'respondent';
  defaultValue?: { kind: 'now' };
  limits?: DateLimits;
}
export interface TimeConfig {
  hourCycle: 'h12' | 'h23'; minuteStep: 1 | 5 | 10 | 15 | 30;
  period?: 'any' | 'am_only' | 'pm_only';
  window?: { from?: IsoTime; to?: IsoTime };
  defaultValue?: { kind: 'now' } | { kind: 'fixed'; time: IsoTime };
  /** answer.end is present iff range is enabled. */
  range?: { enabled: boolean; minMinutes?: number; maxMinutes?: number };
}

export interface RatingConfig { max: number /* 1..10, B28 */; icon: 'star' | 'heart' | 'thumb' | 'smiley' | 'number'; lowLabel?: string; highLabel?: string; defaultValue?: number }
/** No selection when unanswered (B7). */
export interface LinearScaleConfig { min: 0 | 1; max: number /* 2..10 */; lowLabel?: string; midLabel?: string; highLabel?: string }
export interface NpsConfig { lowLabel?: string; highLabel?: string }
/** Answer exists only after interaction (B8). */
export interface RankingConfig { options: ChoiceOption[]; shuffle?: boolean; rankTop?: number }

export interface MatrixRow { id: MatrixRowId; label: LabelText }
export type MatrixColumn =
  | { id: MatrixColumnId; label: string; input: 'choice'; score?: DecimalString }
  | { id: MatrixColumnId; label: string; input: 'checkbox'; score?: DecimalString }
  | { id: MatrixColumnId; label: string; input: 'text'; maxLength?: number }
  | { id: MatrixColumnId; label: string; input: 'number'; min?: DecimalString; max?: DecimalString }
  | { id: MatrixColumnId; label: string; input: 'dropdown'; options: ChoiceOption[] };
/** FLD-24. `mode` fixes the answer shape (single: one column per row, multi: many, grid: typed cells). */
export interface MatrixConfig {
  mode: 'single' | 'multi' | 'grid';
  rows: MatrixRow[];                 // ≤ 100
  columns: MatrixColumn[];           // ≤ 20
  requireEach: 'none' | 'row' | 'cell';
  shuffleRows?: boolean;
  mobileLayout?: 'table' | 'accordion';
}

/** FLD-25. Children live in `definition.blocks`; must be RepeatableBlockType. */
export interface RepeatingGroupConfig {
  children: BlockId[];               // 1..30
  minRows: number; maxRows: number;  // maxRows ≤ 200
  initialRows?: number;
  addLabel?: string; removeLabel?: string;
  rowTitle?: PlainTemplate;          // may pipe row-scoped values / meta.row_index
  layout: 'stacked' | 'table';
}

export interface FileUploadConfig {
  minFiles?: number; maxFiles: number;            // ≤ 20
  minFileBytes?: number; maxFileBytes: number;    // ≤ plan cap ≤ 1 GiB
  /** Extension AND sniffed-MIME allowlists; both must match. */
  accept: { extensions: string[]; mimeTypes: string[] };
  capture: 'none' | 'user' | 'environment';       // FLD-27
  stripMetadata: boolean;                         // EXIF/GPS, default true (DPDP)
  scan: 'off' | 'async' | 'required';             // ClamAV adapter; 'required' holds submission
}

export interface SignatureConfig {
  penColor: ColorValue;
  heightPx: number;                  // 80..400; bitmap scaled by devicePixelRatio (B5)
  allowTyped: boolean;               // accessible alternative
  statement?: InlineDoc;             // hashed into the audit record (WFL-07)
}

/** FLD-30. A hidden field always captures something (fixes B26). */
export interface HiddenConfig {
  source:
    | { kind: 'url_param'; name?: string }      // default name = key
    | { kind: 'utm'; param: 'source' | 'medium' | 'campaign' | 'term' | 'content' }
    | { kind: 'static'; value: PlainTemplate }
    | { kind: 'expr'; expr: Expr };
}

/** CMP-04 / FLD-36. One block, two modes, ONE answer shape. */
export interface ConsentItem {
  id: ConsentItemId;
  /** Required for dpdp mode (purpose must have lawfulBasis 'consent'); optional for terms. */
  purposeId?: PurposeId;
  label: InlineDoc;
  /** Only purposes necessary for the service may gate submit (no bundling); publish warns otherwise. */
  requiredToSubmit: boolean;
  /** Type-level guarantee: never pre-ticked. */
  defaultChecked: false;
}
export interface ConsentConfig {
  mode: 'dpdp' | 'terms';
  notice: RichDoc;                   // DPDP s.5 short notice; may hold org.* vars + form.purposes; must include withdrawal, rights and Board text (FiduciaryInfo)
  /** Auto-render the itemised data list per purpose from compiled.dataInventory. */
  itemiseData: boolean;
  /** dpdp: one item per consent-based purpose; terms: exactly one item. */
  items: ConsentItem[];
  /** Required in dpdp mode (s.5(1)(ii)); publish error `notice_incomplete` otherwise. Rendered with the signed withdrawal link. */
  withdrawalText?: InlineDoc;
  presentation: 'checkboxes' | 'scroll_to_agree';
  termsDocument?: AssetRef;
  /**
   * Locales the principal may switch the notice to (s.5(3), s.6(3): English or any Eighth-Schedule
   * language). A language picker is always shown in dpdp mode; unlisted languages can be requested.
   */
  noticeLocales?: Locale[];
  /**
   * Monotonic notice version. Publish bumps it when the hash of the FULLY RENDERED notice changes for any
   * locale: notice text + itemised data inventory + purposes and lawful bases + resolved org.* variables
   * + fiduciary rights/Board text. Shared concept with template versions (§17, templates spec §10.3).
   */
  noticeVersion: number;
}

/**
 * Overrides behavior.spam.captcha for this form. 'platform_default' = proof_of_work in every edition.
 * Third-party providers are opt-in, must be listed in a purpose's `recipients`, and are unavailable air-gapped.
 */
export interface CaptchaConfig {
  provider: 'platform_default' | 'hcaptcha' | 'turnstile' | 'recaptcha_v3' | 'proof_of_work';
  invisible?: boolean;
}

/* Payments (FLD-34 / PAY-*) */
export interface ProductOption {
  id: ProductOptionId; label: string; required: boolean;
  choices: Array<{ id: OptionId; label: string; priceDelta: MinorUnits }>;
}
export interface Product {
  id: ProductId; name: string; description?: RichDoc; images: AssetRef[]; sku?: string;
  pricing:
    | { kind: 'one_time'; amount: MinorUnits }
    | { kind: 'subscription'; amount: MinorUnits; interval: 'day' | 'week' | 'month' | 'year'; intervalCount: number; trialDays?: number; setupFee?: MinorUnits; totalCycles?: number }; // PAY-05
  quantity?: { min: number; max: number; default: number };
  options?: ProductOption[];
  /** PAY-12: counts live in FormOps; this flags enforcement. */
  stockTracked: boolean;
  tax?: { hsnSac?: string; ratePct?: DecimalString; inclusive?: boolean };    // PAY-09
  shipping?: { first: MinorUnits; additional?: MinorUnits };                  // PAY-10 per item
  origin?: Origin;
}
export type PaymentAmountSource =
  | { kind: 'products'; selection: 'single' | 'multiple'; products: Product[]; showImages: boolean }
  | { kind: 'donation'; suggested: MinorUnits[]; min: MinorUnits; max?: MinorUnits; allowCustom: boolean } // PAY-06
  | { kind: 'calculated'; expr: Expr; description: string };                 // PAY-07; resultType money
export interface TaxConfig {
  mode: 'none' | 'flat' | 'gst_in' | 'by_location';
  inclusive: boolean;
  flatRatePct?: DecimalString;
  /** CGST+SGST when place of supply = seller state, else IGST. */
  gst?: { sellerGstin: PlainTemplate; sellerStateCode: string; placeOfSupplyBlockId: BlockId; defaultRatePct: DecimalString };
  byLocation?: Array<{ country: CountryCode; region?: string; ratePct: DecimalString; locationBlockId: BlockId }>;
}
/** At most one payment block per form, on the last visible page (publish check). Credentials live in FormOps. */
export interface PaymentConfig {
  gateway: 'stripe' | 'razorpay';
  currency: CurrencyCode;
  amount: PaymentAmountSource;
  tax?: TaxConfig;
  shipping?: { mode: 'none' | 'per_item' | 'per_order'; perOrder?: MinorUnits };
  couponsEnabled: boolean;           // codes live in FormOps
  showTotal: boolean;
  methods?: Array<'card' | 'upi' | 'netbanking' | 'wallet' | 'apple_pay' | 'google_pay' | 'ach' | 'link'>;
  billing?: { nameBlockId?: BlockId; emailBlockId?: BlockId; phoneBlockId?: BlockId; addressBlockId?: BlockId; gstinBlockId?: BlockId };
  /** Submission stays 'pending_payment' until the gateway webhook confirms. */
  holdUntilPaid: true;
  invoice?: { enabled: boolean; numberPrefix: string };  // PAY-11, server-assigned
}

/** FLD-35. Slot reserved atomically on the server; reminder/ICS jobs run in the worker. */
export interface AppointmentConfig {
  timeZone: TimeZone;
  allowRespondentTimeZone: boolean;
  slotMinutes: number; slotStepMinutes?: number; bufferMinutes: number;
  weekly: Array<{ weekday: Weekday; from: IsoTime; to: IsoTime }>;
  blockedDates?: Array<IsoDate | { from: IsoDate; to: IsoDate }>;
  holidayCalendarId?: HolidayCalendarId;
  minNoticeMinutes: number; rollingDays: number; maxPerDay?: number; capacityPerSlot: number;
  reminders?: Array<{ minutesBefore: number; emailBlockId: BlockId }>;
  calendarConnectionId?: ConnectionId;   // INT-11; secrets server-side
  attachIcs: boolean;
}

/* Computed */
export interface CalculationConfig { expr: Expr; resultType: ExprType; format?: ValueFormat; display: 'visible' | 'hidden'; declassify?: { reason: string } }
export const CONTEXT_SOURCES = ['page_url', 'referrer', 'user_agent', 'started_at', 'submitted_at', 'locale', 'time_zone', 'embed_origin'] as const;
export interface ContextConfig { source: (typeof CONTEXT_SOURCES)[number]; stripQuery?: boolean }
export interface UniqueIdConfig { prefix: PlainTemplate; padTo: number; startAt: number; resetEvery: 'never' | 'year' | 'month'; showOnEnding: boolean }

/* Content and container */
export interface HeadingConfig { level: 1 | 2 | 3; text: InlineDoc; subheading?: InlineDoc; align?: TextAlign }
export interface ParagraphConfig { content: RichDoc }
export interface ImageConfig { image: AssetRef | BrandRef; widthPct: number; align: TextAlign; href?: SafeUrl }
export interface DividerConfig { lineStyle: 'solid' | 'dashed' | 'dotted' | 'none'; color?: ColorValue; spacing: 'sm' | 'md' | 'lg' }
/** FLD-48. Logic target as a unit; hiding hides (and strips) descendants. Also the snippet root (TPL-15). */
export interface SectionConfig {
  title?: InlineDoc; description?: RichDoc;
  children: BlockId[];               // no pages, no payment, sections nest ≤ 2
  collapsible: boolean; initiallyCollapsed?: boolean;
}

/** Type → config. Compile-time exhaustive (below). */
export interface BlockConfigMap {
  short_text: ShortTextConfig; long_text: LongTextConfig; full_name: FullNameConfig; email: EmailConfig;
  phone: PhoneConfig; address: AddressConfig; number: NumberConfig; url: UrlConfig;
  single_choice: SingleChoiceConfig; multi_choice: MultiChoiceConfig; date: DateConfig; datetime: DateTimeConfig;
  time: TimeConfig; rating: RatingConfig; linear_scale: LinearScaleConfig; nps: NpsConfig; ranking: RankingConfig;
  matrix: MatrixConfig; repeating_group: RepeatingGroupConfig; file_upload: FileUploadConfig; signature: SignatureConfig;
  hidden: HiddenConfig; consent: ConsentConfig; payment: PaymentConfig; appointment: AppointmentConfig;
  calculation: CalculationConfig; context: ContextConfig; unique_id: UniqueIdConfig; captcha: CaptchaConfig;
  heading: HeadingConfig; paragraph: ParagraphConfig; image: ImageConfig; divider: DividerConfig; section: SectionConfig;
}
type _ExactKeys<A, B> = [Exclude<keyof A, B>, Exclude<B, keyof A>] extends [never, never] ? true : never;
export const _configComplete: _ExactKeys<BlockConfigMap, BlockType> = true;

/* ═══════════════════════════════════════════════════════════════════════════
 * §7  BLOCK UNIONS AND FIELD REGISTRY CONTRACT (FND-03)
 * ═════════════════════════════════════════════════════════════════════════ */

export type FieldBlockOf<T extends ValueFieldType> = FieldBase<T> & { config: BlockConfigMap[T] };
export type PlainBlockOf<T extends TransientBlockType | ContentBlockType | ContainerBlockType> = BlockBase<T> & { config: BlockConfigMap[T] };

export type FieldBlock = { [T in ValueFieldType]: FieldBlockOf<T> }[ValueFieldType];
export type PlainBlock = { [T in TransientBlockType | ContentBlockType | ContainerBlockType]: PlainBlockOf<T> }[TransientBlockType | ContentBlockType | ContainerBlockType];
export type Block = FieldBlock | PlainBlock;
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

/**
 * Forward compatibility: a reader meeting an unknown `type` keeps it as UnsupportedBlock and
 * writes `raw` back unchanged. Renderer skips; publish rejects; capability check fails closed.
 */
export interface UnsupportedBlock { id: BlockId; type: 'unsupported'; originalType: string; raw: unknown }
export type StoredBlock = Block | UnsupportedBlock;

export type ComparableKind = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'time' | 'choice' | 'choices' | 'boolean' | 'file' | 'none';

export interface SchemaLike<T> { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } }

/** Palette entry: one registry type can appear several times ("Dropdown", "Radio", "Image choice"). */
export interface PaletteEntry<T extends BlockType> {
  id: string;
  category: 'basic' | 'contact' | 'choice' | 'date_time' | 'rating' | 'media' | 'layout' | 'payments' | 'advanced' | 'compliance' | 'snippets';
  labelKey: string;                   // i18n message id
  icon: string;
  keywords: string[];                 // slash-menu search
  configOverrides: Partial<BlockConfigMap[T]>;
}

export interface PublishIssue {
  severity: 'error' | 'warning';
  code:
    | 'duplicate_id' | 'duplicate_key' | 'dangling_ref' | 'logic_cycle' | 'page_order_violation' | 'operator_type_mismatch'
    | 'expr_type_error' | 'expr_too_large' | 'unsafe_regex' | 'invalid_url_scheme' | 'missing_alt_text'
    | 'required_and_disabled' | 'required_and_readonly_without_source' | 'initially_hidden_never_shown'
    | 'unknown_block_type' | 'missing_capability' | 'translation_stale' | 'consent_not_reviewed'
    | 'payment_not_last_page' | 'multiple_payment_blocks' | 'sensitive_prefill' | 'missing_purpose' | 'purpose_without_consent_item'
    | 'bundled_consent' | 'retention_out_of_range' | 'no_ending' | 'empty_page' | 'custom_css_unsafe'
    | 'template_variable_unresolved' | 'brand_ref_unresolved' | 'lock_violation' | 'template_update_required'
    | 'notice_incomplete' | 'consent_after_consent_fields' | 'sensitive_pipe_in_unsafe_context' | 'recipient_not_declared'
    | 'children_policy_incomplete' | 'data_route_not_permitted' | 'validation_bound_page_order';
  path: string;        // JSON pointer
  message: string;
  fixUrl?: string;     // e.g. '/settings/org-profile#privacy_contact'
}

/** The registry is the single source of type knowledge (replaces ~15 hard-coded checks in v1). */
export interface FieldDefinition<T extends BlockType> {
  type: T;
  kind: 'input' | 'computed' | 'transient' | 'content' | 'container';
  capability?: Capability;
  palette: PaletteEntry<T>[];
  configSchema: SchemaLike<BlockConfigMap[T]>;
  defaultConfig(locale: Locale): BlockConfigMap[T];
  /** Registry PII default (CMP-03); authors may raise, never silently lower 'sensitive'. */
  defaultCompliance: T extends ValueFieldType ? FieldCompliance : null;
  answerSchema: T extends ValueFieldType ? (block: BlockOf<T>, state: { required: boolean }) => SchemaLike<AnswerValueMap[T]> : null;
  paths: T extends ValueFieldType ? Readonly<Record<string, ComparableKind>> : Readonly<Record<string, never>>;
  operators: Partial<Record<ComparableKind, readonly LogicOperator[]>>;
  toScalar: T extends ValueFieldType ? (value: AnswerValueMap[T], path?: AnswerPath) => ScalarValue : null;
  isEmpty: T extends ValueFieldType ? (value: AnswerValueMap[T]) => boolean : null;
  translatable(block: BlockOf<T>): TextKey[];
  export: T extends ValueFieldType
    ? { columns(block: BlockOf<T>): Array<{ suffix: string; header: string }>; cells(value: AnswerValueMap[T], block: BlockOf<T>): string[]; text(value: AnswerValueMap[T], block: BlockOf<T>): string }
    : null;
  /** Lockable sub-paths for LockSpec 'content' mode (§17.4). */
  lockableContent(block: BlockOf<T>): string[];
  lint(block: BlockOf<T>, def: FormDefinition): PublishIssue[];
}
/** Adding a BlockType without a registry entry is a compile error. */
export type FieldRegistry = { [T in BlockType]: FieldDefinition<T> };

/* ═══════════════════════════════════════════════════════════════════════════
 * §8  STRUCTURE: pages, endings, welcome
 *     Normalised: blocks live in a map; pages / sections / groups hold ordered child ids.
 *     Parent links are DERIVED by compile() (single source of truth).
 * ═════════════════════════════════════════════════════════════════════════ */

export interface Page {
  id: PageId;
  /** Builder label; also step title when behavior.navigation.showPageTitles. */
  title?: LabelText;
  children: BlockId[];               // top-level blocks in render order
  nav?: { nextLabel?: LabelText; backLabel?: LabelText; showBack?: boolean; showNext?: boolean }; // FLD-49
  initiallyHidden?: boolean;
  origin?: Origin;
}

export type EndingAction =
  | { kind: 'fill_again'; label?: string; prefill: 'none' | { carryKeys: FieldKey[] } }   // PRE-04
  | { kind: 'download_pdf'; label?: string; pdfTemplateId?: PdfTemplateId }               // RSP-10
  | { kind: 'edit_submission'; label?: string }                                           // RSP-09
  | { kind: 'visit_url'; label: string; url: PlainTemplate }
  | { kind: 'open_form'; label: string; formId: FormId; prefill?: Array<{ toKey: FieldKey; from: PipeSource }> };

/** END-01..04. A redirect URL is interpolated server-side, values URL-encoded, result must be https (S6). */
export type Ending =
  | { id: EndingId; kind: 'message'; name: string; content: RichDoc; actions: EndingAction[]; confetti?: boolean; origin?: Origin }
  | { id: EndingId; kind: 'redirect'; name: string; url: PlainTemplate; delayMs?: number; message?: RichDoc; origin?: Origin };

export interface WelcomeScreen { enabled: boolean; content: RichDoc; image?: AssetRef | BrandRef; startLabel?: string } // DSN-05

/* ═══════════════════════════════════════════════════════════════════════════
 * §9  LOGIC (LOG-*) — evaluated by packages/logic in browser, API and worker
 * ═════════════════════════════════════════════════════════════════════════ */

export type Literal =
  | { type: 'text'; value: string }
  | { type: 'number'; value: DecimalString }
  | { type: 'money'; value: MinorUnits; currency: CurrencyCode }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: IsoDate }
  | { type: 'datetime'; value: IsoLocalDateTime; tz: TimeZone }
  | { type: 'time'; value: IsoTime }
  | { type: 'relative_date'; offset: number; unit: 'day' | 'week' | 'month' | 'year' }
  | { type: 'null' };

export type Operand =
  | { kind: 'ref'; ref: ValueRef }
  | { kind: 'literal'; value: Literal }
  /** Typed option picker: UI shows labels, stores ids of `blockId` (never labels). */
  | { kind: 'options'; blockId: BlockId; optionIds: OptionId[] }
  | { kind: 'expr'; expr: Expr };

/** Applicability per ComparableKind comes from the registry; publish rejects mismatches. */
export const LOGIC_OPERATORS = [
  'is_answered', 'is_not_answered',
  'eq', 'neq',                                         // text: case-insensitive + NFC fold by default; choice: set equality
  'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with', 'matches_preset',
  'gt', 'gte', 'lt', 'lte', 'between',                 // number / money / rating — never lexicographic
  'before', 'after', 'on_or_before', 'on_or_after',    // date / time / datetime (UI aliases of lt/gt/lte/gte)
  'includes_any', 'includes_all', 'includes_none',     // choices
  'count_eq', 'count_gte', 'count_lte',                // choices / files / group rows
  'is_true', 'is_false',                               // booleans, consent items
] as const;
export type LogicOperator = (typeof LOGIC_OPERATORS)[number];

export interface Condition {
  kind: 'condition'; id: ConditionId;
  left: Operand; op: LogicOperator; right?: Operand; right2?: Operand /* between, inclusive */;
  caseSensitive?: boolean;
}
/** LOG-07/08. Depth ≤ 5, ≤ 100 leaves. Empty 'all' = true (always); empty 'any' = false. */
export interface ConditionGroup {
  kind: 'group'; id: ConditionId; combinator: 'all' | 'any'; negate?: boolean;
  children: Array<Condition | ConditionGroup>;
}

export type Recipient =
  | { kind: 'email'; address: EmailAddress }        // never allowed inside template payloads
  | { kind: 'field'; blockId: BlockId }
  | { kind: 'member'; userId: UserId }
  | { kind: 'role'; role: 'form_owner' | 'org_admins' | 'team_admins' };

export type ElementTarget = BlockId | PageId;

export type ClientAction =
  | { type: 'show' | 'hide'; targets: ElementTarget[] }                    // LOG-09 (blocks, sections, pages)
  | { type: 'require' | 'unrequire'; targets: BlockId[] }                  // LOG-10
  | { type: 'enable' | 'disable'; targets: BlockId[] }                     // LOG-11
  /** LOG-14/15/16: calculate, copy (expr = ref) or build text. Target is read-only while active. */
  | { type: 'set_value'; target: BlockId; path?: AnswerPath; value: Expr }
  | { type: 'clear_value'; targets: BlockId[] }
  | { type: 'set_variable'; varId: VariableId; value: Expr }               // LOG-20
  /** LOG-13: forward-only, applies when Next is pressed on `from`. */
  | { type: 'skip_to_page'; from: PageId; to: PageId }
  | { type: 'skip_to_end'; from: PageId; endingId?: EndingId }
  | { type: 'set_ending'; endingId: EndingId }                             // END-03, LOG-24
  /** VAL-13 cross-field validation. Blocks Next on `atPage` (or Submit). Message translatable `rule:<id>:<i>`. */
  | { type: 'block_submit'; message: string; atPage?: PageId; anchorBlockId?: BlockId }
  | { type: 'show_options' | 'hide_options'; target: BlockId; optionIds: OptionId[] };

export type ServerAction =
  | { type: 'route_email'; notificationId: NotificationId; field: 'to' | 'cc' | 'bcc' | 'reply_to'; mode: 'add' | 'replace'; recipients: Recipient[] } // NOT-10
  | { type: 'set_email_variant'; notificationId: NotificationId; variantId: NotificationVariantId }
  | { type: 'toggle_effect'; effect: { kind: 'notification'; id: NotificationId } | { kind: 'webhook'; id: WebhookId } | { kind: 'integration'; id: IntegrationId }; enabled: boolean }
  | { type: 'use_pdf_template'; notificationId: NotificationId; pdfTemplateId: PdfTemplateId }
  | { type: 'start_workflow'; workflowId: WorkflowId }                     // WFL-01/02
  | { type: 'tag_submission'; tags: string[] }                             // SUB-13
  | { type: 'assign_submission'; userId: UserId }                          // SUB-15
  | { type: 'mark_spam'; reason: string };                                 // SPM-03

export type Action = ClientAction | ServerAction;
export type ActionType = Action['type'];
export const SERVER_ONLY_ACTION_TYPES = ['route_email', 'set_email_variant', 'toggle_effect', 'use_pdf_template', 'start_workflow', 'tag_submission', 'assign_submission', 'mark_spam'] as const;
export type ServerOnlyActionType = (typeof SERVER_ONLY_ACTION_TYPES)[number];
type _ServerSplitOk = _ExactKeys<{ [K in ServerAction['type']]: 1 }, ServerOnlyActionType>;
export const _serverSplitOk: _ServerSplitOk = true;

export interface Rule<A extends Action = Action> {
  id: RuleId;
  name?: string;                     // LOG-02
  groupId?: RuleGroupId;
  enabled: boolean;
  when: ConditionGroup;
  then: A[];
  /** Applied when `when` is false. */
  else?: A[];
  /** Row scope: instantiated per row; refs with row:'current' bind to that row. */
  scope?: { repeatingGroupId: BlockId };
  origin?: Origin;
}

/** LOG-20 / LOG-24. Recomputed server-side; stored in submission.computed. */
export interface Variable {
  id: VariableId; key: FieldKey; name: string;
  type: ExprType; expr: Expr; format?: ValueFormat;
  persist: boolean;
  /** Taint (I13) is computed by compile(); lowering it needs a reason. */
  declassify?: { reason: string };
  origin?: Origin;
}

export interface LogicModel {
  /** Authored order = tie-break priority (later write wins among writers of the same cell). */
  rules: Rule[];
  ruleGroups: Array<{ id: RuleGroupId; name: string; collapsed?: boolean }>;
  variables: Variable[];
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §10  EXPRESSION AST (LOG-14..19) — typed, total, deterministic, never eval'd
 * ═════════════════════════════════════════════════════════════════════════ */

export type ScalarType = 'number' | 'money' | 'text' | 'boolean' | 'date' | 'time' | 'datetime' | 'duration' | 'option';
export type ExprType = ScalarType | { list: ScalarType } | 'null';

/** Runtime values inside the evaluator. */
export type ScalarValue =
  | { t: 'number'; v: DecimalString }
  | { t: 'money'; v: MinorUnits; currency: CurrencyCode }
  | { t: 'text'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'date'; v: IsoDate }
  | { t: 'time'; v: IsoTime }
  | { t: 'datetime'; v: IsoLocalDateTime; tz: TimeZone }
  | { t: 'duration'; v: { days: number; minutes: number } }
  | { t: 'option'; blockId: BlockId; v: OptionId }
  | { t: 'list'; of: ScalarType; items: ScalarValue[] }
  | { t: 'null' };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '&'                                   // text concatenation
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

export const EXPR_FUNCTIONS = [
  // math
  'abs', 'ceil', 'floor', 'round', 'trunc', 'sqrt', 'pow', 'exp', 'ln', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pi', 'e',
  // aggregates
  'min', 'max', 'sum', 'avg', 'avg_no_zero', 'count', 'count_answered', 'nth',
  // null / flow
  'coalesce', 'is_empty',
  // text
  'concat', 'upper', 'lower', 'trim', 'len', 'left', 'right', 'mid', 'replace', 'contains', 'join', 'comma_separate',
  'format_number', 'to_text', 'to_number',
  // choices
  'option_label', 'option_code', 'option_score', 'selected_count', 'score_sum', 'quiz_score', 'quiz_correct_count', 'nps_category',
  // dates (form time zone; never host clock)
  'today', 'now', 'date_add', 'date_diff', 'age', 'working_days', 'year', 'month', 'day', 'weekday', 'make_date', 'format_date',
  // money
  'money', 'to_minor', 'from_minor', 'money_round', 'gst_split',
  // repeating groups
  'row_count',
] as const;
export type ExprFunction = (typeof EXPR_FUNCTIONS)[number];

export type Expr =
  | { k: 'lit'; value: Literal }
  | { k: 'ref'; ref: ValueRef }
  | { k: 'unary'; op: 'neg' | 'not'; arg: Expr }
  | { k: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { k: 'if'; cond: Expr | ConditionGroup; then: Expr; else: Expr }
  | { k: 'call'; fn: ExprFunction; args: Expr[] }
  | { k: 'list'; items: Expr[] };

export interface ExprFunctionSignature {
  params: Array<ExprType | 'any' | 'block_ref'>;
  rest?: ExprType | 'any';
  returns: ExprType | 'same_as_first';
  /** false for now/today: the evaluator substitutes the frozen meta clock. */
  pure: boolean;
}
export type ExprFunctionTable = Readonly<Record<ExprFunction, ExprFunctionSignature>>;

/* ═══════════════════════════════════════════════════════════════════════════
 * §11  THEME AND BEHAVIOUR (published)
 * ═════════════════════════════════════════════════════════════════════════ */

/** DSN-01..06 → CSS custom properties under `.fr-root`. Values may be brand refs (resolved at publish). */
export interface ThemeTokens {
  colors: Partial<Record<ThemeColorToken, HexColor | BrandRef>>;
  typography: { body: FontId | BrandRef; heading?: FontId | BrandRef; baseSizePx: number }; // self-hosted (DSN-06)
  radius: 'none' | 'sm' | 'md' | 'lg' | 'full' | BrandRef;
  density: 'compact' | 'comfortable' | 'spacious';
  formWidth: 'narrow' | 'normal' | 'wide';
  labelAlign: 'top' | 'left' | 'right';
  inputStyle: 'outlined' | 'filled' | 'underlined';
  progress: 'none' | 'bar' | 'steps' | 'percent';
  logo?: { image: AssetRef | BrandRef; position: 'left' | 'center' | 'right' };
  cover?: { image: AssetRef; heightPx: number };
  background?: { kind: 'color'; color: HexColor | BrandRef } | { kind: 'gradient'; from: HexColor | BrandRef; to: HexColor | BrandRef; angle: number } | { kind: 'image'; image: AssetRef; fit: 'cover' | 'contain' | 'tile' };
}
export interface Theme {
  /** Theme template this came from (lineage lives in bindings; this is for the Design panel). */
  presetRef?: { templateId: TemplateId; versionId: TemplateVersionId };
  layout: 'classic' | 'cards';       // DSN-05
  tokens: ThemeTokens;
  /** DSN-04: scoped under .fr-root; @import, external url(), expression() rejected; ≤ 50 KB. */
  customCss?: string;
}

export interface Behavior {
  submit: { label: LabelText; align: 'left' | 'center' | 'right' | 'full'; printButton?: boolean }; // FLD-50
  navigation: { allowBack: boolean; showPageTitles: boolean; autoAdvance?: boolean; keyboardShortcuts?: boolean };
  saveAndResume: { enabled: boolean; showButton: boolean; delivery: Array<'email' | 'copy_link'>; expiryDays: number }; // RSP-03 (≤ 60)
  /** RSP-04: forced off when any field is 'sensitive' unless allowWithSensitive; always off for consent-based fields before consent and under a children policy. */
  localAutosave: { enabled: boolean; allowWithSensitive: boolean };
  timeZone: TimeZone;                 // form tz for dates, age, windows
  spam: { honeypot: boolean; minFillSeconds: number; captcha: 'off' | 'always' | 'on_suspicion' }; // SPM-01, FLD-29; a captcha block overrides this
  /** ANA-05: off by default, consent-gated, disabled for minors and on air-gapped editions. */
  analytics?: { ga4?: string; gtm?: string; metaPixel?: string; requiresPurposeId: PurposeId };
  allowRespondentEdit?: { enabled: boolean; windowHours?: number };           // RSP-09
  urlPrefill: boolean;                                                         // PRE-01
  /** DSN-07: plan-gated request; server decides. */
  showBranding: boolean;
  a11y: { announceErrors: 'polite' | 'assertive'; focusFirstError: boolean };
  successAnimation: boolean;          // DSN-11, respects prefers-reduced-motion
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §12  I18N (FND-12, RSP-05, VAL-08) — same shape for forms and template payloads
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Stable id-path keys (survive reordering and label edits):
 *   form:title|description · welcome:content|startLabel · page:<pageId>:title|next|back
 *   block:<blockId>:label|description|placeholder|prefix|suffix|text|subheading|content|sub:<part>|msg:<code>
 *   option:<blockId>/<optionId> · mrow:<blockId>/<rowId> · mcol:<blockId>/<colId>
 *   product:<blockId>/<productId>:name|description · purpose:<purposeId>:name|description
 *   consent:<blockId>:notice|withdrawal|item:<itemId> · ending:<endingId>:content|message|url|action:<i>
 *   rule:<ruleId>:<actionIndex> · behavior:submit · tplvar:<name>:label|help   (template payloads only)
 */
export type TextKey = `${'form' | 'welcome' | 'page' | 'block' | 'option' | 'mrow' | 'mcol' | 'product' | 'purpose' | 'consent' | 'ending' | 'rule' | 'behavior' | 'tplvar'}:${string}`;

export interface TranslationEntry {
  value: string | InlineDoc | RichDoc | PlainTemplate;
  /** Hash of the default-locale source at translation time → stale detection + completeness. */
  sourceHash: Sha256Hex;
  origin: 'human' | 'machine' | 'import' | 'template';
}

export const SYSTEM_MESSAGE_KEYS = [
  ...VALIDATION_ERROR_CODES,
  'nav.next', 'nav.back', 'nav.submit', 'nav.save_later', 'nav.start', 'select.placeholder', 'select.no_results',
  'other.label', 'other.placeholder', 'file.drop_here', 'signature.clear', 'group.add_row', 'group.remove_row',
  'form.closed', 'form.not_open_yet', 'form.limit_reached', 'form.password_prompt', 'form.already_submitted',
  'resume.continue_or_restart', 'resume.link_sent', 'progress.label',
] as const;
export type SystemMessageKey = (typeof SYSTEM_MESSAGE_KEYS)[number];

export interface I18nBundle {
  defaultLocale: Locale;
  locales: Array<{ locale: Locale; direction: 'ltr' | 'rtl' }>;   // includes default
  detect: Array<'url_param' | 'browser' | 'embed_attr'>;
  urlParam: string;                                               // ?lang=hi-IN
  switcher: 'none' | 'dropdown';
  /** Non-default locales only; default-locale text lives inline. */
  messages: Partial<Record<Locale, Partial<Record<TextKey, TranslationEntry>>>>;
  systemMessages: Partial<Record<Locale, Partial<Record<SystemMessageKey, string>>>>;
  /** Consent notices must be human-reviewed per locale before publish. */
  reviewedConsentLocales: Locale[];
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §13  DEFINITION, DRAFT, VERSION, COMPILED PLAN, RUNTIME PROJECTION
 * ═════════════════════════════════════════════════════════════════════════ */

export const SCHEMA_VERSION = 2 as const;

/** Everything that decides what respondents see and how answers are judged. */
export interface FormDefinition {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Additive minor revision within v2 (optional-with-default fields only). */
  revision: number;
  formId: FormId;
  title: string;
  description?: RichDoc;
  welcome?: WelcomeScreen;
  blocks: Partial<Record<BlockId, StoredBlock>>;
  pages: Page[];                     // ≥ 1
  endings: Ending[];                 // ≥ 1
  defaultEndingId: EndingId;
  logic: LogicModel;
  privacy: PrivacyConfig;
  theme: Theme;
  behavior: Behavior;
  i18n: I18nBundle;
  x?: Extensions;
}

/** Template lineage summary on the form row (denormalised for the forms list). */
export interface TemplateOriginStamp { templateId: TemplateId; versionId: TemplateVersionId; name: string }

/** `forms` row (draft side). */
export interface FormRecord {
  id: FormId; orgId: OrgId; teamId?: TeamId; ownerUserId: UserId;
  draft: FormDefinition;
  draftRev: number;                  // CAS on PUT /forms/:id/draft (BLD-07/14)
  baseVersionId?: FormVersionId;     // BLD-08
  templateOrigin?: TemplateOriginStamp;
  brandKitId?: BrandKitId;           // null → team/org default kit
  lifecycle: 'active' | 'archived' | 'trashed';
  updatedAt: IsoInstant; updatedBy: UserId;
}

/** A runtime that lacks one refuses with "upgrade required" (mixed on-prem fleets). */
export type Capability =
  | 'schema@2' | 'logic@2' | 'expr@1' | 'rich_text@1'
  | 'payments' | 'appointments' | 'repeating_groups' | 'matrix' | 'cards_layout' | 'multi_locale'
  | 'save_and_resume' | 'email_otp' | 'consent_dpdp' | 'custom_css' | 'e2e_encryption' | `x-${string}`;

export interface ClientRuleStep { kind: 'rule'; ruleId: RuleId; scope: 'client+server'; row?: 'per_row' }
export interface ServerRuleStep { kind: 'rule'; ruleId: RuleId; scope: 'server'; row?: 'per_row' }
export type PlanStep =
  | { kind: 'default'; blockId: BlockId }      // dynamic defaults (today, template)
  | { kind: 'capture'; blockId: BlockId }      // hidden / context sources
  | { kind: 'variable'; varId: VariableId }
  | { kind: 'calc'; blockId: BlockId }
  /** onPath(p): computed from the jump cells of every earlier page; every value read depends on it. */
  | { kind: 'on_path'; pageId: PageId }
  | ClientRuleStep
  | ServerRuleStep;

/** Produced by compile() at publish, frozen in the version, recomputed and compared by the API. */
export interface CompiledForm {
  engine: 'logic@2';
  requires: Capability[];
  documentOrder: BlockId[];                          // DFS over pages → children
  parentOf: Partial<Record<BlockId, BlockId | PageId>>;
  pageOf: Partial<Record<BlockId, PageId>>;
  plan: PlanStep[];                                  // total evaluation order (§ semantics)
  reads: Partial<Record<string, string[]>>;          // step → cells read (incremental eval, trace)
  dataInventory: Array<{ purposeId: PurposeId; blockIds: BlockId[]; classifications: DataClassification[] }>;
  /** I13: effective classification and purposes of every derived cell (variables, calcs, set_value targets). */
  taint: Partial<Record<string, { classification: DataClassification; purposeIds: PurposeId[] }>>;
  definitionHash: Sha256Hex;
}

export interface TemplateLineageEntry {
  bindingId: TemplateBindingId; templateId: TemplateId; templateVersionId: TemplateVersionId;
  kind: TemplateKind; governance: 'bound' | 'detached';
}
/** Resolved template-variable and brand values at publish (audit: what the respondent saw). */
export interface VariablesSnapshot {
  variables: Partial<Record<TemplateVariableName, string | Partial<Record<Locale, string>>>>;
  brandKit?: { id: BrandKitId; tokensHash: Sha256Hex; tokens: Partial<Record<BrandToken, string>> };
  orgProfileUpdatedAt?: IsoInstant;
}

/** Immutable (PUB-01). `definition` is RESOLVED: no var nodes, no brand refs (I11). Stored at its original schemaVersion. */
export interface FormVersion {
  id: FormVersionId; orgId: OrgId; formId: FormId;
  number: number; label?: string;    // BLD-10
  schemaVersion: number;
  publishedAt: IsoInstant; publishedBy: UserId;
  definition: Readonly<FormDefinition>;
  compiled: CompiledForm;
  // Retirement is operational, not part of this immutable row: a version keeps accepting submissions for
  // FormOps.acceptPreviousVersionsHours (default 72) after a newer publish; then submit returns version_superseded.
  contentHash: Sha256Hex;            // sha256(JCS(definition)); cited by consent + signature audit
  templateLineage: TemplateLineageEntry[];
  variablesSnapshot: VariablesSnapshot;
}

/** Rules keep only client actions; rules left with no actions are dropped. */
export type PublicFormDefinition = Omit<FormDefinition, 'logic'> & {
  logic: Omit<LogicModel, 'rules'> & { rules: Array<Rule<ClientAction>> };
};

export type RuntimeStatus =
  | { state: 'open' }
  | { state: 'closed'; screen: RichDoc }
  | { state: 'not_yet_open'; opensAt: IsoInstant; screen: RichDoc }
  | { state: 'outside_hours'; nextOpenAt?: IsoInstant; screen: RichDoc }
  | { state: 'limit_reached'; screen: RichDoc }
  | { state: 'password'; screen: RichDoc }   // definition withheld until POST /f/:slug/unlock
  | { state: 'already_submitted'; screen: RichDoc };

/** GET /f/:slug after access checks. Snapshot-tested for leaks. */
export interface RuntimeFormVersion {
  versionId: FormVersionId; formId: FormId; contentHash: Sha256Hex;
  definition: PublicFormDefinition;  // notes, origin stamps, server actions stripped
  /** `reads` is kept (filtered to client steps) for incremental client evaluation (FND-13). */
  compiled: Omit<CompiledForm, 'dataInventory' | 'taint' | 'plan'> & { plan: Array<Exclude<PlanStep, ServerRuleStep>> };
  status: RuntimeStatus;
  accessToken?: string;              // short-lived, proves unlock/schedule checks
  publicConfig: {
    edition: 'saas' | 'onprem' | 'airgapped';
    captcha?: { provider: CaptchaConfig['provider']; siteKey?: string; powChallengeUrl?: string };
    payment?: { gateway: 'stripe' | 'razorpay'; publishableKey: string; testMode: boolean };
    upload: { presignUrl: string; maxFileBytes: number };
    soldOut?: ProductId[];
    branding: boolean;
    thirdPartyTrackingAllowed: boolean;
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §14  FORM OPS — server-only, live, revisioned + audited, NOT in FormVersion
 * ═════════════════════════════════════════════════════════════════════════ */

/** Names match RuntimeStatus states. There is no 'quarantined' screen: spam quarantine is silent (respondents see the normal ending). */
export type StatusScreenRole = 'closed' | 'not_yet_open' | 'limit_reached' | 'password' | 'already_submitted' | 'outside_hours';
/** Applied from 'ending' templates with a non-thank_you role (TPL-09). */
export interface StatusScreen { content: RichDoc; origin?: Origin }

export interface AccessConfig {
  enabled: boolean;                                                // ACC-01
  openAt?: IsoInstant; closeAt?: IsoInstant;                       // ACC-02/03
  availability?: { timeZone: TimeZone; windows: Array<{ weekdays: Weekday[]; from: IsoTime; to: IsoTime }> }; // ACC-06
  submissionLimit?: number;                                        // ACC-04 atomic
  password?: { argon2idHash: string; updatedAt: IsoInstant };      // ACC-05; never leaves the API
  uniqueSubmission: 'off' | 'device_token' | 'device_token_and_ip_hash'; // ACC-07
  onePerVerifiedEmail?: { emailBlockId: BlockId };                 // ACC-09
  embedAllowlist: string[];                                        // ACC-08 → frame-ancestors
  redirectAllowlist?: string[];
  screens: Partial<Record<StatusScreenRole, StatusScreen>>;
  /** P3 (ENT-04), reserved. */
  requireAuth?: { kind: 'sso'; connectionId: ConnectionId; prefillFromClaims?: Partial<Record<FieldKey, string>> };
}

/** Email body AST (NOT-02/04/06): rich text plus email-only nodes. Same AST as email templates. */
export type EmailBodyNode =
  | RichBlockNode
  | { type: 'answersTable'; attrs: { include: 'all' | BlockId[]; hideEmpty: boolean; maskSensitive: boolean } }
  | { type: 'button'; attrs: { label: string; action: 'view_submission' | 'edit_submission' | 'withdraw_consent' | 'resume_draft' | { url: PlainTemplate } } }
  | { type: 'brandBlock'; attrs: { part: 'header' | 'footer' | 'legal_footer' } };
export interface EmailDoc { type: 'email_doc'; content: EmailBodyNode[] }

export interface NotificationVariant { id: NotificationVariantId; name: string; locale?: Locale; subject: PlainTemplate; body: EmailDoc }

export interface NotificationConfig {
  id: NotificationId; name: string;
  kind: 'owner' | 'autoresponder'; enabled: boolean;
  trigger: 'submitted' | 'edited' | 'payment_confirmed' | 'appointment_reminder' | 'workflow_step' | 'draft_saved'; // NOT-08
  delay?: { kind: 'none' } | { kind: 'after'; minutes: number } | { kind: 'relative_to_field'; blockId: BlockId; offsetMinutes: number } | { kind: 'at'; at: IsoInstant }; // NOT-09
  senderId?: SenderId;               // NOT-01
  fromName?: PlainTemplate;
  to: Recipient[]; cc?: Recipient[]; bcc?: Recipient[]; replyTo?: Recipient;
  /** Only fields of these purposes (granted or legitimate-use) are included; recipients outside data roles need `data.route`. */
  purposeIds: PurposeId[];
  subject: PlainTemplate;
  body: EmailDoc;
  variants?: NotificationVariant[];  // NOT-10/12
  locale: 'respondent' | Locale;
  /** Fields' compliance.inNotifications applies; this can only be stricter. */
  sensitiveOverride?: 'mask' | 'omit';
  attachments?: { uploads: 'none' | 'attach' | 'links'; pdf?: { templateId?: PdfTemplateId; password?: { fromBlockId: BlockId } }; staticAsset?: AssetRef; maxTotalBytes?: number }; // NOT-07
  /** Forced on for autoresponders when a dpdp consent block exists (CMP-05). */
  includeWithdrawalLink: boolean;
  authoredAgainst?: FormVersionId;
  origin?: Origin;
}

export interface WebhookConfig {   // INT-01
  id: WebhookId; url: SafeUrl; enabled: boolean;
  secretRef: ConnectionId;         // HMAC-SHA256 secret in the vault
  events: Array<'submission.created' | 'submission.updated' | 'submission.deleted' | 'payment.succeeded' | 'consent.withdrawn'>;
  keyBy: 'key' | 'id';
  /** Further restricts the purpose-filtered set. */
  fieldKeys: FieldKey[] | 'all_in_purposes';
  /** Required, non-empty. The webhook must be listed in each purpose's `recipients` (publish error otherwise). */
  purposeIds: PurposeId[];
  files: 'signed_urls' | 'none';
  filter?: ConditionGroup;
}

export interface IntegrationBinding {
  id: IntegrationId;
  provider: 'google_sheets' | 'google_drive' | 'dropbox' | 'onedrive' | 'slack' | 'teams' | 'mailchimp' | 'hubspot' | 'salesforce' | 'zoho_crm' | 'zapier' | 'make' | 'n8n' | 'google_calendar' | 'outlook_calendar';
  connectionId: ConnectionId;
  settings: Readonly<Record<string, unknown>>;   // provider zod schema
  fieldMap: Array<{ from: FieldKey | `variable:${string}` | `meta:${string}`; to: string }>;
  /** Required, non-empty; same rules as WebhookConfig.purposeIds. Withdrawal triggers provider delete calls (CMP-05). */
  purposeIds: PurposeId[];
  enabled: boolean;
}

/** Same shape as the 'pdf' template payload (EXP-03/05/06). */
export interface PdfTemplateConfig extends PdfLayout { id: PdfTemplateId; name: string; origin?: Origin }

export interface Coupon {
  code: string;                    // stored normalised
  discount: { kind: 'percent'; pct: DecimalString } | { kind: 'fixed'; amount: MinorUnits };
  productIds?: ProductId[]; maxRedemptions?: number; expiresAt?: IsoInstant;
}

/** Operational retention (CMP-06). Can only SHORTEN what purposes declare; legal hold suspends purges; the statutory floor still applies (CMP-23). */
export interface RetentionOps {
  shortenToDays?: number;
  basis: 'submitted_at' | 'last_modified_at' | { field: BlockId };
  onExpiry: 'delete' | 'anonymise';
  files: 'with_submission' | { days: number };
  draftsDays: number;              // ≤ 60
  trashDays: number;               // SUB-12, default 30
  legalHold?: { active: boolean; reason: string; setBy: UserId; setAt: IsoInstant };
}

export interface FormOps {
  formId: FormId; orgId: OrgId;
  rev: number;                     // CAS + audit diff; every send records the rev used
  slug: string; previousSlugs: string[];   // PUB-03
  liveVersionId?: FormVersionId;
  access: AccessConfig;
  notifications: NotificationConfig[];
  webhooks: WebhookConfig[];
  integrations: IntegrationBinding[];
  pdfTemplates: PdfTemplateConfig[];
  payments?: { connectionId: ConnectionId; testMode: boolean; coupons: Coupon[]; stock: Partial<Record<ProductId, number>>; lowStockAlert?: { threshold: number; to: Recipient[] } };
  retention: RetentionOps;
  spam: { quarantineDisposable: boolean; rateLimitPerIpPerHour: number };
  workflowIds: WorkflowId[];
  /** Hours a previous version keeps accepting submissions after a newer publish (default 72). */
  acceptPreviousVersionsHours: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §15  ANSWERS — tagged by block type; shape = f(type) (I2); absent = unanswered (I9)
 * ═════════════════════════════════════════════════════════════════════════ */

export interface FileRef { fileId: FileId; name: string; sizeBytes: number; mime: string /* sniffed */; sha256: Sha256Hex; scan?: 'pending' | 'clean' | 'infected' | 'skipped' }

export type MatrixValue =
  | { mode: 'single'; rows: Partial<Record<MatrixRowId, MatrixColumnId>> }
  | { mode: 'multi'; rows: Partial<Record<MatrixRowId, MatrixColumnId[]>> }
  | { mode: 'grid'; rows: Partial<Record<MatrixRowId, Partial<Record<MatrixColumnId, string | DecimalString | OptionId | boolean>>>> };

export interface SignatureValue {
  method: 'drawn' | 'typed';
  file: FileRef;                   // PNG via renderer `uploader` (S10: never a data URL)
  typedName?: string;
  /** WFL-07; server-completed. */
  audit?: { signedAt: IsoInstant; evidenceHash?: Sha256Hex /* hash of (ip, ua, time, versionId); not a bare IP hash */; versionContentHash: Sha256Hex; statementHash?: Sha256Hex; answersHash: Sha256Hex };
}

export interface PaymentSelection {
  items?: Array<{ productId: ProductId; quantity: number; options?: Partial<Record<ProductOptionId, OptionId>> }>;
  customAmount?: MinorUnits;
  couponCode?: string;
  currency: CurrencyCode;
  /** Advisory; server recomputes; mismatch → 422 amount_changed. */
  clientTotal?: MinorUnits;
}

export interface AnswerValueMap {
  short_text: string;
  long_text: string;
  full_name: Partial<Record<NamePart, string>>;
  email: { address: EmailAddress; otpProof?: string };
  phone: { e164: string; country: CountryCode };
  address: Partial<Record<AddressPart, string>> & { stateCode?: string };
  number: DecimalString;
  url: string;
  single_choice: { optionId: OptionId | null /* null + other = "Other" */; other?: string };
  multi_choice: { optionIds: OptionId[]; other?: string };
  date: IsoDate;
  datetime: { local: IsoLocalDateTime; timeZone: TimeZone; instant: IsoInstant };
  time: { start: IsoTime; end?: IsoTime };
  rating: number;
  linear_scale: number;
  nps: number;
  ranking: OptionId[];
  matrix: MatrixValue;
  repeating_group: { rows: Array<{ rowId: GroupRowId; values: Partial<Record<BlockId, StoredAnswer>> }> };   // children may be encrypted
  file_upload: FileRef[];
  signature: SignatureValue;
  hidden: string;
  consent: { items: Partial<Record<ConsentItemId, boolean>>; noticeLocale: Locale; noticeVersion: number; scrolledToEnd?: boolean; guardian?: { email: EmailAddress; verifiedAt?: IsoInstant } };
  payment: PaymentSelection;
  appointment: { start: IsoInstant; end: IsoInstant; respondentTimeZone: TimeZone; holdToken?: string };
  calculation: ScalarValue;
  context: string;
  unique_id: string;
}
export const _answersComplete: _ExactKeys<AnswerValueMap, ValueFieldType> = true;

export type AnswerValue = { [T in ValueFieldType]: { type: T; value: AnswerValueMap[T] } }[ValueFieldType];
export type AnswerOf<T extends ValueFieldType> = Extract<AnswerValue, { type: T }>;
export type Answers = Partial<Record<BlockId, AnswerValue>>;

/** CMP-07. The type tag stays clear so readers know the shape after decrypt. */
export interface EncryptedAnswer {
  type: ValueFieldType;
  enc: { alg: 'A256GCM'; kid: string /* org DEK version; deleting a DEK is not erasure while backups hold it */; iv: string; ct: string /* JCS(value) */; aad: `${string}:${string}` /* submissionId:blockId */ };
  bidx?: { kid: string; values: string[] };   // CMP-08
}
export type StoredAnswer = AnswerValue | EncryptedAnswer;
/** Tainted computed values (I13) are stored encrypted. */
export interface EncryptedScalar { enc: EncryptedAnswer['enc'] }

/* ═══════════════════════════════════════════════════════════════════════════
 * §16  SUBMISSIONS — wire payload, result, stored record, revisions, drafts, consent
 * ═════════════════════════════════════════════════════════════════════════ */

export interface SubmissionRequest {   // POST /f/:slug/submissions — untrusted
  formVersionId: FormVersionId;
  idempotencyKey: string;              // UUIDv7, deduped 24h
  locale: Locale;
  answers: Answers;
  pageTrail: PageId[];                 // advisory; server re-simulates
  /** Advisory meta inputs the server re-simulates with (same values the client evaluated with). */
  client: { startedAt: IsoInstant; timeZone?: TimeZone; embedOrigin?: string; urlParams?: Record<string, string>; pageUrl?: string; referrer?: string; device?: 'desktop' | 'tablet' | 'mobile' };
  verification: { honeypot: ''; captchaToken?: string; powSolution?: string; emailOtp?: Partial<Record<BlockId, string>> };
  tokens?: { access?: string; resume?: string; prefill?: string; edit?: string };
}

export interface DraftSaveRequest { formVersionId: FormVersionId; answers: Answers; currentPageId: PageId; resumeToken?: string; sendLinkTo?: EmailAddress }

export interface FieldError { blockId?: BlockId; path?: AnswerPath; rowId?: GroupRowId; code: ValidationErrorCode; message: string; params?: Record<string, string | number> }

export type SubmitResult =
  | { ok: true; submissionId: SubmissionId; endingId: EndingId; redirectUrl?: SafeUrl; uniqueId?: string; editToken?: string; receiptToken?: string; held?: 'pending_guardian_consent' | 'pending_scan' }
  | { ok: false; kind: 'invalid'; status: 422; errors: FieldError[] }
  | { ok: false; kind: 'payment_required'; submissionId: SubmissionId; checkout: { gateway: 'stripe' | 'razorpay'; clientSecretOrOrderId: string; amount: MinorUnits; currency: CurrencyCode } }
  | { ok: false; kind: 'closed' | 'limit_reached' | 'version_superseded' | 'rate_limited' | 'spam_rejected' | 'amount_changed' };

/** CMP-04: one per consent item per submission; withdrawal appends, never overwrites. */
export interface ConsentRecord {
  submissionId: SubmissionId; blockId: BlockId; itemId: ConsentItemId; purposeId?: PurposeId;
  granted: boolean;
  /** noticeHash = sha256(JCS(fully rendered notice in `locale`)), see ConsentConfig.noticeVersion. */
  formVersionId: FormVersionId; noticeVersion: number; noticeHash: Sha256Hex; locale: Locale;
  at: IsoInstant;
  source: 'form' | 'withdrawal_link' | 'owner_ui' | 'api' | 'dsr' | 'import' | 'consent_manager';
  /** Whose data: the respondent, or a child / person with disability consented for by a guardian. */
  subject?: 'self' | 'child' | 'person_with_disability';
  /** Rule 10/11 evidence for guardian consent. */
  vpc?: { method: GuardianVerificationMethod; evidenceRef: string; verifiedAt: IsoInstant; verifiedBy?: UserId };
}

/** CMP-09: append-only ledger of who received a principal's data (s.11(1)(b)); kept for the submission's life. */
export interface Disclosure {
  submissionId: SubmissionId; orgId: OrgId;
  recipient: { kind: 'notification' | 'webhook' | 'integration' | 'export' | 'workflow' | 'api_key'; id: string; displayName: string };
  fieldKeys: FieldKey[];
  at: IsoInstant;
}

export interface PaymentRecord {
  gateway: 'stripe' | 'razorpay'; reference: string;
  status: 'pending' | 'authorised' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
  currency: CurrencyCode;
  totals: { subtotal: MinorUnits; discount: MinorUnits; tax: MinorUnits; shipping: MinorUnits; total: MinorUnits };
  taxBreakdown?: Array<{ kind: 'CGST' | 'SGST' | 'IGST' | 'VAT' | 'TAX'; ratePct: DecimalString; amount: MinorUnits }>;
  couponCode?: string; invoiceNumber?: string; subscriptionRef?: string;
}

export type SubmissionStatus = 'complete' | 'pending_payment' | 'payment_failed' | 'pending_scan' | 'pending_guardian_consent' | 'spam' | 'archived' | 'trashed';
/* pending_guardian_consent: no notifications, webhooks, integrations, drafts or analytics; deleted when the guardian window expires. */

export interface StoredSubmission {
  id: SubmissionId; orgId: OrgId; formId: FormId; formVersionId: FormVersionId;
  definitionHash: Sha256Hex;
  answerCodecVersion: number;
  seq: number;                     // per form, gap-free (FLD-32)
  status: SubmissionStatus;
  /** Only visible_eff + on-path + purpose-permitted blocks (CMP-19, LOG-25). */
  answers: Partial<Record<BlockId, StoredAnswer>>;
  computed: { variables: Partial<Record<VariableId, ScalarValue | EncryptedScalar>>; path: PageId[]; endingId: EndingId; firedRuleIds: RuleId[] };
  consents: ConsentRecord[];
  payment?: PaymentRecord;
  meta: {
    receivedAt: IsoInstant; startedAt?: IsoInstant; durationMs?: number; locale: Locale;
    source: 'web' | 'embed' | 'api' | 'import';
    ipHash?: Sha256Hex; uaHash?: Sha256Hex;   // salted, TTL (CMP-11)
    device?: 'desktop' | 'tablet' | 'mobile'; country?: CountryCode; embedOrigin?: string;
    utm?: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>;
    spamScore?: number; opsRev: number;
  };
  retention: { deleteAfter: IsoInstant; statutoryHoldUntil?: IsoInstant; fieldDeleteAfter?: Partial<Record<BlockId, IsoInstant>>; legalHold: boolean };
  workflowState?: string; statusLabel?: string;   // WFL-01, SUB-15
  inbox: { read: boolean; starred: boolean; tags: string[]; assigneeId?: UserId; archivedAt?: IsoInstant; trashedAt?: IsoInstant };
  revision: number;
  createdAt: IsoInstant; updatedAt: IsoInstant;
}

export interface SubmissionRevision {   // SUB-10, append-only
  submissionId: SubmissionId; revision: number;
  by: { kind: 'respondent' } | { kind: 'user'; userId: UserId } | { kind: 'system'; job: string };
  mode: 'inline_edit_no_side_effects' | 'resubmit_with_side_effects';
  changed: Array<{ blockId: BlockId; before?: StoredAnswer; after?: StoredAnswer }>;
  at: IsoInstant;
}

export interface DraftSubmission {      // RSP-03
  id: SubmissionId; orgId: OrgId; formId: FormId; formVersionId: FormVersionId;
  answers: Partial<Record<BlockId, StoredAnswer>>;
  currentPageId: PageId; path: PageId[]; locale: Locale;
  resumeTokenHash: Sha256Hex; expiresAt: IsoInstant;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §17  TEMPLATES (TPL-*, BLD-13, DSN-03, DSN-09) — kinds, variables, brand kits,
 *      locks, lineage, diff, bundles. Payloads are versioned + immutable once published.
 * ═════════════════════════════════════════════════════════════════════════ */

export const TEMPLATE_KINDS = ['form', 'theme', 'email', 'ending', 'pdf', 'snippet', 'workflow'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export type TemplateScope = 'system' | 'org' | 'team' | 'personal';
export type TemplateLifecycle = 'active' | 'deprecated' | 'archived';
/** 'rejected' is terminal for that version; the author starts a new draft (version + 1). */
export type TemplateVersionState = 'draft' | 'in_review' | 'published' | 'rejected' | 'superseded';

/**
 * `field:payment`, `integration:google_sheets`, `capability:appointments`… checked against edition/plan.
 * Edition-gated ids (@form/config `isEditionFeatureAvailable`): `integration:<provider>`, `field:payment` and
 * `capability:payments` (a payment provider is configured), `capability:guardian_digilocker`,
 * `capability:captcha_<provider>` and `capability:analytics_<provider>` (unavailable when air-gapped unless the
 * provider is first-party, i.e. `captcha_proof_of_work`). Every other id passes the edition check and is left to
 * plan, licence and org restrictions.
 */
export type FeatureId = `${'field' | 'integration' | 'capability' | 'plan'}:${string}`;

/** §17.1 Template variables. Msg = default-locale string; translations under `tplvar:<name>:label|help`. */
export type Msg = string;
export interface TemplateVariable {
  name: TemplateVariableName;
  source: 'org_profile' | 'brand_kit' | 'form' | 'prompt';
  type: 'text' | 'rich' | 'email' | 'phone' | 'url' | 'image' | 'color' | 'date' | 'number' | 'select' | 'boolean';
  label: Msg; help?: Msg;
  required: boolean;                  // org.privacy_contact.* required for DPDP templates
  default?: string | number | boolean;
  options?: Array<{ value: string; label: Msg }>;
  /** org/brand/form default 'live' (resolved at publish); prompt default 'bake' (substituted at use). */
  binding: 'live' | 'bake';
}

/** §17.4 Locked regions (enforced P3; schema reserved now). */
export type LockMode = 'content' | 'structure' | 'presence';
export interface LockSpec {
  id: LockId;
  target:
    | { kind: 'block'; sourceId: string }                         // block or section subtree
    | { kind: 'theme'; tokens: string[] }                         // ['colors.accent','logo']
    | { kind: 'ending'; sourceId: string }
    | { kind: 'email'; sourceId: string; parts: Array<'subject' | 'body' | 'footer'> }
    | { kind: 'pdf'; sourceId: string; parts: Array<'header' | 'footer'> }
    | { kind: 'purpose'; sourceId: string };                      // purpose text + lawful basis
  modes: LockMode[];
  reason: Msg;
}

export interface TemplateRef { templateId: TemplateId; versionId: TemplateVersionId }

interface TemplatePayloadCommon {
  schemaVersion: number;
  variables: TemplateVariable[];
  locks: LockSpec[];
  requiredFeatures: FeatureId[];
  /** Same bundle shape as forms (RSP-05); `use` copies messages into the form. */
  i18n: Pick<I18nBundle, 'defaultLocale' | 'locales' | 'messages'>;
}

export interface DataInventoryEntry { purposeName: string; fieldSourceIds: string[]; classification: DataClassification; suggestedRetentionDays?: number; encrypted: boolean }

/** Optional part toggled by a boolean `custom.*` variable ("Include dietary preferences?"). */
export interface TemplateOptionalPart {
  id: TemplatePartId; label: Msg;
  when: { variable: TemplateVariableName; equals: string | boolean };
  includes: { blockSourceIds?: string[]; pageSourceIds?: string[]; ruleSourceIds?: string[]; variableSourceIds?: string[]; endingSourceIds?: string[]; purposeSourceIds?: string[] };
}

/** Recipients in templates are placeholders only — never literal addresses. */
export type RecipientPlaceholder = Exclude<Recipient, { kind: 'email' } | { kind: 'member' }>;

export interface FormTemplatePayload extends TemplatePayloadCommon {
  kind: 'form';
  /** Full definition; formId is a placeholder; var nodes allowed; ids are template source ids. */
  document: FormDefinition;
  refs?: {
    theme?: TemplateRef | ThemeTemplatePayload;
    endings?: Array<TemplateRef | EndingTemplatePayload>;
    emails?: Array<TemplateRef | EmailTemplatePayload>;
    pdf?: Array<TemplateRef | PdfTemplatePayload>;
    workflow?: TemplateRef | WorkflowTemplatePayload;
  };
  sampleAnswers?: Answers;
  dataInventory: DataInventoryEntry[];
  estimatedMinutes: number;
  optionalParts?: TemplateOptionalPart[];
}

export interface ThemeTemplatePayload extends TemplatePayloadCommon {
  kind: 'theme';
  layout: 'classic' | 'cards';
  tokens: ThemeTokens;
  customCss?: string;
}

export type EmailTemplateRole = 'notification' | 'autoresponder' | 'edit_notice' | 'invite' | 'resume_link' | 'otp' | 'withdrawal_confirm' | 'dsr_response' | 'breach_notice' | 'guardian_consent_request';
export interface EmailTemplatePayload extends TemplatePayloadCommon {
  kind: 'email';
  role: EmailTemplateRole;
  subject: PlainTemplate;
  body: EmailDoc;
  headerRef?: BrandRef | { ref: 'brand.email_header' };
  footerRef?: { ref: 'brand.email_footer' | 'brand.legal_footer' };
  replyTo?: RecipientPlaceholder;
  defaultRecipients?: RecipientPlaceholder[];
  includeWithdrawalLink?: boolean;
}

export type EndingTemplateRole = 'thank_you' | StatusScreenRole;
export interface EndingTemplatePayload extends TemplatePayloadCommon {
  kind: 'ending';
  role: EndingTemplateRole;
  content: RichDoc;
  actions: EndingAction[];
  redirect?: PlainTemplate;          // https only
  confetti?: boolean;
}

export interface PdfLayout {
  pageSize: 'A4' | 'Letter'; orientation: 'portrait' | 'landscape';
  marginsMm: { top: number; right: number; bottom: number; left: number };
  header?: RichDoc; footer?: RichDoc;   // logo slot via ImageNode(BrandRef), org.legal_name vars, page numbers via meta
  fields: { mode: 'all' } | { mode: 'by_classification'; include: DataClassification[] } | { mode: 'explicit'; keys: FieldKey[] };
  hideEmpty: boolean;
  maskSensitive: boolean;
  watermark?: PlainTemplate;
  passwordFrom?: { blockId: BlockId } | { key: FieldKey };
}
export interface PdfTemplatePayload extends TemplatePayloadCommon { kind: 'pdf'; layout: PdfLayout }

export interface SnippetTemplatePayload extends TemplatePayloadCommon {
  kind: 'snippet';
  /** A section block (FLD-48) or, for single-block snippets in P1 (Consent), the block itself. */
  rootId: BlockId;
  blocks: Partial<Record<BlockId, Block>>;
  rules: Rule[];                     // must only target blocks inside the snippet
  logicVariables: Variable[];        // group-local logic variables
  purposes: Purpose[];               // purposes the snippet's fields need (merged by id-map on insert)
  insertHints: { preferredPosition?: 'start' | 'end' | 'before_submit'; oncePerForm: boolean };
}

/** WFL-01/02 linear approvals with branches. */
export type WorkflowStep =
  | { id: WorkflowStepId; kind: 'approval'; name: string; approver: RecipientPlaceholder | { kind: 'role'; role: 'form_owner' | 'org_admins' | 'team_admins' }; emailTemplate?: TemplateRef; onApprove: WorkflowStepId | 'end_approved'; onDeny: WorkflowStepId | 'end_denied' }
  | { id: WorkflowStepId; kind: 'branch'; name: string; branches: Array<{ when: ConditionGroup; next: WorkflowStepId }>; otherwise: WorkflowStepId }
  | { id: WorkflowStepId; kind: 'notify'; name: string; to: RecipientPlaceholder[]; emailTemplate: TemplateRef; next: WorkflowStepId | 'end' };
export interface WorkflowDefinition { id: WorkflowId; name: string; start: WorkflowStepId; steps: WorkflowStep[] }
export interface WorkflowTemplatePayload extends TemplatePayloadCommon { kind: 'workflow'; workflow: WorkflowDefinition }

export type TemplateVersionPayload =
  | FormTemplatePayload | ThemeTemplatePayload | EmailTemplatePayload | EndingTemplatePayload
  | PdfTemplatePayload | SnippetTemplatePayload | WorkflowTemplatePayload;
type _KindsOk = _ExactKeys<{ [K in TemplateVersionPayload['kind']]: 1 }, TemplateKind>;
export const _kindsOk: _KindsOk = true;

/** `templates` row. */
export interface Template {
  id: TemplateId;
  orgId: OrgId | null;               // null = system
  teamId: TeamId | null;
  ownerUserId: UserId | null;
  scope: TemplateScope;
  kind: TemplateKind;
  slug: string;                      // system: '<pack>/<slug>'
  lifecycle: TemplateLifecycle;
  source: 'system_pack' | 'pack_import' | 'user' | 'clone' | 'jotform_import' | 'ai';
  packId?: TemplatePackId;
  forkedFromVersionId?: TemplateVersionId;
  currentVersionId?: TemplateVersionId;
  defaultLocale: Locale;
  industries: string[]; tags: string[]; categoryIds: TemplateCategoryId[];
  layout?: 'classic' | 'cards';
  featured: boolean; sortWeight: number;
  createdBy?: UserId; createdAt: IsoInstant; updatedAt: IsoInstant; deletedAt?: IsoInstant;
}

/** `template_versions` row. Payload, hash and fingerprints are immutable once state ≠ draft (DB trigger). */
export interface TemplateVersion {
  id: TemplateVersionId; templateId: TemplateId; orgId: OrgId | null;
  version: number;
  state: TemplateVersionState;
  schemaVersion: number;
  payload: TemplateVersionPayload;
  payloadHash: Sha256Hex;
  lockFingerprints: Partial<Record<LockId, Sha256Hex>>;
  requiredFeatures: FeatureId[];
  locales: Locale[];
  changeLevel?: 'patch' | 'minor' | 'major';
  changelog?: string;                // required from v2
  mandatory: boolean; mandatoryDeadline?: IsoInstant;   // P3
  thumbnailAssetId?: AssetId;
  stats: { fields: number; pages: number; estMinutes: number; hasSensitive: boolean };
  review?: { submittedAt?: IsoInstant; reviewedBy?: UserId; reviewedAt?: IsoInstant; comment?: string };
  publishedAt?: IsoInstant;
  packSignature?: { keyId: string; sig: string };
  createdBy?: UserId; createdAt: IsoInstant;
}

export interface TemplateLocalization {
  templateVersionId: TemplateVersionId; locale: Locale;
  title: string; summary: string; description?: RichDoc;
  fieldLabels: string;               // FTS weight C
  completeness: number;              // 0..100 of payload messages translated
}

export interface TemplateCategory {
  id: TemplateCategoryId; orgId: OrgId | null;
  facet: 'use_case' | 'industry' | 'compliance';
  parentId?: TemplateCategoryId; slug: string;
  names: Partial<Record<Locale, string>>;
  icon?: string; kinds: TemplateKind[]; sort: number;
}

/** §17.3 Brand kit. P2: one default per org; P3: per team / sub-brand. */
export interface BrandKitTokens {
  name: string;
  logos: { primary: AssetId; dark?: AssetId; square?: AssetId; favicon?: AssetId };
  colors: { primary: HexColor; secondary: HexColor; accent: HexColor; background: HexColor; surface: HexColor; text: HexColor; muted: HexColor; error: HexColor; success: HexColor };
  typography: { heading: FontId; body: FontId; baseSize: number };
  shape: { radius: 'none' | 'sm' | 'md' | 'lg' | 'full'; density: 'compact' | 'comfortable' };
  email: { header?: RichDoc; footer: RichDoc };
  pdf: { header?: RichDoc; footer?: RichDoc };
  legalFooter?: RichDoc;             // under submit on every form
}
export interface BrandKit {
  id: BrandKitId; orgId: OrgId; teamId?: TeamId;
  isDefault: boolean;
  tokens: BrandKitTokens;
  updatedBy: UserId; updatedAt: IsoInstant; deletedAt?: IsoInstant;
}

export type OrgProfileTextField = 'display_name' | 'legal_name' | 'registered_address' | 'privacy_contact.name' | 'privacy_contact.designation' | 'privacy_contact.address' | 'dpo.name';
/** One per org (P1); source of `org.*` variables and DPDP notice data. */
export interface PostalAddress { line1: string; line2?: string; city: string; state: string; stateCode?: string; postalCode: string; country: CountryCode }
export interface OrgProfile {
  orgId: OrgId;
  displayName: string; legalName?: string; cin?: string; gstin?: string;
  industry?: string;                 // drives "Recommended" sort
  registeredAddress?: PostalAddress;
  website?: SafeUrl; supportEmail?: EmailAddress; supportPhone?: string;
  privacyPolicyUrl?: SafeUrl; termsUrl?: SafeUrl;
  /** s.8(9) contact; source of `org.privacy_contact.*`. */
  privacyContact?: { name: string; designation?: string; email: EmailAddress; phone?: string; address?: PostalAddress };
  dpo?: { name: string; email: EmailAddress; phone?: string };
  localized: Partial<Record<Locale, Partial<Record<OrgProfileTextField, string>>>>;
  updatedAt: IsoInstant; updatedBy: UserId;
}

export interface OrgTemplateSettings {
  publishPolicy: 'admins_only' | 'members_direct' | 'members_with_review';
  reviewers: { roles: Array<'owner' | 'admin'>; userIds: UserId[] };
  allowPersonal: boolean;
  showSystemGallery: boolean;          // P3
  allowedSystemCategories: TemplateCategoryId[] | null;   // P3
  requireBrandKitOnUse: boolean;       // P3
  allowUnsignedImport: boolean;
}

/** §17.5 Lineage: `form_template_bindings` row (one per applied template incl. each snippet instance). */
export interface FormTemplateBinding {
  id: TemplateBindingId; orgId: OrgId; formId: FormId;
  templateId: TemplateId; templateVersionId: TemplateVersionId;
  kind: TemplateKind;
  instanceRootId?: string;             // snippet section id / ending id / notification id
  idMap: Record<string, string>;       // sourceId → instance id
  keyMap?: Record<string, FieldKey>;   // template key → instance key (collision suffixes)
  updateState: 'current' | 'available' | `dismissed@${number}` | 'required';
  governance: 'bound' | 'detached';
  appliedBy: UserId; appliedAt: IsoInstant;
}

/** TPL-32: an org template forked from another (usually system) template keeps lineage for upstream updates. */
export interface TemplateForkBinding {
  id: string; orgId: OrgId;
  templateId: TemplateId;                 // the org fork
  upstreamTemplateId: TemplateId; upstreamVersionId: TemplateVersionId;
  idMap: Record<string, string>;          // upstream sourceId → fork sourceId
  updateState: FormTemplateBinding['updateState'];
}

/** Deterministic instantiation: newId = uuidv5(idSeed, sourceId) so client (offline) and server agree. */
export interface InstantiateContext {
  newFormId: FormId;
  idSeed: string;                      // = Idempotency-Key of POST /templates/:id/use
  bindingIdSeed: string;
  locale: Locale; extraLocales: Locale[];
  orgProfile: OrgProfile | null;
  brandKit: BrandKit | null;
  variables: Partial<Record<TemplateVariableName, string | number | boolean>>;   // custom.* answers
  include: { theme: boolean; emails: boolean; endings: boolean; pdf: boolean; workflow: boolean };
  now: IsoInstant;
}
export interface TemplateWarning { code: 'sensitive_fields' | 'variable_missing' | 'feature_unavailable' | 'part_removed_rule' | 'key_renamed' | 'locale_incomplete'; message: string; at?: string }
export interface InstantiateResult {
  definition: FormDefinition;          // passes validateDefinition(…,'save'); bake vars substituted; origin stamps set
  ops: Pick<FormOps, 'notifications' | 'pdfTemplates'> & { screens: AccessConfig['screens'] };
  bindings: FormTemplateBinding[];
  workflow?: WorkflowDefinition;
  warnings: TemplateWarning[];
}
/** Snippet insertion produces builder ops (same command layer as user edits; undoable). */
export type DocumentOp =
  | { op: 'add_block'; block: Block; parent: { pageId: PageId } | { blockId: BlockId }; index: number }
  | { op: 'add_rule'; rule: Rule; index: number }
  | { op: 'add_variable'; variable: Variable }
  | { op: 'add_purpose'; purpose: Purpose }
  | { op: 'set_messages'; locale: Locale; entries: Partial<Record<TextKey, TranslationEntry>> };
export interface InsertSnippetResult { ops: DocumentOp[]; binding: FormTemplateBinding; keyMap: Record<string, FieldKey>; warnings: TemplateWarning[] }

/** §17.6 Three-way diff (shares the BLD-10 engine). */
export type TemplateChange =
  | { id: string; kind: 'block.added' | 'block.removed' | 'block.moved'; sourceId: string; conflict: boolean }
  | { id: string; kind: 'prop.changed'; sourceId: string; path: string; base: unknown; theirs: unknown; ours: unknown; conflict: boolean }
  | { id: string; kind: 'option.added' | 'option.removed' | 'option.relabelled'; sourceId: string; optionId: OptionId; conflict: boolean }
  | { id: string; kind: 'rule.added' | 'rule.removed' | 'rule.changed'; sourceId: string; conflict: boolean }
  | { id: string; kind: 'theme.token.changed'; token: string; conflict: boolean }
  | { id: string; kind: 'ending.changed' | 'email.changed' | 'pdf.changed' | 'purpose.changed'; sourceId: string; conflict: boolean }
  | { id: string; kind: 'lock.changed'; lockId: LockId; conflict: false /* locked regions are replaced whole */ };
export interface TemplateDiff { bindingId: TemplateBindingId; from: number; to: number; changelog: string; changes: TemplateChange[] }
export interface ApplyUpdateRequest { to: number; decisions: Array<{ changeId: string; choice: 'theirs' | 'ours' }>; draftRev: number }

/** §17.7 `.formpack` bundle (zip). Signature covers JCS(manifest), which lists every file's sha256. */
export interface FormpackManifest {
  format: 'fORM-template-bundle'; formatVersion: 1;
  pack: { publisher: string; name: string; version: string };
  minAppVersion: string; schemaVersion: number;
  templates: Array<{ slug: string; kind: TemplateKind; version: number; path: string; sha256: Sha256Hex; requiredFeatures: FeatureId[]; dependsOn: string[] /* 'slug@ver' */ }>;
  categories: string;                // path to categories.json
  assets: Array<{ path: string; sha256: Sha256Hex; mime: string; bytes: number }>;
}
export interface FormpackSignature { alg: 'ed25519'; keyId: string; sig: string }
export interface FormpackTemplateFile { payload: TemplateVersionPayload; localizations: Array<Omit<TemplateLocalization, 'templateVersionId'>>; categorySlugs: string[]; changelog?: string }

export type TemplateErrorCode =
  | 'DRAFT_REV_CONFLICT' | 'LOCK_VIOLATION' | 'TEMPLATE_VARIABLE_UNRESOLVED' | 'TEMPLATE_FEATURE_UNAVAILABLE'
  | 'TEMPLATE_UPDATE_REQUIRED' | 'TEMPLATE_INVALID';

/* ═══════════════════════════════════════════════════════════════════════════
 * §18  VERSIONING AND MIGRATION
 * ═════════════════════════════════════════════════════════════════════════ */

/** v1 = src/types/form.ts @ e1be409 (no schemaVersion field). */
export namespace V1 {
  export type FieldType =
    | 'heading' | 'heading_2' | 'heading_3' | 'paragraph' | 'divider' | 'page_break' | 'thank_you'
    | 'text' | 'long_text' | 'number' | 'email' | 'phone' | 'url' | 'dropdown' | 'multiple_choice'
    | 'checkbox' | 'multi_select' | 'date' | 'time' | 'rating' | 'linear_scale' | 'nps' | 'ranking'
    | 'file_upload' | 'signature' | 'hidden';
  export type LogicOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than' | 'answered' | 'not_answered' | 'is_empty';
  export interface FormBlock {
    id: string; type: FieldType; label: string; placeholder?: string; helpText?: string;
    options?: Array<{ id: string; label: string; value: string }>;
    validation?: { required?: boolean; min?: number; max?: number; pattern?: string; errorMessage?: string };
    logic?: { enabled?: boolean; action?: 'show' | 'hide'; sourceBlockId?: string; operator?: LogicOperator; value?: string };
    customize?: Record<string, unknown>;
    order: number;
  }
  export interface FormSettings {
    submitButtonText: string; successMessage: string; themeColor: string; backgroundColor: string; textColor: string;
    accentColor: string; font: string; progressBar: boolean; redirectUrl: string; closed: boolean; closedMessage: string;
    password: string; logoUrl: string; coverUrl: string; successAnimation: boolean;
  }
  export interface FormSchema { id: string; title: string; description: string; blocks: FormBlock[]; settings: FormSettings }
}

export type AnyFormDocument = V1.FormSchema | FormDefinition;

export interface MigrationNote {
  path: string;
  code:
    | 'html_sanitised' | 'logic_value_unmatched' | 'logic_operator_changed' | 'logic_rule_disabled' | 'dangling_logic_source'
    | 'password_extracted' | 'key_generated' | 'external_asset_queued' | 'redirect_dropped' | 'unsafe_pattern_dropped'
    | 'empty_trailing_page_removed' | 'duplicate_option_value' | 'clamped' | 'required_disabled_resolved'
    | 'default_purpose_added' | 'compliance_defaulted' | 'initially_hidden_set' | 'aadhaar_truncated';
  detail: string;
}
export interface MigrationContext {
  idFactory: () => string;           // deterministic in tests
  now: IsoInstant;
  orgDefaults: { locale: Locale; timeZone: TimeZone; country: CountryCode };
  htmlToInline(html: string): InlineNode[];   // allowlist parser; never executes
  htmlToPlain(html: string): string;
  isSafePattern(src: string): boolean;
  registry: Pick<FieldRegistry, ValueFieldType>;
}
export interface V1MigrationResult {
  definition: FormDefinition;
  ops: Pick<FormOps, 'access' | 'retention'>;
  /** Hashed with argon2id by the API immediately; never persisted. */
  plaintextPasswordToHash?: string;
  assetImports: Array<{ target: 'logo' | 'cover'; url: string }>;
  notes: MigrationNote[];
}
export interface MigrationStep<From, To> { from: number; to: number; migrate(doc: From, ctx: MigrationContext): { doc: To; notes: MigrationNote[] } }
export interface AnswerCodec<T extends ValueFieldType> { type: T; upgrade(value: unknown, fromCodecVersion: number): AnswerValueMap[T] }

/* ═══════════════════════════════════════════════════════════════════════════
 * §19  PACKAGE ENTRY POINTS (pure unless noted)
 * ═════════════════════════════════════════════════════════════════════════ */

export interface EvalMeta {
    /**
   * Frozen per evaluation. Client: frozen at the session's startedAt (reset on resume), so client and server
   * agree. Server re-simulation uses clamp(client.startedAt, receivedAt−24h, receivedAt); access checks use receivedAt.
   */
  now: IsoInstant;
  timeZone: TimeZone;                // form tz
  locale: Locale;
  urlParams: Readonly<Record<string, string>>;
  device?: 'desktop' | 'tablet' | 'mobile';
  pageUrl?: string; referrer?: string; embedOrigin?: string;
  isPreview: boolean;
  holidayCalendars?: Readonly<Partial<Record<HolidayCalendarId, IsoDate[]>>>;
  shuffleSeed: string;               // per session
}

export interface EvalState {
  visible: ReadonlySet<BlockId | PageId>;
  required: ReadonlySet<BlockId>;
  disabled: ReadonlySet<BlockId>;
  hiddenOptions: Readonly<Partial<Record<BlockId, OptionId[]>>>;
  /** Answers after defaults/captures/set_value/calculations, with invisible, disabled and off-path answers removed. */
  values: Answers;
  variables: Readonly<Partial<Record<VariableId, ScalarValue>>>;
  submitBlocks: Array<{ ruleId: RuleId; message: string; atPage?: PageId; anchorBlockId?: BlockId }>;
  nextPage(from: PageId): PageId | { end: EndingId };
  path: PageId[];
  endingId: EndingId;
  serverEffects: Array<ServerAction & { ruleId: RuleId }>;     // server scope only
  trace?: Array<{ step: PlanStep; fired: boolean | null; diagnostics?: string[] }>; // LOG-22
}

export declare function validateDefinition(def: FormDefinition, mode: 'save' | 'publish', registry: FieldRegistry): PublishIssue[];
export declare function compile(def: FormDefinition, registry: FieldRegistry): { ok: true; compiled: CompiledForm } | { ok: false; issues: PublishIssue[] };
/** Publish: resolve live vars + brand refs, bump consent noticeVersion, compile, hash. */
export declare function resolveForPublish(draft: FormDefinition, ctx: { orgProfile: OrgProfile; brandKit: BrandKit | null; previous?: FormVersion }): { definition: FormDefinition; snapshot: VariablesSnapshot; issues: PublishIssue[] };
export declare function evaluate(version: FormVersion | RuntimeFormVersion, answers: Answers, meta: EvalMeta, scope: 'client' | 'server', opts?: { trace?: boolean }): EvalState;
export declare function projectForRuntime(version: FormVersion, status: RuntimeStatus, publicConfig: RuntimeFormVersion['publicConfig']): RuntimeFormVersion;
export declare function migrate(doc: AnyFormDocument, ctx: MigrationContext): { definition: FormDefinition; notes: MigrationNote[] };
export declare function instantiate(version: TemplateVersion, ctx: InstantiateContext): InstantiateResult;
export declare function insertSnippet(version: TemplateVersion, form: FormDefinition, at: { pageId: PageId; afterBlockId?: BlockId }, ctx: Omit<InstantiateContext, 'newFormId' | 'include'>): InsertSnippetResult;
export declare function lockFingerprint(doc: FormDefinition, binding: FormTemplateBinding, lock: LockSpec): Sha256Hex;
export declare function sanitizeForTemplate(def: FormDefinition, ops: FormOps | undefined, orgProfile: OrgProfile): { payload: FormTemplatePayload; piiHits: Array<{ path: string; kind: 'email' | 'phone_in' | 'pan' | 'aadhaar' | 'gstin' }>; warnings: TemplateWarning[] };
export declare function diffTemplate(base: TemplateVersion, theirs: TemplateVersion, ours: FormDefinition, binding: FormTemplateBinding): TemplateDiff;
```

**Negative type tests** (`packages/schema/test/types.negative.test-d.ts`):

```ts
import type * as S from './form-schema-v2';
declare const b: S.BlockId; declare const o: S.OptionId; declare const n: S.NotificationId; declare const g: S.ConditionId; declare const r: S.RuleId;
const when: S.ConditionGroup = { kind: 'group', id: g, combinator: 'all', children: [{ kind: 'condition', id: g, left: { kind: 'ref', ref: { kind: 'answer', blockId: b } }, op: 'includes_any', right: { kind: 'options', blockId: b, optionIds: [o] } }] };
export const pub: S.Rule<S.ClientAction> = { id: r, enabled: true, when, then: [{ type: 'show', targets: [b] }] };
// @ts-expect-error server-only action is not a ClientAction
export const bad: S.Rule<S.ClientAction> = { id: r, enabled: true, when, then: [{ type: 'mark_spam', reason: 'x' }] };
export const ok: S.AnswerValue = { type: 'single_choice', value: { optionId: o } };
// @ts-expect-error number answers are DecimalString, not JS numbers
export const badNum: S.AnswerValue = { type: 'number', value: 3 };
// @ts-expect-error template recipients cannot be literal addresses
export const badRcpt: S.RecipientPlaceholder = { kind: 'email', address: 'a@b.c' as S.EmailAddress };
void n;
// @ts-expect-error storing answers without consent is not configurable
export const badPriv: S.PrivacyConfig['dropAnswersWithoutConsent'] = false;
// @ts-expect-error server-only rule steps never reach the runtime plan
export const badStep: S.RuntimeFormVersion['compiled']['plan'][number] = { kind: 'rule', ruleId: r, scope: 'server' };
export const okStep: S.RuntimeFormVersion['compiled']['plan'][number] = { kind: 'rule', ruleId: r, scope: 'client+server' };
```

### 2.1 Where the templates spec is covered

| Spec item (`06-templates.md`) | Schema |
|---|---|
| 7 kinds and the payload union | `TemplateKind`, `TemplateVersionPayload` (exhaustiveness checked by `_kindsOk`) |
| Common payload fields: variables, locks, required features, i18n | `TemplatePayloadCommon` |
| `var` node, live vs bake binding, publish resolution, values snapshot | `VarNode`, `TemplateVariable.binding`, `resolveForPublish`, `FormVersion.variablesSnapshot` |
| Brand kits and `{ref:'brand.*'}` | `BrandKit`, `BrandRef` inside `ColorValue`, `ImageNode`, `ThemeTokens` and email `brandBlock` |
| Locked regions (P3) | `LockSpec`, `TemplateVersion.lockFingerprints`, `lockFingerprint()`, issue code `lock_violation` |
| Lineage | `Origin` stamps, `FormTemplateBinding`, `FormRecord.templateOrigin`, `FormVersion.templateLineage` |
| Fork lineage (TPL-32) | `TemplateForkBinding`, `Template.forkedFromVersionId` |
| Snippets | `SnippetTemplatePayload` with a `section` root (or a single block in P1), `insertSnippet` → `DocumentOp[]`, `keyMap` |
| Theme presets | `ThemeTemplatePayload`, `Theme.presetRef` |
| Email and ending templates | `EmailTemplatePayload` (placeholder recipients only), `EndingTemplatePayload` with `StatusScreenRole` → `FormOps.access.screens` |
| Updates and diff | `TemplateChange`, `TemplateDiff`, `ApplyUpdateRequest`, `updateState` |
| Bundles | `FormpackManifest`, `FormpackSignature`, `FormpackTemplateFile` |
| Governance | `OrgTemplateSettings`, `OrgProfile`, `TemplateCategory`, `TemplateLocalization` |

The DB tables and RLS from the templates spec §5 map one-to-one onto `Template`, `TemplateVersion`, `TemplateLocalization`, `TemplateCategory`, `BrandKit`, `OrgProfile`, `FormTemplateBinding`, `TemplateForkBinding` and `FormpackManifest`.

**Documented deltas from the templates spec text** (the spec has been updated to match):
1. `var` nodes use TipTap's `attrs` wrapper.
2. `Msg` is a default-locale string, with translations under `tplvar:` keys.
3. A snippet's logic variables are named `logicVariables`, so they do not collide with template `variables`.
4. Email `subject` is a `PlainTemplate` (single line with pipes and vars), not an inline AST.
5. PDF field selection is `all | by_classification | explicit`, not `byTag`.
6. `TemplateVariable.default` is `string | number | boolean`.
7. `OrgProfile.localized` covers every `OrgProfileTextField`, not only three fields.
8. The form variable for purposes is `form.purposes` (the old `form.purpose[]` failed the name regex).
9. Layout values are `'classic' | 'cards'` everywhere, including SQL checks.

---

## 3. Expression and calculation AST, and evaluation semantics

### 3.1 Expressions (`Expr`)

**Storage**
- Only the AST is stored. The builder uses a Pratt parser for author text and a printer that turns the AST back into text, so no source string can drift.
- Limits: at most 500 nodes, depth at most 32, lists at most 10,000 items, text results at most 10,000 characters.
- No `eval` or `Function`; only the whitelisted functions in `EXPR_FUNCTIONS` exist.

**Static types.** `compile()` infers the type of every node over `ExprType` and checks it against its context: calculation and variable `resultType`; `set_value` targets through the registry's `paths`; operands through the registry's `operators`. A mismatch is the publish error `expr_type_error`. Nothing is coerced implicitly, with three exceptions:
- `number` widens to `money` only through `money(n, currency)`;
- `text` → `number` only through `to_number`;
- an option → its label, code or score only through `option_*`.

**References**
- `answer` reads `registry.toScalar(value, path)`. An unanswered block, or one that is not effectively visible (because it, its section, its group or its page is hidden, or its page is off the path), reads as `null`. "Ignore hidden fields" is therefore always on, transitively.
- A repeating-group child outside a row scope reads as a `list` (for `sum`, `count`, `row_count`). Inside a row-scoped rule, `row:'current'` binds to that row.
- `variable` reads the computed value of a logic variable. `meta` reads the frozen `EvalMeta`.

**Numbers and money**
- Numbers use **decimal.js (full build)** at precision 34, so the trigonometric functions in `EXPR_FUNCTIONS` are exact-library implementations, never `Math.*`. Division and `pow` keep 10 decimal places with `ROUND_HALF_EVEN`. `^` takes integer exponents only; fractional exponents go through `pow`, which is checked.
- Money is exact minor units: `+` and `-` need the same currency; `money * number` gives money; money is rounded to minor units with `HALF_UP` whenever it is assigned or recorded with `money_round`; `gst_split(amount, ratePct, sameState)` returns `[cgst, sgst]` or `[igst]`, always summing exactly to the tax (the remainder goes to the first component).

**Null semantics.** Arithmetic, text and date functions given `null` return `null`. Aggregates skip nulls; `count` counts present values. `==` is null-safe. In conditions, `null` is false; `and` and `or` short-circuit and treat `null` as false. `coalesce` returns the first non-null value.

**Text**
- Values are NFC-normalised. Case-insensitive comparisons use a generated, locale-independent case-fold table (CaseFolding.txt C+S), never host `toLowerCase()`. `caseSensitive: true` opts out.
- `len` counts grapheme clusters with a **bundled segmenter pinned to one Unicode version** (generated tables, e.g. `graphemer`), never `Intl.Segmenter`, whose rules differ by host Unicode version (Indic conjunct rule GB9c changed in Unicode 15.1).
- Regex validation uses **one engine on both sides**: `re2js` (a pure-JS RE2 port) in the browser and on the server, so `\s`, `\w`, `\b` and case folding behave identically.

**Dates.** All date work happens in `behavior.timeZone`; `today` is the date of `meta.now` in that zone. `date_add(d, n, unit)` clamps to the end of the month. `date_diff` truncates towards zero. `age(dob)` is completed years. `working_days(a, b, calendarId?)` excludes Saturdays, Sundays and holiday-calendar dates. `now` and `today` are the only impure functions; both read the frozen clock.

**Totality.** No evaluation throws. Division by zero, overflow, invalid dates and index errors give `null` plus a diagnostic in the trace, shown in preview (LOG-22).

### 3.2 Conditions
- `ConditionGroup` uses `all` / `any`, optional `negate`, depth ≤ 5 and ≤ 100 leaves. An empty `all` is true; an empty `any` is false.
- The registry's `operators` map decides which operators apply to each `ComparableKind`.
- Choice `eq` is set equality on option ids; `includes_*` are set operations; `count_*` work on choices, files and group rows.
- Text `contains` / `starts_with` / `ends_with` use the case fold. The date aliases compile to `lt` / `gt` / `lte` / `gte`.
- Numbers are never compared as strings (fixes `logic.ts:55`).

### 3.3 Evaluation (`packages/logic`, engine `logic@2`)

1. **Cells.** Visibility `visible(b | p)`; path `onPath(p)`; field state `enabled(b)`, `required(b)`, `value(b[, path])`; logic `var(v)`, `optionHidden(b, o)`, `jump(p)`, `ending`; validation `submitBlock(p | form)`; server only `recipients(n)`, `variant(n)` and effect toggles.
2. **Compile.** Every rule, variable, calculation, capture and dynamic default becomes a step that reads and writes cells. A read of `value(b)` also reads `visible` of b and all its ancestors **and `onPath(pageOf(b))`**. `onPath(p)` is its own step (`kind: 'on_path'`) that reads the `jump` cells of every earlier page. A rule reads the cells in `when` and in its action expressions, and writes every target of both `then` and `else`.
3. **Same-cell writers.** Before sorting, an edge is added from each writer of a cell to the next writer of the same cell in authored order (w(i) → w(i+1)). The documented "last write wins in authored order" then holds whatever the other dependencies are. If those edges create a cycle, it is reported as `logic_cycle` with a "conflicting writers" hint. A golden test covers the case where rule A (index 0) depends on rule B (index 5) and rule C (index 2) also writes A's target.
4. **Cycles.** Any cycle in the step graph is the publish error `logic_cycle`, reported with its path.
5. **Page-order rule (I8).** A step that writes `visible`, `enabled`, `required`, `optionHidden`, `jump` or `submitBlock` for page P may only read cells on pages ≤ P, **transitively** through every cell it reads (variables, calculations and `onPath` included). Validation parameters that reference another block (`DateBound {kind:'field'}`, confirm-email, etc.) obey the same rule (`validation_bound_page_order`). Violations are publish errors. This is what makes page-scoped validation exact: Next on page P can never pass and then fail at submit.
6. **Order.** Kahn's topological sort, ties broken by authored rule index then by `documentOrder`, gives one total order. It is stored as `CompiledForm.plan` and recomputed and compared by the API at publish.
7. **Single pass.** One pass over the plan reaches the result because the graph is acyclic. The starting state is the authored values (`initiallyHidden`, `initiallyDisabled`, static `required`) plus answers after prefill, defaults and captures. `then` runs when `when` is true and `else` when false; a rule with no `else` writes nothing when false. Row-scoped rules run once per row, in row order.
8. **Effective state.** `visible_eff(b)` = visible(b) ∧ visible of every ancestor ∧ onPath(page). `required_eff(b)` = required(b) ∧ visible_eff(b) ∧ enabled(b) ∧ ¬readOnly-without-value. Disabled values are not submitted.
9. **Navigation.** The path starts at the first visible page. From page P, go to the target of the last active `skip_to_*` from P, otherwise the next visible page; targets must be later pages. Back pops the path. Next validates `required_eff`, the field schemas and the `submitBlock` entries on the current page only (fixes B1/B2).
10. **Taint (I13).** `compile()` computes, for every derived cell, the highest classification and the union of purposes of the cells it reads, into `CompiledForm.taint`. Derived values tainted `sensitive` are stored encrypted (`EncryptedScalar`) or not persisted, are never indexed for search, and are masked in notifications. Piping a tainted value into a subject line, URL, redirect or `fromName` is the publish error `sensitive_pipe_in_unsafe_context`. `declassify` lowers taint with an audited reason.
11. **Clock and meta.** The client freezes `meta.now` at the session's `startedAt` (reset when a draft is resumed). The server evaluates with `clamp(client.startedAt, receivedAt−24h, receivedAt)`; access windows use `receivedAt`. `pageUrl`, `referrer` and `device` are sent in `SubmissionRequest.client` so both sides evaluate the same inputs (they are advisory, not security inputs).
12. **Server side** (`scope: 'server'`). The server runs the identical plan with the same `EvalMeta` contract, then:
    - re-simulates the path from the final answers, ignoring `pageTrail`;
    - drops answers that are not `visible_eff`, are disabled, or whose purposes are all consent-based and not granted (B3, CMP-19, LOG-25);
    - recomputes variables, calculations and payment totals, returning 422 `amount_changed` if the client's advisory total differs;
    - validates with `packages/validation`;
    - only then runs the server-only actions from `serverEffects`.
13. **Determinism.** No host clocks, no `Math.random` (shuffles use `meta.shuffleSeed`), no floats, no locale-dependent string functions, no host Unicode tables. The fixture corpus runs in Node **and in Playwright on Chromium, Firefox and WebKit**; every engine's `EvalState` JSON must be byte-identical to Node's. (Vitest's jsdom runs in Node's V8 and proves nothing about other engines.) A version is always evaluated by the engine it was compiled with; changing semantics means a new engine id, and old engines keep their contract tests.
14. **Incremental client evaluation.** The runtime projection keeps `reads` (filtered to client steps), so the renderer re-runs only the steps downstream of a changed cell, using `useWatch` per block (FND-13). The result equals a full pass.

---

## 4. v1 → v2 migration plan

### 4.1 Rules for each lifecycle
- **No `schemaVersion` means v1.** `migrate()` runs pure steps in sequence (v1→v2→…), with ids from `ctx.idFactory` (deterministic in tests).
- **Drafts** are upgraded when loaded, saved back with `draftRev++`, and audited. The `MigrationNote[]` list is shown in the builder.
- **Published `FormVersion` rows are never rewritten.** They are upgraded in memory when read, cached by `(versionId, SCHEMA_VERSION)`; `contentHash` stays the hash of the stored bytes.
- **Answers are never bulk-rewritten.** They are tagged `{type, value}` with `answerCodecVersion`; `AnswerCodec.upgrade` handles shape changes on read.
- **Templates** are authored as data in `packages/templates`, so they migrate at build time. Pack import runs `migrate()` before validating.
- **What needs `schemaVersion` 3:** removing or renaming a field, changing an answer shape, or changing what a tag means. Additive optional fields bump `revision`. A new block type adds a `Capability`, and old readers fail closed through `UnsupportedBlock`.

### 4.2 Mapping (`migrateV1ToV2`)

**Structure**

| v1 (`src/types/form.ts`) | v2 |
|---|---|
| `blocks[]` sorted by `order`, with `page_break` markers | `blocks` map plus `pages[].children`. Each break's id becomes the next page's id. `order` is dropped |
| Trailing page with no input | Removed (B10) |
| `thank_you` blocks, `successMessage`, `successAnimation` | `endings[]` with `kind: 'message'` and `confetti`. The first is the default |
| `redirectUrl` | A redirect ending only if it is `https:`, and it becomes the default; otherwise dropped with a note (S6) |

**Block types**

| v1 | v2 |
|---|---|
| `heading`, `heading_2`, `heading_3` | `heading` with `level` 1, 2 or 3 |
| `text` | `short_text` |
| `multiple_choice` / `dropdown` | `single_choice` with `display` radio / dropdown |
| `checkbox` / `multi_select` | `multi_choice` with `display` checkbox / dropdown (fixes B25) |
| `hidden` | `hidden` with `source: {kind:'url_param'}`, keyed by `key` (fixes B26). The v1 `label` becomes the builder `note` |

**Labels, options and logic**

| v1 | v2 |
|---|---|
| Raw HTML labels and help text | Allowlist parser to `InlineDoc` / `RichDoc`. Anything else becomes text; `javascript:` links are removed (S1–S4) |
| Option `{id, label, value}` | `id` is kept as the stored value and `value` becomes `code`. Duplicate values are noted (B15, B16) |
| `BlockLogic` | One `Rule` with one condition and `then: [show\|hide target]`. For `show`, the target gets `initiallyHidden: true`, so behaviour is identical. A dangling source disables the rule (B21) |
| `equals` / `not_equals` | `eq` / `neq` with `caseSensitive: true` (keeps v1 behaviour) |
| `greater_than` / `less_than` | `gt` / `lt` on a numeric literal |
| `answered` | `is_answered` |
| `not_answered` / `is_empty` | `is_not_answered` |
| Logic on a choice source | Values are matched to an option by `value`, then by `label`, giving a typed `options` operand. No match disables the rule (`logic_value_unmatched`) |

**Validation and properties**

| v1 | v2 |
|---|---|
| `validation.min/max/pattern/errorMessage` | Type-specific `config` fields and `messages`. An unsafe or invalid regex is dropped with a note (B12, S8). Email `pattern` was ignored in v1 anyway (B13) |
| `customize.*` | Split into `config` (behaviour), `style` (PROP-14) and the shared envelope flags |
| `ratingMax`, `scaleMax` | Clamped to 10 (B28) |
| `width: half` without `besidePrevious` | `layout.startNewRow: true` |
| `disabled` + `required` | Becomes `readOnly`, not required (B27) |
| (none) | `key` = slug of the plain label, de-duplicated (note `key_generated`) |
| (none) | `compliance` = the registry default |

**Settings**

| v1 | v2 |
|---|---|
| `password` | Extracted, hashed by the API with argon2id into `FormOps.access.password`, never written back (S5) |
| `closed`, `closedMessage` | `FormOps.access.enabled` and `screens.closed` |
| `logoUrl`, `coverUrl` | Queued for import into the asset store; dropped if unreachable (S7) |
| Colours, font, `progressBar`, `submitButtonText` | `theme.tokens` (hex validated) and `behavior` |
| (none) | `privacy`: fiduciary details become `org.*` variable templates (`org.legal_name`, `org.privacy_contact.*`, rights and Board text), plus a default purpose "Respond to this form" with lawful basis `legitimate_use / s7a_voluntarily_provided_for_specified_purpose` and retention = org default. The notice is unapproved, so publish needs `compliance.approve_notice` (CMP-24) |

### 4.3 Order of work (keeps the builder working, per FND-01)

1. **P0-a.** Add `packages/schema` with v2 types, the zod twins, the `V1` namespace and `migrate`. Build a fixture corpus: the 5 `data/templates.ts` forms plus hand-made v1 forms covering B1–B28. Golden and property tests check that migration is deterministic and idempotent, that output passes `validateDefinition(...,'save')`, and that v1 and v2 show/hide agree on a matrix of fixture answers.
2. **P0-b.** Build the field registry (`packages/registry`, FND-03) over `BlockConfigMap`. The builder still reads v1 through a v2 adapter (`migrate` on load).
3. **P0-c.** Switch the builder store to v2 documents (FND-10). Rich text moves to TipTap (FND-08). `packages/logic` gets `compile` and `evaluate`, with v1 semantics reproduced through `initiallyHidden` plus single-condition rules (FND-06).
4. **P0-d.** Templates WP-T0.1–0.3: author the 5 templates as v2 payloads in `packages/templates`, delete `src/data/templates.ts`, and have `TemplateModal` call `instantiate()`. This lands before WP-1.06 swaps the persistence adapter to the API.
5. **P1.** The API stores drafts as v2 only and rejects any other `schemaVersion` on write. The import endpoint accepts v1 JSON and runs `migrate` on the server, which hashes the password in that request. Publish runs `resolveForPublish` and then `compile`.
6. **Deprecation.** The client-side v1 reader is removed after one release. The server reader stays for imports and old local exports.

---

## 5. Decisions (formerly open questions)

Each former open question now has a decision, a deadline from the delivery plan (§9 there) and an owner. Items marked **PO** need the product owner's confirmation; the default applies if nobody objects by the deadline.

| # | Question | Decision (default) | Deadline |
|---|---|---|---|
| 1 | I8 vs JotForm imports | The BLD-15 importer moves the dependent field to a later page and adds a note; it never fails silently | P2 W6 |
| 2 | `initiallyHidden` explicit | The builder sets and clears it automatically when show rules are added or removed; `initially_hidden_never_shown` is the safety net | P0 W7 |
| 3 | Unreviewed default purpose | Publish is **blocked** until a user with `compliance.approve_notice` approves the notice (CMP-24). This replaces the "warn in P1" default because the DPDP Rules apply from about 13 May 2027 | P1 W4 (**PO**) |
| 4 | Purposes from several snippets | Merged by origin `sourceId`; two different purposes with the same name stay separate | P2 W4 |
| 5 | Shortening retention without republishing | Allowed without a new notice version, because only shortening is possible; the statutory floor still applies (counsel to confirm) | P1 W10 (counsel) |
| 6 | Money representation | `MinorUnits` string | P0 W2 |
| 7 | JotForm date-with-time | `datetime` when the JotForm field has time enabled, else `date` | P2 W6 |
| 8 | Locks not stored on the form | Accepted; locks load through bindings in P3 | — |
| 9 | Notification referencing a deleted block | Renders empty with a builder warning | P1 W9 |
| 10 | Row-scoped rules | Ship behind a flag in WP-2.09 with extra fuzzing | P2 |
| 11 | Optional template parts | Keep, limited to `form` templates; the authoring UI ships with TPL-18 | P2 W8 (**PO**) |
| 12 | Consent translations | System packs carry signed reviewer attestations per locale, so customer forms are not blocked on day one | P1 W12 |
