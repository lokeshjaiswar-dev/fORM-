import { z } from 'zod';
import { keyed } from './_util.ts';
import { AnswersSchema, EncryptedScalarSchema, StoredAnswerSchema } from './answers.ts';
import { GuardianVerificationMethodSchema } from './compliance.ts';
import { ValidationErrorCodeSchema } from './envelope.ts';
import { ScalarValueSchema } from './logic.ts';
import {
  BlockIdSchema, ConsentItemIdSchema, CountryCodeSchema, CurrencyCodeSchema, DecimalStringSchema, EmailAddressSchema, EndingIdSchema,
  FieldKeySchema, FormIdSchema, FormVersionIdSchema, GroupRowIdSchema, IsoInstantSchema, LocaleSchema, MinorUnitsSchema, OrgIdSchema,
  PageIdSchema, PurposeIdSchema, RuleIdSchema, SafeUrlSchema, Sha256HexSchema, SubmissionIdSchema, TimeZoneSchema, UserIdSchema,
  VariableIdSchema,
} from './primitives.ts';
import { AnswerPathSchema } from './rich-text.ts';

const device = z.enum(['desktop', 'tablet', 'mobile']);
const gateway = z.enum(['stripe', 'razorpay']);
const storedAnswers = keyed(z.partialRecord(BlockIdSchema, StoredAnswerSchema));

export const SubmissionRequestSchema = z.object({
  formVersionId: FormVersionIdSchema,
  idempotencyKey: z.string().min(1).max(64),
  locale: LocaleSchema,
  answers: AnswersSchema,
  pageTrail: z.array(PageIdSchema),
  client: z.object({
    startedAt: IsoInstantSchema,
    timeZone: TimeZoneSchema.exactOptional(),
    embedOrigin: z.string().max(2048).exactOptional(),
    urlParams: keyed(z.record(z.string(), z.string())).exactOptional(),
    pageUrl: z.string().max(2048).exactOptional(),
    referrer: z.string().max(2048).exactOptional(),
    device: device.exactOptional(),
  }),
  verification: z.object({
    honeypot: z.literal(''),
    captchaToken: z.string().exactOptional(),
    powSolution: z.string().exactOptional(),
    emailOtp: keyed(z.partialRecord(BlockIdSchema, z.string())).exactOptional(),
  }),
  tokens: z.object({
    access: z.string().exactOptional(),
    resume: z.string().exactOptional(),
    prefill: z.string().exactOptional(),
    edit: z.string().exactOptional(),
  }).exactOptional(),
});

export const DraftSaveRequestSchema = z.object({
  formVersionId: FormVersionIdSchema,
  answers: AnswersSchema,
  currentPageId: PageIdSchema,
  resumeToken: z.string().exactOptional(),
  sendLinkTo: EmailAddressSchema.exactOptional(),
});

export const FieldErrorSchema = z.object({
  blockId: BlockIdSchema.exactOptional(),
  path: AnswerPathSchema.exactOptional(),
  rowId: GroupRowIdSchema.exactOptional(),
  code: ValidationErrorCodeSchema,
  message: z.string(),
  params: keyed(z.record(z.string(), z.union([z.string(), z.number()]))).exactOptional(),
});

export const SubmitResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    submissionId: SubmissionIdSchema,
    endingId: EndingIdSchema,
    redirectUrl: SafeUrlSchema.exactOptional(),
    uniqueId: z.string().exactOptional(),
    editToken: z.string().exactOptional(),
    receiptToken: z.string().exactOptional(),
    held: z.enum(['pending_guardian_consent', 'pending_scan']).exactOptional(),
  }),
  z.discriminatedUnion('kind', [
    z.object({ ok: z.literal(false), kind: z.literal('invalid'), status: z.literal(422), errors: z.array(FieldErrorSchema) }),
    z.object({
      ok: z.literal(false),
      kind: z.literal('payment_required'),
      submissionId: SubmissionIdSchema,
      checkout: z.object({ gateway, clientSecretOrOrderId: z.string(), amount: MinorUnitsSchema, currency: CurrencyCodeSchema }),
    }),
    z.object({ ok: z.literal(false), kind: z.enum(['closed', 'limit_reached', 'version_superseded', 'rate_limited', 'spam_rejected', 'amount_changed']) }),
  ]),
]);

export const ConsentRecordSchema = z.object({
  submissionId: SubmissionIdSchema,
  blockId: BlockIdSchema,
  itemId: ConsentItemIdSchema,
  purposeId: PurposeIdSchema.exactOptional(),
  granted: z.boolean(),
  formVersionId: FormVersionIdSchema,
  noticeVersion: z.number().int().min(0),
  noticeHash: Sha256HexSchema,
  locale: LocaleSchema,
  at: IsoInstantSchema,
  source: z.enum(['form', 'withdrawal_link', 'owner_ui', 'api', 'dsr', 'import', 'consent_manager']),
  subject: z.enum(['self', 'child', 'person_with_disability']).exactOptional(),
  vpc: z.object({
    method: GuardianVerificationMethodSchema,
    evidenceRef: z.string().min(1),
    verifiedAt: IsoInstantSchema,
    verifiedBy: UserIdSchema.exactOptional(),
  }).exactOptional(),
});

export const DisclosureSchema = z.object({
  submissionId: SubmissionIdSchema,
  orgId: OrgIdSchema,
  recipient: z.object({
    kind: z.enum(['notification', 'webhook', 'integration', 'export', 'workflow', 'api_key']),
    id: z.string().min(1),
    displayName: z.string(),
  }),
  fieldKeys: z.array(FieldKeySchema),
  at: IsoInstantSchema,
});

export const PaymentRecordSchema = z.object({
  gateway,
  reference: z.string().min(1),
  status: z.enum(['pending', 'authorised', 'paid', 'failed', 'refunded', 'partially_refunded']),
  currency: CurrencyCodeSchema,
  totals: z.object({ subtotal: MinorUnitsSchema, discount: MinorUnitsSchema, tax: MinorUnitsSchema, shipping: MinorUnitsSchema, total: MinorUnitsSchema }),
  taxBreakdown: z.array(z.object({ kind: z.enum(['CGST', 'SGST', 'IGST', 'VAT', 'TAX']), ratePct: DecimalStringSchema, amount: MinorUnitsSchema })).exactOptional(),
  couponCode: z.string().exactOptional(),
  invoiceNumber: z.string().exactOptional(),
  subscriptionRef: z.string().exactOptional(),
});

export const SubmissionStatusSchema = z.enum(['complete', 'pending_payment', 'payment_failed', 'pending_scan', 'pending_guardian_consent', 'spam', 'archived', 'trashed']);

export const StoredSubmissionSchema = z.object({
  id: SubmissionIdSchema,
  orgId: OrgIdSchema,
  formId: FormIdSchema,
  formVersionId: FormVersionIdSchema,
  definitionHash: Sha256HexSchema,
  answerCodecVersion: z.number().int().min(1),
  seq: z.number().int().min(1),
  status: SubmissionStatusSchema,
  answers: storedAnswers,
  computed: z.object({
    variables: keyed(z.partialRecord(VariableIdSchema, z.union([ScalarValueSchema, EncryptedScalarSchema]))),
    path: z.array(PageIdSchema),
    endingId: EndingIdSchema,
    firedRuleIds: z.array(RuleIdSchema),
  }),
  consents: z.array(ConsentRecordSchema),
  payment: PaymentRecordSchema.exactOptional(),
  meta: z.object({
    receivedAt: IsoInstantSchema,
    startedAt: IsoInstantSchema.exactOptional(),
    durationMs: z.number().int().min(0).exactOptional(),
    locale: LocaleSchema,
    source: z.enum(['web', 'embed', 'api', 'import']),
    ipHash: Sha256HexSchema.exactOptional(),
    uaHash: Sha256HexSchema.exactOptional(),
    device: device.exactOptional(),
    country: CountryCodeSchema.exactOptional(),
    embedOrigin: z.string().exactOptional(),
    utm: keyed(z.partialRecord(z.enum(['source', 'medium', 'campaign', 'term', 'content']), z.string())).exactOptional(),
    spamScore: z.number().exactOptional(),
    opsRev: z.number().int().min(0),
  }),
  retention: z.object({
    deleteAfter: IsoInstantSchema,
    statutoryHoldUntil: IsoInstantSchema.exactOptional(),
    fieldDeleteAfter: keyed(z.partialRecord(BlockIdSchema, IsoInstantSchema)).exactOptional(),
    legalHold: z.boolean(),
  }),
  workflowState: z.string().exactOptional(),
  statusLabel: z.string().exactOptional(),
  inbox: z.object({
    read: z.boolean(),
    starred: z.boolean(),
    tags: z.array(z.string()),
    assigneeId: UserIdSchema.exactOptional(),
    archivedAt: IsoInstantSchema.exactOptional(),
    trashedAt: IsoInstantSchema.exactOptional(),
  }),
  revision: z.number().int().min(0),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
});

export const SubmissionRevisionSchema = z.object({
  submissionId: SubmissionIdSchema,
  revision: z.number().int().min(0),
  by: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('respondent') }),
    z.object({ kind: z.literal('user'), userId: UserIdSchema }),
    z.object({ kind: z.literal('system'), job: z.string().min(1) }),
  ]),
  mode: z.enum(['inline_edit_no_side_effects', 'resubmit_with_side_effects']),
  changed: z.array(z.object({ blockId: BlockIdSchema, before: StoredAnswerSchema.exactOptional(), after: StoredAnswerSchema.exactOptional() })),
  at: IsoInstantSchema,
});

export const DraftSubmissionSchema = z.object({
  id: SubmissionIdSchema,
  orgId: OrgIdSchema,
  formId: FormIdSchema,
  formVersionId: FormVersionIdSchema,
  answers: storedAnswers,
  currentPageId: PageIdSchema,
  path: z.array(PageIdSchema),
  locale: LocaleSchema,
  resumeTokenHash: Sha256HexSchema,
  expiresAt: IsoInstantSchema,
});
