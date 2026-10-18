import { z } from 'zod';
import { INTEGRATION_PROVIDERS } from '../ops.ts';
import { guarded, keyed, richTextLimitError } from './_util.ts';
import { DataClassificationSchema } from './compliance.ts';
import { ConditionGroupSchema, RecipientSchema } from './logic.ts';
import {
  AssetRefSchema, BlockIdSchema, ConnectionIdSchema, DecimalStringSchema, FieldKeySchema, FormIdSchema, FormVersionIdSchema, IntegrationIdSchema,
  IsoInstantSchema, IsoTimeSchema, LocaleSchema, MinorUnitsSchema, NotificationIdSchema, NotificationVariantIdSchema, OrgIdSchema, OriginSchema,
  PdfTemplateIdSchema, ProductIdSchema, PurposeIdSchema, SafeUrlSchema, SenderIdSchema, TimeZoneSchema, UserIdSchema, WebhookIdSchema,
  WeekdaySchema, WorkflowIdSchema,
} from './primitives.ts';
import { PlainTemplateSchema, RichBlockNodeSchema, RichDocSchema } from './rich-text.ts';

export const StatusScreenRoleSchema = z.enum(['closed', 'not_yet_open', 'limit_reached', 'password', 'already_submitted', 'outside_hours']);
export const StatusScreenSchema = z.strictObject({ content: RichDocSchema, origin: OriginSchema.exactOptional() });

const hostList = z.array(z.string().min(1).max(253));
export const AccessConfigSchema = z.strictObject({
  enabled: z.boolean(),
  openAt: IsoInstantSchema.exactOptional(),
  closeAt: IsoInstantSchema.exactOptional(),
  availability: z.strictObject({
    timeZone: TimeZoneSchema,
    windows: z.array(z.strictObject({ weekdays: z.array(WeekdaySchema), from: IsoTimeSchema, to: IsoTimeSchema })),
  }).exactOptional(),
  submissionLimit: z.number().int().min(1).exactOptional(),
  password: z.strictObject({ argon2idHash: z.string().min(1), updatedAt: IsoInstantSchema }).exactOptional(),
  uniqueSubmission: z.enum(['off', 'device_token', 'device_token_and_ip_hash']),
  onePerVerifiedEmail: z.strictObject({ emailBlockId: BlockIdSchema }).exactOptional(),
  embedAllowlist: hostList,
  redirectAllowlist: hostList.exactOptional(),
  screens: keyed(z.partialRecord(StatusScreenRoleSchema, StatusScreenSchema)),
  requireAuth: z.strictObject({
    kind: z.literal('sso'),
    connectionId: ConnectionIdSchema,
    prefillFromClaims: keyed(z.partialRecord(FieldKeySchema, z.string())).exactOptional(),
  }).exactOptional(),
});

const EmailBodyNode = z.discriminatedUnion('type', [
  RichBlockNodeSchema.out,
  z.strictObject({ type: z.literal('answersTable'), attrs: z.strictObject({ include: z.union([z.literal('all'), z.array(BlockIdSchema)]), hideEmpty: z.boolean(), maskSensitive: z.boolean() }) }),
  z.strictObject({
    type: z.literal('button'),
    attrs: z.strictObject({
      label: z.string().max(200),
      action: z.union([z.enum(['view_submission', 'edit_submission', 'withdraw_consent', 'resume_draft']), z.strictObject({ url: PlainTemplateSchema })]),
    }),
  }),
  z.strictObject({ type: z.literal('brandBlock'), attrs: z.strictObject({ part: z.enum(['header', 'footer', 'legal_footer']) }) }),
]);
export const EmailBodyNodeSchema = guarded(richTextLimitError, EmailBodyNode);
const EmailDocShape = z.strictObject({ type: z.literal('email_doc'), content: z.array(EmailBodyNode) });
export const EmailDocSchema = guarded(richTextLimitError, EmailDocShape);

export const NotificationVariantSchema = z.strictObject({
  id: NotificationVariantIdSchema,
  name: z.string().max(200),
  locale: LocaleSchema.exactOptional(),
  subject: PlainTemplateSchema,
  body: EmailDocSchema,
});

export const NotificationConfigSchema = z.strictObject({
  id: NotificationIdSchema,
  name: z.string().max(200),
  kind: z.enum(['owner', 'autoresponder']),
  enabled: z.boolean(),
  trigger: z.enum(['submitted', 'edited', 'payment_confirmed', 'appointment_reminder', 'workflow_step', 'draft_saved']),
  delay: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('after'), minutes: z.number().int().min(1) }),
    z.strictObject({ kind: z.literal('relative_to_field'), blockId: BlockIdSchema, offsetMinutes: z.number().int() }),
    z.strictObject({ kind: z.literal('at'), at: IsoInstantSchema }),
  ]).exactOptional(),
  senderId: SenderIdSchema.exactOptional(),
  fromName: PlainTemplateSchema.exactOptional(),
  to: z.array(RecipientSchema),
  cc: z.array(RecipientSchema).exactOptional(),
  bcc: z.array(RecipientSchema).exactOptional(),
  replyTo: RecipientSchema.exactOptional(),
  purposeIds: z.array(PurposeIdSchema),
  subject: PlainTemplateSchema,
  body: EmailDocSchema,
  variants: z.array(NotificationVariantSchema).exactOptional(),
  locale: z.union([z.literal('respondent'), LocaleSchema]),
  sensitiveOverride: z.enum(['mask', 'omit']).exactOptional(),
  attachments: z.strictObject({
    uploads: z.enum(['none', 'attach', 'links']),
    pdf: z.strictObject({ templateId: PdfTemplateIdSchema.exactOptional(), password: z.strictObject({ fromBlockId: BlockIdSchema }).exactOptional() }).exactOptional(),
    staticAsset: AssetRefSchema.exactOptional(),
    maxTotalBytes: z.number().int().min(0).exactOptional(),
  }).exactOptional(),
  includeWithdrawalLink: z.boolean(),
  authoredAgainst: FormVersionIdSchema.exactOptional(),
  origin: OriginSchema.exactOptional(),
});

export const WebhookConfigSchema = z.strictObject({
  id: WebhookIdSchema,
  url: SafeUrlSchema,
  enabled: z.boolean(),
  secretRef: ConnectionIdSchema,
  events: z.array(z.enum(['submission.created', 'submission.updated', 'submission.deleted', 'payment.succeeded', 'consent.withdrawn'])),
  keyBy: z.enum(['key', 'id']),
  fieldKeys: z.union([z.array(FieldKeySchema), z.literal('all_in_purposes')]),
  purposeIds: z.array(PurposeIdSchema).min(1),
  files: z.enum(['signed_urls', 'none']),
  filter: ConditionGroupSchema.exactOptional(),
});

export const IntegrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);
export const IntegrationBindingSchema = z.strictObject({
  id: IntegrationIdSchema,
  provider: IntegrationProviderSchema,
  connectionId: ConnectionIdSchema,
  settings: keyed(z.record(z.string(), z.unknown())).readonly(),
  fieldMap: z.array(z.strictObject({
    from: z.union([FieldKeySchema, z.templateLiteral(['variable:', z.string()]), z.templateLiteral(['meta:', z.string()])]),
    to: z.string().min(1).max(200),
  })),
  purposeIds: z.array(PurposeIdSchema).min(1),
  enabled: z.boolean(),
});

/* §17 PdfLayout lives here so FormOps and the pdf template payload share one twin without an import cycle. */
export const PdfLayoutSchema = z.strictObject({
  pageSize: z.enum(['A4', 'Letter']),
  orientation: z.enum(['portrait', 'landscape']),
  marginsMm: z.strictObject({ top: z.number().min(0), right: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0) }),
  header: RichDocSchema.exactOptional(),
  footer: RichDocSchema.exactOptional(),
  fields: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('all') }),
    z.strictObject({ mode: z.literal('by_classification'), include: z.array(DataClassificationSchema) }),
    z.strictObject({ mode: z.literal('explicit'), keys: z.array(FieldKeySchema) }),
  ]),
  hideEmpty: z.boolean(),
  maskSensitive: z.boolean(),
  watermark: PlainTemplateSchema.exactOptional(),
  passwordFrom: z.union([z.strictObject({ blockId: BlockIdSchema }), z.strictObject({ key: FieldKeySchema })]).exactOptional(),
});

export const PdfTemplateConfigSchema = PdfLayoutSchema.extend({ id: PdfTemplateIdSchema, name: z.string().max(200), origin: OriginSchema.exactOptional() });

export const CouponSchema = z.strictObject({
  code: z.string().min(1).max(64),
  discount: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('percent'), pct: DecimalStringSchema }),
    z.strictObject({ kind: z.literal('fixed'), amount: MinorUnitsSchema }),
  ]),
  productIds: z.array(ProductIdSchema).exactOptional(),
  maxRedemptions: z.number().int().min(1).exactOptional(),
  expiresAt: IsoInstantSchema.exactOptional(),
});

export const RetentionOpsSchema = z.strictObject({
  shortenToDays: z.number().int().min(1).exactOptional(),
  basis: z.union([z.enum(['submitted_at', 'last_modified_at']), z.strictObject({ field: BlockIdSchema })]),
  onExpiry: z.enum(['delete', 'anonymise']),
  files: z.union([z.literal('with_submission'), z.strictObject({ days: z.number().int().min(1) })]),
  draftsDays: z.number().int().min(1).max(60),
  trashDays: z.number().int().min(1),
  legalHold: z.strictObject({ active: z.boolean(), reason: z.string().max(1000), setBy: UserIdSchema, setAt: IsoInstantSchema }).exactOptional(),
});

export const FormOpsSchema = z.strictObject({
  formId: FormIdSchema,
  orgId: OrgIdSchema,
  rev: z.number().int().min(0),
  slug: z.string().min(1).max(128),
  previousSlugs: z.array(z.string().max(128)),
  liveVersionId: FormVersionIdSchema.exactOptional(),
  access: AccessConfigSchema,
  notifications: z.array(NotificationConfigSchema),
  webhooks: z.array(WebhookConfigSchema),
  integrations: z.array(IntegrationBindingSchema),
  pdfTemplates: z.array(PdfTemplateConfigSchema),
  payments: z.strictObject({
    connectionId: ConnectionIdSchema,
    testMode: z.boolean(),
    coupons: z.array(CouponSchema),
    stock: keyed(z.partialRecord(ProductIdSchema, z.number().int().min(0))),
    lowStockAlert: z.strictObject({ threshold: z.number().int().min(0), to: z.array(RecipientSchema) }).exactOptional(),
  }).exactOptional(),
  retention: RetentionOpsSchema,
  spam: z.strictObject({ quarantineDisposable: z.boolean(), rateLimitPerIpPerHour: z.number().int().min(0) }),
  workflowIds: z.array(WorkflowIdSchema),
  acceptPreviousVersionsHours: z.number().int().min(0),
});
