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
/** Integer minor units as a string (paise, cents): '49900' = ₹499.00. Always fits a Postgres bigint (±9223372036854775807). */
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

/** Platform asset store reference (S3 storage adapter). External URLs are unrepresentable (CMP-12, S7). */
export interface AssetRef {
  assetId: AssetId;
  /** Required for content images (RSP-06/08) unless `decorative`. */
  alt?: string;
  decorative?: boolean;
}
