import { z } from 'zod';
import { keyed } from './_util.ts';
import type {
  AssetId, BlockId, BrandKitId, ConditionId, ConnectionId, ConsentItemId, CountryCode, CurrencyCode, DecimalString,
  EmailAddress, EndingId, FieldKey, FileId, FontId, FormId, FormVersionId, GroupRowId, HexColor, HolidayCalendarId,
  IntegrationId, IsoDate, IsoInstant, IsoLocalDateTime, IsoTime, Locale, LockId, MatrixColumnId, MatrixRowId, MinorUnits,
  NotificationId, NotificationVariantId, OptionId, OrgId, PageId, PdfTemplateId, ProductId, ProductOptionId, PurposeId, RuleGroupId,
  RuleId, SafeHref, SafeUrl, SenderId, Sha256Hex, SubmissionId, TeamId, TemplateBindingId, TemplateCategoryId, TemplateId,
  TemplatePackId, TemplatePartId, TemplateVersionId, TimeZone, UserId, VariableId, WebhookId, WorkflowId, WorkflowStepId,
} from '../ids.ts';
import type { BrandToken } from '../template-primitives.ts';

/** Ids and keys index records; these names would reach Object.prototype instead of an own property. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** uuidv7, nanoid(12), v1 uuids and template source ids: 1..64 of [A-Za-z0-9_-], never a reserved key. Never derived from text (I1). */
export const isOpaqueId = (v: unknown): v is string => typeof v === 'string' && OPAQUE_ID.test(v) && !RESERVED_KEYS.has(v);

const id = <T extends string>(name: string) => z.custom<T>(isOpaqueId, { message: `invalid ${name}` });
const branded = <T extends string>(name: string, test: (v: string) => boolean) =>
  z.custom<T>((v) => typeof v === 'string' && test(v), { message: `invalid ${name}` });

export const OrgIdSchema = id<OrgId>('OrgId');
export const TeamIdSchema = id<TeamId>('TeamId');
export const UserIdSchema = id<UserId>('UserId');
export const FormIdSchema = id<FormId>('FormId');
export const FormVersionIdSchema = id<FormVersionId>('FormVersionId');
export const SubmissionIdSchema = id<SubmissionId>('SubmissionId');
export const BlockIdSchema = id<BlockId>('BlockId');
export const PageIdSchema = id<PageId>('PageId');
export const EndingIdSchema = id<EndingId>('EndingId');
export const OptionIdSchema = id<OptionId>('OptionId');
export const MatrixRowIdSchema = id<MatrixRowId>('MatrixRowId');
export const MatrixColumnIdSchema = id<MatrixColumnId>('MatrixColumnId');
export const GroupRowIdSchema = id<GroupRowId>('GroupRowId');
export const ProductIdSchema = id<ProductId>('ProductId');
export const ProductOptionIdSchema = id<ProductOptionId>('ProductOptionId');
export const ConsentItemIdSchema = id<ConsentItemId>('ConsentItemId');
export const PurposeIdSchema = id<PurposeId>('PurposeId');
export const RuleIdSchema = id<RuleId>('RuleId');
export const RuleGroupIdSchema = id<RuleGroupId>('RuleGroupId');
export const ConditionIdSchema = id<ConditionId>('ConditionId');
export const VariableIdSchema = id<VariableId>('VariableId');
export const NotificationIdSchema = id<NotificationId>('NotificationId');
export const NotificationVariantIdSchema = id<NotificationVariantId>('NotificationVariantId');
export const WebhookIdSchema = id<WebhookId>('WebhookId');
export const IntegrationIdSchema = id<IntegrationId>('IntegrationId');
export const ConnectionIdSchema = id<ConnectionId>('ConnectionId');
export const SenderIdSchema = id<SenderId>('SenderId');
export const WorkflowIdSchema = id<WorkflowId>('WorkflowId');
export const WorkflowStepIdSchema = id<WorkflowStepId>('WorkflowStepId');
export const PdfTemplateIdSchema = id<PdfTemplateId>('PdfTemplateId');
export const HolidayCalendarIdSchema = id<HolidayCalendarId>('HolidayCalendarId');
export const AssetIdSchema = id<AssetId>('AssetId');
export const FileIdSchema = id<FileId>('FileId');
export const FontIdSchema = id<FontId>('FontId');
export const TemplateIdSchema = id<TemplateId>('TemplateId');
export const TemplateVersionIdSchema = id<TemplateVersionId>('TemplateVersionId');
export const TemplateBindingIdSchema = id<TemplateBindingId>('TemplateBindingId');
export const TemplateCategoryIdSchema = id<TemplateCategoryId>('TemplateCategoryId');
export const TemplatePackIdSchema = id<TemplatePackId>('TemplatePackId');
export const BrandKitIdSchema = id<BrandKitId>('BrandKitId');
export const LockIdSchema = id<LockId>('LockId');
export const TemplatePartIdSchema = id<TemplatePartId>('TemplatePartId');

const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
export const FieldKeySchema = branded<FieldKey>('FieldKey', (v) => FIELD_KEY.test(v) && !RESERVED_KEYS.has(v));

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const LocaleSchema = branded<Locale>('Locale', (v) => LOCALE.test(v));
const TIME_ZONE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;
export const TimeZoneSchema = branded<TimeZone>('TimeZone', (v) => v.length <= 64 && TIME_ZONE.test(v));
export const CountryCodeSchema = branded<CountryCode>('CountryCode', (v) => /^[A-Z]{2}$/.test(v));
export const CurrencyCodeSchema = branded<CurrencyCode>('CurrencyCode', (v) => /^[A-Z]{3}$/.test(v));

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d{1,10})?$/;
/** Exact decimal, ≤ 34 significant digits, no '-0'. */
export const isDecimalString = (v: string): boolean => {
  if (!DECIMAL.test(v) || /^-0(\.0+)?$/.test(v)) return false;
  return v.replace(/[-.]/g, '').replace(/^0+/, '').length <= 34;
};
export const DecimalStringSchema = branded<DecimalString>('DecimalString', isDecimalString);
export const MinorUnitsSchema = branded<MinorUnits>('MinorUnits', (v) => /^(0|-?[1-9]\d{0,19})$/.test(v));

const daysInMonth = (y: number, m: number): number => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
const validDate = (v: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const IsoDateSchema = branded<IsoDate>('IsoDate', validDate);
export const IsoTimeSchema = branded<IsoTime>('IsoTime', (v) => TIME.test(v));
export const IsoLocalDateTimeSchema = branded<IsoLocalDateTime>('IsoLocalDateTime', (v) => {
  const [date = '', time = '', extra] = v.split('T');
  return extra === undefined && validDate(date) && TIME.test(time);
});
export const IsoInstantSchema = branded<IsoInstant>('IsoInstant', (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):[0-5]\d(\.\d{1,9})?Z$/.exec(v);
  return m !== null && validDate(m[1] ?? '') && TIME.test(m[2] ?? '');
});
export const Sha256HexSchema = branded<Sha256Hex>('Sha256Hex', (v) => /^[0-9a-f]{64}$/.test(v));
export const HexColorSchema = branded<HexColor>('HexColor', (v) => /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v));
export const EmailAddressSchema = branded<EmailAddress>('EmailAddress', (v) => v.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(v));

const SAFE_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s<>"`]*)?$/i;
/** https/http only, no credentials in the authority (S6). */
export const isSafeUrl = (v: string): boolean => v.length <= 2048 && SAFE_URL.test(v);
/** SafeUrl, mailto: or tel: — the only link targets rich text may hold (S4, I6). */
export const isSafeHref = (v: string): boolean =>
  isSafeUrl(v) || (v.length <= 512 && (/^mailto:[^\s@<>"`]+@[^\s@<>"`]+$/i.test(v) || /^tel:\+?[0-9][0-9 ().-]{2,31}$/i.test(v)));
export const SafeUrlSchema = branded<SafeUrl>('SafeUrl', isSafeUrl);
export const SafeHrefSchema = branded<SafeHref>('SafeHref', isSafeHref);

export const WeekdaySchema = z.literal([0, 1, 2, 3, 4, 5, 6]);
export const TextAlignSchema = z.enum(['left', 'center', 'right']);

export const ExtensionsSchema = keyed(z.record(z.templateLiteral(['x-', z.string()]), z.unknown())).readonly();

export const AssetRefSchema = z.object({
  assetId: AssetIdSchema,
  alt: z.string().max(1000).exactOptional(),
  decorative: z.boolean().exactOptional(),
});

/* §1 */

const TEMPLATE_VARIABLE_NAME = /^(org|brand|form|custom)\.[a-z0-9_.]+$/;
export const TemplateVariableNameSchema = z.templateLiteral([z.enum(['org', 'brand', 'form', 'custom']), '.', z.string()])
  .refine((v) => TEMPLATE_VARIABLE_NAME.test(v), 'invalid template variable name');

export const BRAND_TOKENS = [
  'primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted', 'error', 'success',
  'logo', 'logo_dark', 'logo_square', 'favicon', 'font_heading', 'font_body', 'radius',
] as const satisfies readonly BrandToken[];
export const BrandTokenSchema = z.enum(BRAND_TOKENS);
export const BrandRefSchema = z.object({ ref: z.templateLiteral(['brand.', BrandTokenSchema]) });

export const OriginSchema = z.object({
  bindingId: TemplateBindingIdSchema,
  sourceId: z.string().min(1).max(128),
});
