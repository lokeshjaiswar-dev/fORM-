import { z } from 'zod';
import { BlockIdSchema, OriginSchema, PageIdSchema, PurposeIdSchema } from './primitives.ts';
import { InlineDocSchema, PlainTemplateSchema } from './rich-text.ts';

export const DataClassificationSchema = z.enum(['none', 'personal', 'sensitive']);
export const DataCategorySchema = z.enum(['contact', 'identity', 'government_id', 'financial', 'health', 'biometric', 'location', 'child', 'device', 'free_text', 'other']);

const disclosure = z.enum(['include', 'mask', 'omit']);
export const FieldComplianceSchema = z.object({
  classification: DataClassificationSchema,
  category: DataCategorySchema.exactOptional(),
  purposeIds: z.array(PurposeIdSchema),
  encrypt: z.boolean(),
  blindIndex: z.boolean().exactOptional(),
  allowPrefill: z.boolean(),
  inNotifications: disclosure,
  inExports: disclosure,
  retentionDaysOverride: z.number().int().min(1).max(3650).exactOptional(),
  principalIdentifier: z.enum(['email', 'phone', 'external_id']).exactOptional(),
});

export const LegitimateUseGroundSchema = z.enum([
  's7a_voluntarily_provided_for_specified_purpose', 's7b_state_subsidy_benefit_service_licence',
  's7c_state_function_or_sovereignty', 's7d_disclosure_to_state_under_law', 's7e_judgment_order_or_foreign_claim',
  's7f_medical_emergency', 's7g_epidemic_or_public_health', 's7h_disaster_or_public_order', 's7i_employment',
]);
export const LawfulBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('consent') }),
  z.object({ kind: z.literal('legitimate_use'), ground: LegitimateUseGroundSchema, justification: z.string().min(1).max(2000) }),
]);

const days = z.number().int().min(1).max(3650);
export const RetentionRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('days'), days }),
  z.object({ kind: z.literal('until_purpose_served'), maxDays: days }),
  z.object({ kind: z.literal('org_default') }),
  z.object({ kind: z.literal('statutory'), years: z.number().int().min(1).max(100), citation: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('inactivity'), days, noticeHours: z.literal(48) }),
]);

export const PurposeSchema = z.object({
  id: PurposeIdSchema,
  name: z.string().min(1).max(200),
  description: InlineDocSchema,
  lawfulBasis: LawfulBasisSchema,
  retention: RetentionRuleSchema,
  marketing: z.boolean().exactOptional(),
  recipients: z.array(z.string().max(200)).exactOptional(),
  origin: OriginSchema.exactOptional(),
});

export const FiduciaryInfoSchema = z.object({
  legalName: PlainTemplateSchema,
  contactEmail: PlainTemplateSchema,
  privacyContact: z.object({ name: PlainTemplateSchema, email: PlainTemplateSchema, phone: PlainTemplateSchema.exactOptional() }),
  dpo: z.object({ name: PlainTemplateSchema, email: PlainTemplateSchema }).exactOptional(),
  rightsUrl: PlainTemplateSchema,
  boardComplaintInfo: PlainTemplateSchema,
  noticeUrl: PlainTemplateSchema.exactOptional(),
});

export const GuardianVerificationMethodSchema = z.enum(['existing_verified_adult_account', 'manual_document_review', 'digilocker_token']);
export const GuardianConsentConfigSchema = z.object({
  guardianEmailBlockId: BlockIdSchema,
  methods: z.array(GuardianVerificationMethodSchema).min(1),
  expiryHours: z.number().int().min(1),
  evidenceUploadBlockId: BlockIdSchema.exactOptional(),
  pageId: PageIdSchema.exactOptional(),
});
export const ChildrenDataPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('not_applicable') }),
  z.object({
    mode: z.literal('age_gate'),
    subject: z.enum(['respondent', 'subject_of_form']),
    dobBlockId: BlockIdSchema,
    adultAge: z.number().int().min(1).max(30),
    underAge: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('block') }),
      z.object({ kind: z.literal('parental_consent'), guardian: GuardianConsentConfigSchema }),
    ]),
    disableTrackingForMinors: z.literal(true),
  }),
  z.object({ mode: z.literal('lawful_guardian'), guardian: GuardianConsentConfigSchema, guardianshipEvidenceBlockId: BlockIdSchema, disableTracking: z.literal(true) }),
  z.object({ mode: z.literal('exempt'), fourthScheduleItem: z.string().min(1).max(200), justification: z.string().min(1).max(2000) }),
]);

export const PrivacyConfigSchema = z.object({
  fiduciary: FiduciaryInfoSchema,
  purposes: z.array(PurposeSchema),
  children: ChildrenDataPolicySchema,
  encryption: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('server') }),
    z.object({ mode: z.literal('e2e'), publicKeyId: z.string().min(1), alg: z.literal('RSA-OAEP-256+A256GCM') }),
  ]),
  dropAnswersWithoutConsent: z.literal(true),
  networkSignals: z.object({ ipHash: z.boolean(), userAgentHash: z.boolean(), ttlDays: z.number().int().min(0).max(3650) }),
});
