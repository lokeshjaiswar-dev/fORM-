import type { _ExactKeys } from './_internal.ts';
import type { Answers } from './answers.ts';
import type { Block } from './blocks.ts';
import type { DataClassification, Purpose } from './compliance.ts';
import type { FormDefinition } from './definition.ts';
import type { I18nBundle, TextKey, TranslationEntry } from './i18n.ts';
import type { AssetId, BlockId, BrandKitId, CountryCode, EmailAddress, FieldKey, FontId, FormId, HexColor, IsoInstant, Locale, LockId, OptionId, OrgId, PageId, SafeUrl, Sha256Hex, TeamId, TemplateBindingId, TemplateCategoryId, TemplateId, TemplatePackId, TemplatePartId, TemplateVersionId, UserId, WorkflowId, WorkflowStepId } from './ids.ts';
import type { ConditionGroup, Recipient, Rule, Variable } from './logic.ts';
import type { AccessConfig, EmailDoc, FormOps, StatusScreenRole } from './ops.ts';
import type { EndingAction } from './pages.ts';
import type { PlainTemplate, RichDoc } from './rich-text.ts';
import type { BrandRef, TemplateVariableName } from './template-primitives.ts';
import type { ThemeTokens } from './theme.ts';

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

/** `field:payment`, `integration:google_sheets`, `capability:appointments`… checked against edition/plan. */
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
