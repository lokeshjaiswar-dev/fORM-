import type { BlockId, PageId, PurposeId } from './ids.ts';
import type { InlineDoc, PlainTemplate } from './rich-text.ts';
import type { Origin } from './template-primitives.ts';

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
