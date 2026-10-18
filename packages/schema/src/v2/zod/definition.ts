import { z } from 'zod';
import { keyed } from './_util.ts';
import { SCHEMA_VERSION } from '../definition.ts';
import { TEMPLATE_KINDS } from '../templates.ts';
import { StoredBlockSchema } from './blocks.ts';
import { DataClassificationSchema, PrivacyConfigSchema } from './compliance.ts';
import { CaptchaConfigSchema } from './config.ts';
import { I18nBundleSchema } from './i18n.ts';
import { ClientRuleSchema, LogicModelSchema } from './logic.ts';
import { EndingSchema, PageSchema, WelcomeScreenSchema } from './pages.ts';
import {
  BlockIdSchema, BrandKitIdSchema, BrandTokenSchema, EndingIdSchema, ExtensionsSchema, FormIdSchema, FormVersionIdSchema, IsoInstantSchema,
  LocaleSchema, OrgIdSchema, PageIdSchema, ProductIdSchema, PurposeIdSchema, RuleIdSchema, Sha256HexSchema, TeamIdSchema,
  TemplateBindingIdSchema, TemplateIdSchema, TemplateVariableNameSchema, TemplateVersionIdSchema, UserIdSchema, VariableIdSchema,
} from './primitives.ts';
import { RichDocSchema } from './rich-text.ts';
import { BehaviorSchema, ThemeSchema } from './theme.ts';

export const FormDefinitionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.number().int().min(0),
  formId: FormIdSchema,
  title: z.string().max(500),
  description: RichDocSchema.exactOptional(),
  welcome: WelcomeScreenSchema.exactOptional(),
  blocks: keyed(z.partialRecord(BlockIdSchema, StoredBlockSchema)),
  pages: z.array(PageSchema).min(1),
  endings: z.array(EndingSchema).min(1),
  defaultEndingId: EndingIdSchema,
  logic: LogicModelSchema,
  privacy: PrivacyConfigSchema,
  theme: ThemeSchema,
  behavior: BehaviorSchema,
  i18n: I18nBundleSchema,
  x: ExtensionsSchema.exactOptional(),
});

export const TemplateOriginStampSchema = z.object({ templateId: TemplateIdSchema, versionId: TemplateVersionIdSchema, name: z.string().max(200) });

export const FormRecordSchema = z.object({
  id: FormIdSchema,
  orgId: OrgIdSchema,
  teamId: TeamIdSchema.exactOptional(),
  ownerUserId: UserIdSchema,
  draft: FormDefinitionSchema,
  draftRev: z.number().int().min(0),
  baseVersionId: FormVersionIdSchema.exactOptional(),
  templateOrigin: TemplateOriginStampSchema.exactOptional(),
  brandKitId: BrandKitIdSchema.exactOptional(),
  lifecycle: z.enum(['active', 'archived', 'trashed']),
  updatedAt: IsoInstantSchema,
  updatedBy: UserIdSchema,
});

export const CapabilitySchema = z.union([
  z.enum([
    'schema@2', 'logic@2', 'expr@1', 'rich_text@1', 'payments', 'appointments', 'repeating_groups', 'matrix', 'cards_layout', 'multi_locale',
    'save_and_resume', 'email_otp', 'consent_dpdp', 'custom_css', 'e2e_encryption',
  ]),
  z.templateLiteral(['x-', z.string()]),
]);

const perRow = z.literal('per_row').exactOptional();
export const ClientRuleStepSchema = z.object({ kind: z.literal('rule'), ruleId: RuleIdSchema, scope: z.literal('client+server'), row: perRow });
export const ServerRuleStepSchema = z.object({ kind: z.literal('rule'), ruleId: RuleIdSchema, scope: z.literal('server'), row: perRow });
const commonSteps = [
  z.object({ kind: z.literal('default'), blockId: BlockIdSchema }),
  z.object({ kind: z.literal('capture'), blockId: BlockIdSchema }),
  z.object({ kind: z.literal('variable'), varId: VariableIdSchema }),
  z.object({ kind: z.literal('calc'), blockId: BlockIdSchema }),
  z.object({ kind: z.literal('on_path'), pageId: PageIdSchema }),
] as const;
export const PlanStepSchema = z.discriminatedUnion('kind', [
  ...commonSteps,
  z.discriminatedUnion('scope', [ClientRuleStepSchema, ServerRuleStepSchema]),
]);
const RuntimePlanStepSchema = z.discriminatedUnion('kind', [...commonSteps, ClientRuleStepSchema]);

export const CompiledFormSchema = z.object({
  engine: z.literal('logic@2'),
  requires: z.array(CapabilitySchema),
  documentOrder: z.array(BlockIdSchema),
  parentOf: keyed(z.partialRecord(BlockIdSchema, z.union([BlockIdSchema, PageIdSchema]))),
  pageOf: keyed(z.partialRecord(BlockIdSchema, PageIdSchema)),
  plan: z.array(PlanStepSchema),
  reads: keyed(z.partialRecord(z.string(), z.array(z.string()))),
  dataInventory: z.array(z.object({ purposeId: PurposeIdSchema, blockIds: z.array(BlockIdSchema), classifications: z.array(DataClassificationSchema) })),
  taint: keyed(z.partialRecord(z.string(), z.object({ classification: DataClassificationSchema, purposeIds: z.array(PurposeIdSchema) }))),
  definitionHash: Sha256HexSchema,
});

export const TemplateLineageEntrySchema = z.object({
  bindingId: TemplateBindingIdSchema,
  templateId: TemplateIdSchema,
  templateVersionId: TemplateVersionIdSchema,
  kind: z.enum(TEMPLATE_KINDS),
  governance: z.enum(['bound', 'detached']),
});

export const VariablesSnapshotSchema = z.object({
  variables: keyed(z.partialRecord(TemplateVariableNameSchema, z.union([z.string(), keyed(z.partialRecord(LocaleSchema, z.string()))]))),
  brandKit: z.object({ id: BrandKitIdSchema, tokensHash: Sha256HexSchema, tokens: keyed(z.partialRecord(BrandTokenSchema, z.string())) }).exactOptional(),
  orgProfileUpdatedAt: IsoInstantSchema.exactOptional(),
});

export const FormVersionSchema = z.object({
  id: FormVersionIdSchema,
  orgId: OrgIdSchema,
  formId: FormIdSchema,
  number: z.number().int().min(1),
  label: z.string().max(200).exactOptional(),
  schemaVersion: z.number().int().min(1),
  publishedAt: IsoInstantSchema,
  publishedBy: UserIdSchema,
  definition: FormDefinitionSchema.readonly(),
  compiled: CompiledFormSchema,
  contentHash: Sha256HexSchema,
  templateLineage: z.array(TemplateLineageEntrySchema),
  variablesSnapshot: VariablesSnapshotSchema,
});

export const PublicFormDefinitionSchema = FormDefinitionSchema.extend({
  logic: LogicModelSchema.extend({ rules: z.array(ClientRuleSchema) }),
});

const screen = { screen: RichDocSchema };
export const RuntimeStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open') }),
  z.object({ state: z.literal('closed'), ...screen }),
  z.object({ state: z.literal('not_yet_open'), opensAt: IsoInstantSchema, ...screen }),
  z.object({ state: z.literal('outside_hours'), nextOpenAt: IsoInstantSchema.exactOptional(), ...screen }),
  z.object({ state: z.literal('limit_reached'), ...screen }),
  z.object({ state: z.literal('password'), ...screen }),
  z.object({ state: z.literal('already_submitted'), ...screen }),
]);

export const RuntimeFormVersionSchema = z.object({
  versionId: FormVersionIdSchema,
  formId: FormIdSchema,
  contentHash: Sha256HexSchema,
  definition: PublicFormDefinitionSchema,
  compiled: CompiledFormSchema.omit({ dataInventory: true, taint: true, plan: true }).extend({ plan: z.array(RuntimePlanStepSchema) }),
  status: RuntimeStatusSchema,
  accessToken: z.string().exactOptional(),
  publicConfig: z.object({
    edition: z.enum(['saas', 'onprem', 'airgapped']),
    captcha: z.object({
      provider: CaptchaConfigSchema.shape.provider,
      siteKey: z.string().exactOptional(),
      powChallengeUrl: z.string().exactOptional(),
    }).exactOptional(),
    payment: z.object({ gateway: z.enum(['stripe', 'razorpay']), publishableKey: z.string(), testMode: z.boolean() }).exactOptional(),
    upload: z.object({ presignUrl: z.string(), maxFileBytes: z.number().int().min(0) }),
    soldOut: z.array(ProductIdSchema).exactOptional(),
    branding: z.boolean(),
    thirdPartyTrackingAllowed: z.boolean(),
  }),
});
