import type { AssetRef, BlockId, ConnectionId, DecimalString, FieldKey, FormId, FormVersionId, IntegrationId, IsoInstant, IsoTime, Locale, MinorUnits, NotificationId, NotificationVariantId, OrgId, PdfTemplateId, ProductId, PurposeId, SafeUrl, SenderId, TimeZone, UserId, WebhookId, Weekday, WorkflowId } from './ids.ts';
import type { ConditionGroup, Recipient } from './logic.ts';
import type { PlainTemplate, RichBlockNode, RichDoc } from './rich-text.ts';
import type { Origin } from './template-primitives.ts';
import type { PdfLayout } from './templates.ts';

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

/** Every one needs egress; @form/config gates them per edition (`integration:<provider>`, INTEGRATIONS_ENABLED). */
export const INTEGRATION_PROVIDERS = [
  'google_sheets', 'google_drive', 'dropbox', 'onedrive', 'slack', 'teams', 'mailchimp', 'hubspot', 'salesforce', 'zoho_crm', 'zapier', 'make',
  'n8n', 'google_calendar', 'outlook_calendar',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export interface IntegrationBinding {
  id: IntegrationId;
  provider: IntegrationProvider;
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
