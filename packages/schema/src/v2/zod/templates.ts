import { z } from 'zod';
import { keyed } from './_util.ts';
import { TEMPLATE_KINDS, TEMPLATE_SCOPES, TEMPLATE_VERSION_STATES } from '../templates.ts';
import type { TemplateKind, TemplateVersionPayload } from '../templates.ts';
import { AnswersSchema } from './answers.ts';
import { BlockSchema } from './blocks.ts';
import { DataClassificationSchema, PurposeSchema } from './compliance.ts';
import { FormDefinitionSchema } from './definition.ts';
import { I18nBundleSchema, TextKeySchema, TranslationEntrySchema } from './i18n.ts';
import { ConditionGroupSchema, RuleSchema, VariableSchema } from './logic.ts';
import { MigrationNoteSchema } from './migration.ts';
import { AccessConfigSchema, EmailDocSchema, FormOpsSchema, PdfLayoutSchema, StatusScreenRoleSchema } from './ops.ts';
import { EndingActionSchema } from './pages.ts';
import {
  AssetIdSchema, BlockIdSchema, BrandKitIdSchema, BrandRefSchema, CountryCodeSchema, EmailAddressSchema, FieldKeySchema, FontIdSchema, FormIdSchema,
  HexColorSchema, IsoDateSchema, IsoInstantSchema, LocaleSchema, LockIdSchema, OptionIdSchema, OrgIdSchema, PageIdSchema, SafeUrlSchema, Sha256HexSchema,
  TeamIdSchema, TemplateBindingIdSchema, TemplateCategoryIdSchema, TemplateIdSchema, TemplatePackIdSchema, TemplatePartIdSchema,
  TemplateVariableNameSchema, TemplateVersionIdSchema, UserIdSchema, WorkflowIdSchema, WorkflowStepIdSchema,
} from './primitives.ts';
import { PlainTemplateSchema, RichDocSchema } from './rich-text.ts';
import { ThemeTokensSchema } from './theme.ts';

const sourceId = z.string().min(1).max(128);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,127}$/);
const role = z.enum(['form_owner', 'org_admins', 'team_admins']);

export const TemplateKindSchema = z.enum(TEMPLATE_KINDS);
export const TemplateScopeSchema = z.enum(TEMPLATE_SCOPES);
export const TemplateLifecycleSchema = z.enum(['active', 'deprecated', 'archived']);
export const TemplateVersionStateSchema = z.enum(TEMPLATE_VERSION_STATES);
export const FeatureIdSchema = z.templateLiteral([z.enum(['field', 'integration', 'capability', 'plan']), ':', z.string()]);

export const MsgSchema = z.string().max(2000);
export const TemplateVariableSchema = z.strictObject({
  name: TemplateVariableNameSchema,
  source: z.enum(['org_profile', 'brand_kit', 'form', 'prompt']),
  type: z.enum(['text', 'rich', 'email', 'phone', 'url', 'image', 'color', 'date', 'number', 'select', 'boolean']),
  label: MsgSchema,
  help: MsgSchema.exactOptional(),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).exactOptional(),
  options: z.array(z.strictObject({ value: z.string(), label: MsgSchema })).exactOptional(),
  binding: z.enum(['live', 'bake']),
});

export const LockModeSchema = z.enum(['content', 'structure', 'presence']);
export const LockSpecSchema = z.strictObject({
  id: LockIdSchema,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('block'), sourceId }),
    z.strictObject({ kind: z.literal('theme'), tokens: z.array(z.string()) }),
    z.strictObject({ kind: z.literal('ending'), sourceId }),
    z.strictObject({ kind: z.literal('email'), sourceId, parts: z.array(z.enum(['subject', 'body', 'footer'])) }),
    z.strictObject({ kind: z.literal('pdf'), sourceId, parts: z.array(z.enum(['header', 'footer'])) }),
    z.strictObject({ kind: z.literal('purpose'), sourceId }),
  ]),
  modes: z.array(LockModeSchema).min(1),
  reason: MsgSchema,
});

export const TemplateRefSchema = z.strictObject({ templateId: TemplateIdSchema, versionId: TemplateVersionIdSchema });

const payloadCommon = {
  schemaVersion: z.number().int().min(1),
  variables: z.array(TemplateVariableSchema),
  locks: z.array(LockSpecSchema),
  requiredFeatures: z.array(FeatureIdSchema),
  i18n: I18nBundleSchema.pick({ defaultLocale: true, locales: true, messages: true }),
};

export const DataInventoryEntrySchema = z.strictObject({
  purposeName: z.string().max(200),
  fieldSourceIds: z.array(sourceId),
  classification: DataClassificationSchema,
  suggestedRetentionDays: z.number().int().min(1).max(3650).exactOptional(),
  encrypted: z.boolean(),
});

const sourceIds = z.array(sourceId).exactOptional();
export const TemplateOptionalPartSchema = z.strictObject({
  id: TemplatePartIdSchema,
  label: MsgSchema,
  when: z.strictObject({ variable: TemplateVariableNameSchema, equals: z.union([z.string(), z.boolean()]) }),
  includes: z.strictObject({
    blockSourceIds: sourceIds, pageSourceIds: sourceIds, ruleSourceIds: sourceIds,
    variableSourceIds: sourceIds, endingSourceIds: sourceIds, purposeSourceIds: sourceIds,
  }),
});

/** Placeholders only: a literal address or a member is unrepresentable in a template. */
export const RecipientPlaceholderSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('field'), blockId: BlockIdSchema }),
  z.strictObject({ kind: z.literal('role'), role }),
]);

export const ThemeTemplatePayloadSchema = z.strictObject({
  ...payloadCommon,
  kind: z.literal('theme'),
  layout: z.enum(['classic', 'cards']),
  tokens: ThemeTokensSchema,
  customCss: z.string().max(50 * 1024).exactOptional(),
});

export const EmailTemplateRoleSchema = z.enum([
  'notification', 'autoresponder', 'edit_notice', 'invite', 'resume_link', 'otp', 'withdrawal_confirm', 'dsr_response', 'breach_notice',
  'guardian_consent_request',
]);
export const EmailTemplatePayloadSchema = z.strictObject({
  ...payloadCommon,
  kind: z.literal('email'),
  role: EmailTemplateRoleSchema,
  subject: PlainTemplateSchema,
  body: EmailDocSchema,
  headerRef: z.union([BrandRefSchema, z.strictObject({ ref: z.literal('brand.email_header') })]).exactOptional(),
  footerRef: z.strictObject({ ref: z.enum(['brand.email_footer', 'brand.legal_footer']) }).exactOptional(),
  replyTo: RecipientPlaceholderSchema.exactOptional(),
  defaultRecipients: z.array(RecipientPlaceholderSchema).exactOptional(),
  includeWithdrawalLink: z.boolean().exactOptional(),
});

export const EndingTemplateRoleSchema = z.union([z.literal('thank_you'), StatusScreenRoleSchema]);
export const EndingTemplatePayloadSchema = z.strictObject({
  ...payloadCommon,
  kind: z.literal('ending'),
  role: EndingTemplateRoleSchema,
  content: RichDocSchema,
  actions: z.array(EndingActionSchema),
  redirect: PlainTemplateSchema.exactOptional(),
  confetti: z.boolean().exactOptional(),
});

export const PdfTemplatePayloadSchema = z.strictObject({ ...payloadCommon, kind: z.literal('pdf'), layout: PdfLayoutSchema });

export const SnippetTemplatePayloadSchema = z.strictObject({
  ...payloadCommon,
  kind: z.literal('snippet'),
  rootId: BlockIdSchema,
  blocks: keyed(z.partialRecord(BlockIdSchema, BlockSchema)),
  rules: z.array(RuleSchema),
  logicVariables: z.array(VariableSchema),
  purposes: z.array(PurposeSchema),
  insertHints: z.strictObject({ preferredPosition: z.enum(['start', 'end', 'before_submit']).exactOptional(), oncePerForm: z.boolean() }),
});

const stepBase = { id: WorkflowStepIdSchema, name: z.string().max(200) };
export const WorkflowStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...stepBase,
    kind: z.literal('approval'),
    approver: z.union([RecipientPlaceholderSchema, z.strictObject({ kind: z.literal('role'), role })]),
    emailTemplate: TemplateRefSchema.exactOptional(),
    onApprove: z.union([WorkflowStepIdSchema, z.literal('end_approved')]),
    onDeny: z.union([WorkflowStepIdSchema, z.literal('end_denied')]),
  }),
  z.strictObject({
    ...stepBase,
    kind: z.literal('branch'),
    branches: z.array(z.strictObject({ when: ConditionGroupSchema, next: WorkflowStepIdSchema })),
    otherwise: WorkflowStepIdSchema,
  }),
  z.strictObject({
    ...stepBase,
    kind: z.literal('notify'),
    to: z.array(RecipientPlaceholderSchema),
    emailTemplate: TemplateRefSchema,
    next: z.union([WorkflowStepIdSchema, z.literal('end')]),
  }),
]);
export const WorkflowDefinitionSchema = z.strictObject({ id: WorkflowIdSchema, name: z.string().max(200), start: WorkflowStepIdSchema, steps: z.array(WorkflowStepSchema).min(1) });
export const WorkflowTemplatePayloadSchema = z.strictObject({ ...payloadCommon, kind: z.literal('workflow'), workflow: WorkflowDefinitionSchema });

export const FormTemplatePayloadSchema = z.strictObject({
  ...payloadCommon,
  kind: z.literal('form'),
  document: FormDefinitionSchema,
  refs: z.strictObject({
    theme: z.union([TemplateRefSchema, ThemeTemplatePayloadSchema]).exactOptional(),
    endings: z.array(z.union([TemplateRefSchema, EndingTemplatePayloadSchema])).exactOptional(),
    emails: z.array(z.union([TemplateRefSchema, EmailTemplatePayloadSchema])).exactOptional(),
    pdf: z.array(z.union([TemplateRefSchema, PdfTemplatePayloadSchema])).exactOptional(),
    workflow: z.union([TemplateRefSchema, WorkflowTemplatePayloadSchema]).exactOptional(),
  }).exactOptional(),
  sampleAnswers: AnswersSchema.exactOptional(),
  dataInventory: z.array(DataInventoryEntrySchema),
  estimatedMinutes: z.number().min(0).max(600),
  optionalParts: z.array(TemplateOptionalPartSchema).exactOptional(),
});

export const TemplateVersionPayloadSchema = z.discriminatedUnion('kind', [
  FormTemplatePayloadSchema, ThemeTemplatePayloadSchema, EmailTemplatePayloadSchema, EndingTemplatePayloadSchema,
  PdfTemplatePayloadSchema, SnippetTemplatePayloadSchema, WorkflowTemplatePayloadSchema,
]);
export const TEMPLATE_PAYLOAD_SCHEMAS = {
  form: FormTemplatePayloadSchema,
  theme: ThemeTemplatePayloadSchema,
  email: EmailTemplatePayloadSchema,
  ending: EndingTemplatePayloadSchema,
  pdf: PdfTemplatePayloadSchema,
  snippet: SnippetTemplatePayloadSchema,
  workflow: WorkflowTemplatePayloadSchema,
} as const satisfies { [K in TemplateKind]: z.ZodType<Extract<TemplateVersionPayload, { kind: K }>> };

export const TemplateSchema = z.strictObject({
  id: TemplateIdSchema,
  orgId: OrgIdSchema.nullable(),
  teamId: TeamIdSchema.nullable(),
  ownerUserId: UserIdSchema.nullable(),
  scope: TemplateScopeSchema,
  kind: TemplateKindSchema,
  slug,
  lifecycle: TemplateLifecycleSchema,
  source: z.enum(['system_pack', 'pack_import', 'user', 'clone', 'jotform_import', 'ai']),
  packId: TemplatePackIdSchema.exactOptional(),
  forkedFromVersionId: TemplateVersionIdSchema.exactOptional(),
  currentVersionId: TemplateVersionIdSchema.exactOptional(),
  defaultLocale: LocaleSchema,
  industries: z.array(z.string().max(64)),
  tags: z.array(z.string().max(64)),
  categoryIds: z.array(TemplateCategoryIdSchema),
  layout: z.enum(['classic', 'cards']).exactOptional(),
  featured: z.boolean(),
  sortWeight: z.number(),
  createdBy: UserIdSchema.exactOptional(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  deletedAt: IsoInstantSchema.exactOptional(),
});

export const TemplateVersionSchema = z.strictObject({
  id: TemplateVersionIdSchema,
  templateId: TemplateIdSchema,
  orgId: OrgIdSchema.nullable(),
  version: z.number().int().min(1),
  state: TemplateVersionStateSchema,
  schemaVersion: z.number().int().min(1),
  payload: TemplateVersionPayloadSchema,
  payloadHash: Sha256HexSchema,
  lockFingerprints: keyed(z.partialRecord(LockIdSchema, Sha256HexSchema)),
  requiredFeatures: z.array(FeatureIdSchema),
  locales: z.array(LocaleSchema),
  changeLevel: z.enum(['patch', 'minor', 'major']).exactOptional(),
  changelog: z.string().max(10_000).exactOptional(),
  mandatory: z.boolean(),
  mandatoryDeadline: IsoInstantSchema.exactOptional(),
  thumbnailAssetId: AssetIdSchema.exactOptional(),
  stats: z.strictObject({ fields: z.number().int().min(0), pages: z.number().int().min(0), estMinutes: z.number().min(0), hasSensitive: z.boolean() }),
  review: z.strictObject({
    submittedAt: IsoInstantSchema.exactOptional(),
    reviewedBy: UserIdSchema.exactOptional(),
    reviewedAt: IsoInstantSchema.exactOptional(),
    comment: z.string().max(5000).exactOptional(),
  }).exactOptional(),
  publishedAt: IsoInstantSchema.exactOptional(),
  packSignature: z.strictObject({ keyId: z.string().min(1), sig: z.string().min(1) }).exactOptional(),
  createdBy: UserIdSchema.exactOptional(),
  createdAt: IsoInstantSchema,
});

export const TemplateLocalizationSchema = z.strictObject({
  templateVersionId: TemplateVersionIdSchema,
  locale: LocaleSchema,
  title: z.string().max(200),
  summary: z.string().max(1000),
  description: RichDocSchema.exactOptional(),
  fieldLabels: z.string(),
  completeness: z.number().min(0).max(100),
});

export const TemplateCategorySchema = z.strictObject({
  id: TemplateCategoryIdSchema,
  orgId: OrgIdSchema.nullable(),
  facet: z.enum(['use_case', 'industry', 'compliance']),
  parentId: TemplateCategoryIdSchema.exactOptional(),
  slug,
  names: keyed(z.partialRecord(LocaleSchema, z.string().max(200))),
  icon: z.string().max(64).exactOptional(),
  kinds: z.array(TemplateKindSchema),
  sort: z.number(),
});

export const BrandKitTokensSchema = z.strictObject({
  name: z.string().max(200),
  logos: z.strictObject({ primary: AssetIdSchema, dark: AssetIdSchema.exactOptional(), square: AssetIdSchema.exactOptional(), favicon: AssetIdSchema.exactOptional() }),
  colors: z.strictObject({
    primary: HexColorSchema, secondary: HexColorSchema, accent: HexColorSchema, background: HexColorSchema, surface: HexColorSchema,
    text: HexColorSchema, muted: HexColorSchema, error: HexColorSchema, success: HexColorSchema,
  }),
  typography: z.strictObject({ heading: FontIdSchema, body: FontIdSchema, baseSize: z.number().min(10).max(32) }),
  shape: z.strictObject({ radius: z.enum(['none', 'sm', 'md', 'lg', 'full']), density: z.enum(['compact', 'comfortable']) }),
  email: z.strictObject({ header: RichDocSchema.exactOptional(), footer: RichDocSchema }),
  pdf: z.strictObject({ header: RichDocSchema.exactOptional(), footer: RichDocSchema.exactOptional() }),
  legalFooter: RichDocSchema.exactOptional(),
});
export const BrandKitSchema = z.strictObject({
  id: BrandKitIdSchema,
  orgId: OrgIdSchema,
  teamId: TeamIdSchema.exactOptional(),
  isDefault: z.boolean(),
  tokens: BrandKitTokensSchema,
  updatedBy: UserIdSchema,
  updatedAt: IsoInstantSchema,
  deletedAt: IsoInstantSchema.exactOptional(),
});

export const OrgProfileTextFieldSchema = z.enum([
  'display_name', 'legal_name', 'registered_address', 'board_complaint_info', 'privacy_contact.name', 'privacy_contact.designation', 'privacy_contact.address', 'dpo.name',
]);
export const PostalAddressSchema = z.strictObject({
  line1: z.string().max(200),
  line2: z.string().max(200).exactOptional(),
  city: z.string().max(200),
  state: z.string().max(200),
  stateCode: z.string().max(16).exactOptional(),
  postalCode: z.string().max(32),
  country: CountryCodeSchema,
});
export const OrgProfileSchema = z.strictObject({
  orgId: OrgIdSchema,
  displayName: z.string().max(200),
  legalName: z.string().max(200).exactOptional(),
  cin: z.string().max(32).exactOptional(),
  gstin: z.string().max(32).exactOptional(),
  industry: z.string().max(64).exactOptional(),
  registeredAddress: PostalAddressSchema.exactOptional(),
  website: SafeUrlSchema.exactOptional(),
  supportEmail: EmailAddressSchema.exactOptional(),
  supportPhone: z.string().max(32).exactOptional(),
  privacyPolicyUrl: SafeUrlSchema.exactOptional(),
  termsUrl: SafeUrlSchema.exactOptional(),
  rightsUrl: SafeUrlSchema.exactOptional(),
  boardComplaintInfo: z.string().max(2000).exactOptional(),
  privacyContact: z.strictObject({
    name: z.string().max(200),
    designation: z.string().max(200).exactOptional(),
    email: EmailAddressSchema,
    phone: z.string().max(32).exactOptional(),
    address: PostalAddressSchema.exactOptional(),
  }).exactOptional(),
  dpo: z.strictObject({ name: z.string().max(200), email: EmailAddressSchema, phone: z.string().max(32).exactOptional() }).exactOptional(),
  localized: keyed(z.partialRecord(LocaleSchema, keyed(z.partialRecord(OrgProfileTextFieldSchema, z.string().max(2000))))),
  updatedAt: IsoInstantSchema,
  updatedBy: UserIdSchema,
});

export const OrgTemplateSettingsSchema = z.strictObject({
  publishPolicy: z.enum(['admins_only', 'members_direct', 'members_with_review']),
  reviewers: z.strictObject({ roles: z.array(z.enum(['owner', 'admin'])), userIds: z.array(UserIdSchema) }),
  allowPersonal: z.boolean(),
  showSystemGallery: z.boolean(),
  allowedSystemCategories: z.array(TemplateCategoryIdSchema).nullable(),
  requireBrandKitOnUse: z.boolean(),
  allowUnsignedImport: z.boolean(),
});

const updateState = z.union([z.enum(['current', 'available', 'required']), z.templateLiteral(['dismissed@', z.number()])]);
export const FormTemplateBindingSchema = z.strictObject({
  id: TemplateBindingIdSchema,
  orgId: OrgIdSchema,
  formId: FormIdSchema,
  templateId: TemplateIdSchema,
  templateVersionId: TemplateVersionIdSchema,
  kind: TemplateKindSchema,
  instanceRootId: z.string().max(128).exactOptional(),
  idMap: keyed(z.record(z.string(), z.string())),
  keyMap: keyed(z.record(z.string(), FieldKeySchema)).exactOptional(),
  updateState,
  governance: z.enum(['bound', 'detached']),
  appliedBy: UserIdSchema,
  appliedAt: IsoInstantSchema,
});

export const TemplateForkBindingSchema = z.strictObject({
  id: z.string().min(1).max(64),
  orgId: OrgIdSchema,
  templateId: TemplateIdSchema,
  upstreamTemplateId: TemplateIdSchema,
  upstreamVersionId: TemplateVersionIdSchema,
  idMap: keyed(z.record(z.string(), z.string())),
  updateState,
});

export const InstantiateContextSchema = z.strictObject({
  newFormId: FormIdSchema,
  idSeed: z.string().min(1),
  bindingIdSeed: z.string().min(1),
  locale: LocaleSchema,
  extraLocales: z.array(LocaleSchema),
  orgProfile: OrgProfileSchema.nullable(),
  brandKit: BrandKitSchema.nullable(),
  variables: keyed(z.partialRecord(TemplateVariableNameSchema, z.union([z.string(), z.number(), z.boolean()]))),
  include: z.strictObject({ theme: z.boolean(), emails: z.boolean(), endings: z.boolean(), pdf: z.boolean(), workflow: z.boolean() }),
  now: IsoInstantSchema,
});

export const TemplateWarningSchema = z.strictObject({
  code: z.enum(['sensitive_fields', 'variable_missing', 'feature_unavailable', 'part_removed_rule', 'key_renamed', 'locale_incomplete']),
  message: z.string(),
  at: z.string().exactOptional(),
});

export const InstantiateResultSchema = z.strictObject({
  definition: FormDefinitionSchema,
  ops: FormOpsSchema.pick({ notifications: true, pdfTemplates: true }).extend({ screens: AccessConfigSchema.shape.screens }),
  bindings: z.array(FormTemplateBindingSchema),
  workflow: WorkflowDefinitionSchema.exactOptional(),
  warnings: z.array(TemplateWarningSchema),
});

export const DocumentOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add_block'),
    block: BlockSchema,
    parent: z.union([z.strictObject({ pageId: PageIdSchema }), z.strictObject({ blockId: BlockIdSchema })]),
    index: z.number().int().min(0),
  }),
  z.strictObject({ op: z.literal('add_rule'), rule: RuleSchema, index: z.number().int().min(0) }),
  z.strictObject({ op: z.literal('add_variable'), variable: VariableSchema }),
  z.strictObject({ op: z.literal('add_purpose'), purpose: PurposeSchema }),
  z.strictObject({ op: z.literal('set_messages'), locale: LocaleSchema, entries: keyed(z.partialRecord(TextKeySchema, TranslationEntrySchema)) }),
]);
export const InsertSnippetResultSchema = z.strictObject({
  ops: z.array(DocumentOpSchema),
  binding: FormTemplateBindingSchema,
  keyMap: keyed(z.record(z.string(), FieldKeySchema)),
  warnings: z.array(TemplateWarningSchema),
});

const changeId = z.string().min(1).max(128);
export const TemplateChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: changeId, kind: z.enum(['block.added', 'block.removed', 'block.moved']), sourceId, conflict: z.boolean() }),
  z.strictObject({ id: changeId, kind: z.literal('prop.changed'), sourceId, path: z.string(), base: z.unknown(), theirs: z.unknown(), ours: z.unknown(), conflict: z.boolean() }),
  z.strictObject({ id: changeId, kind: z.enum(['option.added', 'option.removed', 'option.relabelled']), sourceId, optionId: OptionIdSchema, conflict: z.boolean() }),
  z.strictObject({ id: changeId, kind: z.enum(['rule.added', 'rule.removed', 'rule.changed']), sourceId, conflict: z.boolean() }),
  z.strictObject({ id: changeId, kind: z.literal('theme.token.changed'), token: z.string(), conflict: z.boolean() }),
  z.strictObject({ id: changeId, kind: z.enum(['ending.changed', 'email.changed', 'pdf.changed', 'purpose.changed']), sourceId, conflict: z.boolean() }),
  z.strictObject({ id: changeId, kind: z.literal('lock.changed'), lockId: LockIdSchema, conflict: z.literal(false) }),
]);
export const TemplateDiffSchema = z.strictObject({
  bindingId: TemplateBindingIdSchema,
  from: z.number().int().min(1),
  to: z.number().int().min(1),
  changelog: z.string(),
  changes: z.array(TemplateChangeSchema),
});
export const ApplyUpdateRequestSchema = z.strictObject({
  to: z.number().int().min(1),
  decisions: z.array(z.strictObject({ changeId, choice: z.enum(['theirs', 'ours']) })),
  draftRev: z.number().int().min(0),
});

const packFile = z.strictObject({ path: z.string().min(1), sha256: Sha256HexSchema });
export const FormpackManifestSchema = z.strictObject({
  format: z.literal('fORM-template-bundle'),
  formatVersion: z.literal(1),
  pack: z.strictObject({ publisher: z.string().min(1), name: z.string().min(1), version: z.string().min(1) }),
  minAppVersion: z.string().min(1),
  schemaVersion: z.number().int().min(1),
  templates: z.array(z.strictObject({
    slug,
    kind: TemplateKindSchema,
    version: z.number().int().min(1),
    path: z.string().min(1),
    sha256: Sha256HexSchema,
    requiredFeatures: z.array(FeatureIdSchema),
    dependsOn: z.array(z.string()),
  })),
  categories: packFile,
  attestations: packFile.exactOptional(),
  assets: z.array(z.strictObject({ path: z.string().min(1), sha256: Sha256HexSchema, mime: z.string().min(1), bytes: z.number().int().min(0) })),
});
export const FormpackSignatureSchema = z.strictObject({ alg: z.enum(['ed25519', 'es256']), keyId: z.string().min(1), sig: z.string().min(1) });
export const FormpackAttestationSchema = z.strictObject({
  slug,
  version: z.number().int().min(1),
  locale: LocaleSchema,
  reviewer: z.string().min(1).max(200),
  reviewedAt: IsoDateSchema,
  scope: z.string().min(1).max(1000),
});
export const FormpackTemplateFileSchema = z.strictObject({
  payload: TemplateVersionPayloadSchema,
  localizations: z.array(TemplateLocalizationSchema.omit({ templateVersionId: true })),
  categorySlugs: z.array(z.string()),
  changelog: z.string().exactOptional(),
});

export const TemplateErrorCodeSchema = z.enum([
  'DRAFT_REV_CONFLICT', 'LOCK_VIOLATION', 'TEMPLATE_VARIABLE_UNRESOLVED', 'TEMPLATE_FEATURE_UNAVAILABLE', 'TEMPLATE_UPDATE_REQUIRED', 'TEMPLATE_INVALID',
]);

export const TemplateMigrationIssueSchema = z.strictObject({
  code: z.enum([
    'payload_not_object', 'unknown_kind', 'schema_version_invalid', 'schema_version_newer', 'migration_step_missing',
    'document_migration_unavailable', 'migration_failed', 'invalid_payload',
  ]),
  path: z.string(),
  message: z.string(),
});
export const TemplateMigrationResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), payload: TemplateVersionPayloadSchema, notes: z.array(MigrationNoteSchema) }),
  z.strictObject({ ok: z.literal(false), issues: z.array(TemplateMigrationIssueSchema) }),
]);
