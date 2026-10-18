import type { _ExactKeys } from './_internal.ts';
import type { BlockType } from './catalogue.ts';
import type { Expr, ExprType } from './expr.ts';
import type { AssetRef, BlockId, ConnectionId, ConsentItemId, CountryCode, CurrencyCode, DecimalString, HolidayCalendarId, IsoDate, IsoTime, Locale, MatrixColumnId, MatrixRowId, MinorUnits, OptionId, ProductId, ProductOptionId, PurposeId, SafeUrl, TextAlign, TimeZone, Weekday } from './ids.ts';
import type { ColorValue, DatePattern, InlineDoc, LabelText, PlainTemplate, RichDoc, ValueFormat } from './rich-text.ts';
import type { BrandRef, Origin } from './template-primitives.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  PER-TYPE CONFIGURATION (`config`). registry.configSchema is the zod mirror.
 * ═════════════════════════════════════════════════════════════════════════ */

interface TextChrome { placeholder?: string; prefix?: string; suffix?: string } // PROP-03/15

export const TEXT_PRESETS = [
  'alphabetic', 'alphanumeric', 'numeric', 'no_spaces',
  'in_pan', 'in_gstin', 'in_pincode', 'in_ifsc', 'in_vehicle_reg',
  /** Captures the LAST 4 digits only (no checksum; the full number is never sent or stored). Forces 'sensitive'.
   *  Full-number capture needs the Aadhaar Data Vault adapter (P4, UIDAI-authorised entities only). */
  'in_aadhaar_last4',
] as const;
export type TextPreset = (typeof TEXT_PRESETS)[number];

/** VAL-04: RE2 subset (no backrefs / lookaround), ≤ 256 chars; re2 on the server. */
export interface SafePattern { source: string; flags?: '' | 'i' }
/** PROP-12: '#' digit, '@' letter, '*' either, '[…]' optional tail. Server-enforced. */
export interface InputMask { pattern: string; storeMasked: boolean }

/** Default value: static, piped template (evaluated once on load) or expression. */
export type DefaultText = { kind: 'static'; value: string } | { kind: 'template'; value: PlainTemplate };

export interface ShortTextConfig extends TextChrome {
  defaultValue?: DefaultText;
  minLength?: number; maxLength?: number; // hard cap 10_000
  preset?: TextPreset; pattern?: SafePattern; mask?: InputMask;
}
export interface LongTextConfig {
  placeholder?: string; defaultValue?: DefaultText; rows?: number;
  limit?: { unit: 'characters' | 'words'; min?: number; max?: number }; // VAL-02; chars cap 50_000
  showCounter?: boolean;
}

export const NAME_PARTS = ['prefix', 'first', 'middle', 'last', 'suffix'] as const;
export type NamePart = (typeof NAME_PARTS)[number];
export interface FullNameConfig {
  parts: NamePart[];                 // 'first' always present
  requiredParts: NamePart[];         // default ['first','last']
  prefixInput?: { kind: 'text' } | { kind: 'list'; options: string[] };
  sublabels?: Partial<Record<NamePart, string>>;
  placeholders?: Partial<Record<NamePart, string>>;
}

export interface EmailConfig extends TextChrome {
  defaultValue?: DefaultText;
  confirm?: boolean;
  blockFreeProviders?: boolean;
  blockDisposable?: boolean;         // SPM-03 (bundled list, no lookup)
  allowedDomains?: string[];
  verify?: { enabled: boolean; codeLength: 4 | 6; ttlMinutes: number }; // SPM-04 / ACC-09
}

export interface PhoneConfig {
  placeholder?: string;
  defaultCountry: CountryCode;       // 'IN' for en-IN
  allowedCountries?: CountryCode[];
  showCountrySelect: boolean;
  mask?: InputMask;
}

export const ADDRESS_PARTS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;
export type AddressPart = (typeof ADDRESS_PARTS)[number];
export interface AddressConfig {
  parts: AddressPart[];
  requiredParts: AddressPart[];
  country: { mode: 'any' | 'fixed' | 'list'; default?: CountryCode; allowed?: CountryCode[] };
  /** 'auto' = by country (Indian states/UTs + PIN, US states + ZIP), else free text. */
  stateInput: 'auto' | 'text';
  validatePostalCode: boolean;
  sublabels?: Partial<Record<AddressPart, string>>;
}

export interface NumberConfig extends TextChrome {
  display: 'input' | 'stepper';      // FLD-08
  defaultValue?: DecimalString;
  min?: DecimalString; max?: DecimalString; step?: DecimalString;
  integerOnly?: boolean; allowNegative?: boolean;
  format?: Extract<ValueFormat, { kind: 'number' | 'money' | 'percent' }>;
}

export interface UrlConfig extends TextChrome { defaultValue?: DefaultText; schemes: Array<'https' | 'http'> }

/** Stored answer is the option `id` (FND-07; fixes B15/B16). */
export interface ChoiceOption {
  id: OptionId;
  label: LabelText;                  // translatable `option:<blockId>/<optionId>`; may pipe (PRE-02)
  /** Editable export/integration code (v1 `value` migrates here). Exports default to label. */
  code?: string;
  image?: AssetRef;                  // FLD-15
  score?: DecimalString;             // PROP-13 calculation value / quiz score
  correct?: boolean;                 // LOG-24
  origin?: Origin;
}

/** PROP-10. Materialised into options at insert (ids = official codes) so versions are self-contained. */
export const OPTION_PRESETS = ['countries', 'in_states_uts', 'us_states', 'months', 'weekdays', 'gender', 'yes_no', 'agree_5', 'satisfaction_5', 'languages_in'] as const;
export type OptionPreset = (typeof OPTION_PRESETS)[number];

export interface OtherOption { enabled: boolean; label?: string; placeholder?: string; textRequired: boolean; maxLength?: number }

interface ChoiceCommon {
  options: ChoiceOption[];           // 1..5000
  preset?: OptionPreset;             // provenance only
  other?: OtherOption;
  /** PROP-11: seeded per session so Back keeps order; Other stays last; keepLast pins N options. */
  shuffle?: false | { keepLast: number };
  columns?: 1 | 2 | 3 | 4;
  searchable?: boolean;              // FLD-14 (dropdown display)
  placeholder?: string;
}
export interface SingleChoiceConfig extends ChoiceCommon {
  display: 'radio' | 'dropdown' | 'image';
  defaultOptionId?: OptionId;
}
export interface MultiChoiceConfig extends ChoiceCommon {
  display: 'checkbox' | 'dropdown' | 'image';
  defaultOptionIds?: OptionId[];
  minSelected?: number; maxSelected?: number;  // VAL-06
  exclusiveOptionIds?: OptionId[];             // "None of the above"
}

/** FLD-17. */
export type DateBound =
  | { kind: 'absolute'; date: IsoDate }
  | { kind: 'relative'; offset: number; unit: 'day' | 'week' | 'month' | 'year' }   // from meta.today in form tz
  | { kind: 'field'; blockId: BlockId; offsetDays?: number };   // same or earlier page only (I8)
export interface DateLimits {
  min?: DateBound; max?: DateBound;
  disallowWeekdays?: Weekday[];
  disallowDates?: Array<IsoDate | { from: IsoDate; to: IsoDate }>;
  holidayCalendarId?: HolidayCalendarId;
  age?: { min?: number; max?: number };      // VAL-12, against meta.today in the form tz
}
export interface DateConfig {
  pattern: DatePattern; separator?: '-' | '/' | '.';
  picker: 'calendar' | 'selects' | 'native';
  defaultValue?: { kind: 'today' } | { kind: 'fixed'; date: IsoDate };
  limits?: DateLimits;
}
export interface DateTimeConfig {
  pattern: DatePattern; hourCycle: 'h12' | 'h23'; minuteStep: 1 | 5 | 10 | 15 | 30;
  timeZone: TimeZone | 'respondent';
  defaultValue?: { kind: 'now' };
  limits?: DateLimits;
}
export interface TimeConfig {
  hourCycle: 'h12' | 'h23'; minuteStep: 1 | 5 | 10 | 15 | 30;
  period?: 'any' | 'am_only' | 'pm_only';
  window?: { from?: IsoTime; to?: IsoTime };
  defaultValue?: { kind: 'now' } | { kind: 'fixed'; time: IsoTime };
  /** answer.end is present iff range is enabled. */
  range?: { enabled: boolean; minMinutes?: number; maxMinutes?: number };
}

export interface RatingConfig { max: number /* 1..10, B28 */; icon: 'star' | 'heart' | 'thumb' | 'smiley' | 'number'; lowLabel?: string; highLabel?: string; defaultValue?: number }
/** No selection when unanswered (B7). */
export interface LinearScaleConfig { min: 0 | 1; max: number /* 2..10 */; lowLabel?: string; midLabel?: string; highLabel?: string }
export interface NpsConfig { lowLabel?: string; highLabel?: string }
/** Answer exists only after interaction (B8). */
export interface RankingConfig { options: ChoiceOption[]; shuffle?: boolean; rankTop?: number }

export interface MatrixRow { id: MatrixRowId; label: LabelText }
export type MatrixColumn =
  | { id: MatrixColumnId; label: string; input: 'choice'; score?: DecimalString }
  | { id: MatrixColumnId; label: string; input: 'checkbox'; score?: DecimalString }
  | { id: MatrixColumnId; label: string; input: 'text'; maxLength?: number }
  | { id: MatrixColumnId; label: string; input: 'number'; min?: DecimalString; max?: DecimalString }
  | { id: MatrixColumnId; label: string; input: 'dropdown'; options: ChoiceOption[] };
/** FLD-24. `mode` fixes the answer shape (single: one column per row, multi: many, grid: typed cells). */
export interface MatrixConfig {
  mode: 'single' | 'multi' | 'grid';
  rows: MatrixRow[];                 // ≤ 100
  columns: MatrixColumn[];           // ≤ 20
  requireEach: 'none' | 'row' | 'cell';
  shuffleRows?: boolean;
  mobileLayout?: 'table' | 'accordion';
}

/** FLD-25. Children live in `definition.blocks`; must be RepeatableBlockType. */
export interface RepeatingGroupConfig {
  children: BlockId[];               // 1..30
  minRows: number; maxRows: number;  // maxRows ≤ 200
  initialRows?: number;
  addLabel?: string; removeLabel?: string;
  rowTitle?: PlainTemplate;          // may pipe row-scoped values / meta.row_index
  layout: 'stacked' | 'table';
}

export interface FileUploadConfig {
  minFiles?: number; maxFiles: number;            // ≤ 20
  minFileBytes?: number; maxFileBytes: number;    // ≤ plan cap ≤ 1 GiB
  /** Extension AND sniffed-MIME allowlists; both must match. */
  accept: { extensions: string[]; mimeTypes: string[] };
  capture: 'none' | 'user' | 'environment';       // FLD-27
  stripMetadata: boolean;                         // EXIF/GPS, default true (DPDP)
  scan: 'off' | 'async' | 'required';             // ClamAV adapter; 'required' holds submission
}

export interface SignatureConfig {
  penColor: ColorValue;
  heightPx: number;                  // 80..400; bitmap scaled by devicePixelRatio (B5)
  allowTyped: boolean;               // accessible alternative
  statement?: InlineDoc;             // hashed into the audit record (WFL-07)
}

/** FLD-30. A hidden field always captures something (fixes B26). */
export interface HiddenConfig {
  source:
    | { kind: 'url_param'; name?: string }      // default name = key
    | { kind: 'utm'; param: 'source' | 'medium' | 'campaign' | 'term' | 'content' }
    | { kind: 'static'; value: PlainTemplate }
    | { kind: 'expr'; expr: Expr };
}

/** CMP-04 / FLD-36. One block, two modes, ONE answer shape. */
export interface ConsentItem {
  id: ConsentItemId;
  /** Required for dpdp mode (purpose must have lawfulBasis 'consent'); optional for terms. */
  purposeId?: PurposeId;
  label: InlineDoc;
  /** Only purposes necessary for the service may gate submit (no bundling); publish warns otherwise. */
  requiredToSubmit: boolean;
  /** Type-level guarantee: never pre-ticked. */
  defaultChecked: false;
}
export interface ConsentConfig {
  mode: 'dpdp' | 'terms';
  notice: RichDoc;                   // DPDP s.5 short notice; may hold org.* vars + form.purposes; must include withdrawal, rights and Board text (FiduciaryInfo)
  /** Auto-render the itemised data list per purpose from compiled.dataInventory. */
  itemiseData: boolean;
  /** dpdp: one item per consent-based purpose; terms: exactly one item. */
  items: ConsentItem[];
  /** Required in dpdp mode (s.5(1)(ii)); publish error `notice_incomplete` otherwise. Rendered with the signed withdrawal link. */
  withdrawalText?: InlineDoc;
  presentation: 'checkboxes' | 'scroll_to_agree';
  termsDocument?: AssetRef;
  /**
   * Locales the principal may switch the notice to (s.5(3), s.6(3): English or any Eighth-Schedule
   * language). A language picker is always shown in dpdp mode; unlisted languages can be requested.
   */
  noticeLocales?: Locale[];
  /**
   * Monotonic notice version. Publish bumps it when the hash of the FULLY RENDERED notice changes for any
   * locale: notice text + itemised data inventory + purposes and lawful bases + resolved org.* variables
   * + fiduciary rights/Board text. Shared concept with template versions (§17, templates spec §10.3).
   */
  noticeVersion: number;
}

/**
 * Overrides behavior.spam.captcha for this form. 'platform_default' = proof_of_work in every edition.
 * Third-party providers are opt-in, must be listed in a purpose's `recipients`, and are unavailable air-gapped.
 */
export interface CaptchaConfig {
  provider: 'platform_default' | 'hcaptcha' | 'turnstile' | 'recaptcha_v3' | 'proof_of_work';
  invisible?: boolean;
}

/* Payments (FLD-34 / PAY-*) */
export interface ProductOption {
  id: ProductOptionId; label: string; required: boolean;
  choices: Array<{ id: OptionId; label: string; priceDelta: MinorUnits }>;
}
export interface Product {
  id: ProductId; name: string; description?: RichDoc; images: AssetRef[]; sku?: string;
  pricing:
    | { kind: 'one_time'; amount: MinorUnits }
    | { kind: 'subscription'; amount: MinorUnits; interval: 'day' | 'week' | 'month' | 'year'; intervalCount: number; trialDays?: number; setupFee?: MinorUnits; totalCycles?: number }; // PAY-05
  quantity?: { min: number; max: number; default: number };
  options?: ProductOption[];
  /** PAY-12: counts live in FormOps; this flags enforcement. */
  stockTracked: boolean;
  tax?: { hsnSac?: string; ratePct?: DecimalString; inclusive?: boolean };    // PAY-09
  shipping?: { first: MinorUnits; additional?: MinorUnits };                  // PAY-10 per item
  origin?: Origin;
}
export type PaymentAmountSource =
  | { kind: 'products'; selection: 'single' | 'multiple'; products: Product[]; showImages: boolean }
  | { kind: 'donation'; suggested: MinorUnits[]; min: MinorUnits; max?: MinorUnits; allowCustom: boolean } // PAY-06
  | { kind: 'calculated'; expr: Expr; description: string };                 // PAY-07; resultType money
export interface TaxConfig {
  mode: 'none' | 'flat' | 'gst_in' | 'by_location';
  inclusive: boolean;
  flatRatePct?: DecimalString;
  /** CGST+SGST when place of supply = seller state, else IGST. */
  gst?: { sellerGstin: PlainTemplate; sellerStateCode: string; placeOfSupplyBlockId: BlockId; defaultRatePct: DecimalString };
  byLocation?: Array<{ country: CountryCode; region?: string; ratePct: DecimalString; locationBlockId: BlockId }>;
}
/** At most one payment block per form, on the last visible page (publish check). Credentials live in FormOps. */
export interface PaymentConfig {
  gateway: 'stripe' | 'razorpay';
  currency: CurrencyCode;
  amount: PaymentAmountSource;
  tax?: TaxConfig;
  shipping?: { mode: 'none' | 'per_item' | 'per_order'; perOrder?: MinorUnits };
  couponsEnabled: boolean;           // codes live in FormOps
  showTotal: boolean;
  methods?: Array<'card' | 'upi' | 'netbanking' | 'wallet' | 'apple_pay' | 'google_pay' | 'ach' | 'link'>;
  billing?: { nameBlockId?: BlockId; emailBlockId?: BlockId; phoneBlockId?: BlockId; addressBlockId?: BlockId; gstinBlockId?: BlockId };
  /** Submission stays 'pending_payment' until the gateway webhook confirms. */
  holdUntilPaid: true;
  invoice?: { enabled: boolean; numberPrefix: string };  // PAY-11, server-assigned
}

/** FLD-35. Slot reserved atomically on the server; reminder/ICS jobs run in the worker. */
export interface AppointmentConfig {
  timeZone: TimeZone;
  allowRespondentTimeZone: boolean;
  slotMinutes: number; slotStepMinutes?: number; bufferMinutes: number;
  weekly: Array<{ weekday: Weekday; from: IsoTime; to: IsoTime }>;
  blockedDates?: Array<IsoDate | { from: IsoDate; to: IsoDate }>;
  holidayCalendarId?: HolidayCalendarId;
  minNoticeMinutes: number; rollingDays: number; maxPerDay?: number; capacityPerSlot: number;
  reminders?: Array<{ minutesBefore: number; emailBlockId: BlockId }>;
  calendarConnectionId?: ConnectionId;   // INT-11; secrets server-side
  attachIcs: boolean;
}

/* Computed */
export interface CalculationConfig { expr: Expr; resultType: ExprType; format?: ValueFormat; display: 'visible' | 'hidden'; declassify?: { reason: string } }
export const CONTEXT_SOURCES = ['page_url', 'referrer', 'user_agent', 'started_at', 'submitted_at', 'locale', 'time_zone', 'embed_origin'] as const;
export interface ContextConfig { source: (typeof CONTEXT_SOURCES)[number]; stripQuery?: boolean }
export interface UniqueIdConfig { prefix: PlainTemplate; padTo: number; startAt: number; resetEvery: 'never' | 'year' | 'month'; showOnEnding: boolean }

/* Content and container */
export interface HeadingConfig { level: 1 | 2 | 3; text: InlineDoc; subheading?: InlineDoc; align?: TextAlign }
export interface ParagraphConfig { content: RichDoc }
export interface ImageConfig { image: AssetRef | BrandRef; widthPct: number; align: TextAlign; href?: SafeUrl }
export interface DividerConfig { lineStyle: 'solid' | 'dashed' | 'dotted' | 'none'; color?: ColorValue; spacing: 'sm' | 'md' | 'lg' }
/** FLD-48. Logic target as a unit; hiding hides (and strips) descendants. Also the snippet root (TPL-15). */
export interface SectionConfig {
  title?: InlineDoc; description?: RichDoc;
  children: BlockId[];               // no pages, no payment, sections nest ≤ 2
  collapsible: boolean; initiallyCollapsed?: boolean;
}

/** Type → config. Compile-time exhaustive (below). */
export interface BlockConfigMap {
  short_text: ShortTextConfig; long_text: LongTextConfig; full_name: FullNameConfig; email: EmailConfig;
  phone: PhoneConfig; address: AddressConfig; number: NumberConfig; url: UrlConfig;
  single_choice: SingleChoiceConfig; multi_choice: MultiChoiceConfig; date: DateConfig; datetime: DateTimeConfig;
  time: TimeConfig; rating: RatingConfig; linear_scale: LinearScaleConfig; nps: NpsConfig; ranking: RankingConfig;
  matrix: MatrixConfig; repeating_group: RepeatingGroupConfig; file_upload: FileUploadConfig; signature: SignatureConfig;
  hidden: HiddenConfig; consent: ConsentConfig; payment: PaymentConfig; appointment: AppointmentConfig;
  calculation: CalculationConfig; context: ContextConfig; unique_id: UniqueIdConfig; captcha: CaptchaConfig;
  heading: HeadingConfig; paragraph: ParagraphConfig; image: ImageConfig; divider: DividerConfig; section: SectionConfig;
}
export const _configComplete: _ExactKeys<BlockConfigMap, BlockType> = true;
