import type { Answers, EncryptedScalar, StoredAnswer } from './answers.ts';
import type { GuardianVerificationMethod } from './compliance.ts';
import type { ValidationErrorCode } from './envelope.ts';
import type { ScalarValue } from './expr.ts';
import type { BlockId, ConsentItemId, CountryCode, CurrencyCode, DecimalString, EmailAddress, EndingId, FieldKey, FormId, FormVersionId, GroupRowId, IsoInstant, Locale, MinorUnits, OrgId, PageId, PurposeId, RuleId, SafeUrl, Sha256Hex, SubmissionId, TimeZone, UserId, VariableId } from './ids.ts';
import type { AnswerPath } from './rich-text.ts';

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
