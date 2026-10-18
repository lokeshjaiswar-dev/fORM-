import { z } from 'zod';
import { keyed } from './_util.ts';
import { ADDRESS_PARTS, CONTEXT_SOURCES, NAME_PARTS, OPTION_PRESETS, TEXT_PRESETS } from '../config.ts';
import { ExprSchema, ExprTypeSchema } from './logic.ts';
import {
  AssetRefSchema, BlockIdSchema, BrandRefSchema, ConnectionIdSchema, ConsentItemIdSchema, CountryCodeSchema, CurrencyCodeSchema,
  DecimalStringSchema, HolidayCalendarIdSchema, IsoDateSchema, IsoTimeSchema, LocaleSchema, MatrixColumnIdSchema, MatrixRowIdSchema,
  MinorUnitsSchema, OptionIdSchema, OriginSchema, ProductIdSchema, ProductOptionIdSchema, PurposeIdSchema, SafeUrlSchema,
  TextAlignSchema, TimeZoneSchema, WeekdaySchema,
} from './primitives.ts';
import {
  ColorValueSchema, DatePatternSchema, InlineDocSchema, LabelTextSchema, NumericValueFormatSchema, PlainTemplateSchema, RichDocSchema,
  ValueFormatSchema,
} from './rich-text.ts';

const label = z.string().max(200);
const count = z.number().int().min(0);
const textChrome = {
  placeholder: z.string().max(200).exactOptional(),
  prefix: z.string().max(32).exactOptional(),
  suffix: z.string().max(32).exactOptional(),
};

export const TextPresetSchema = z.enum(TEXT_PRESETS);
export const SafePatternSchema = z.strictObject({ source: z.string().min(1).max(256), flags: z.enum(['', 'i']).exactOptional() });
export const InputMaskSchema = z.strictObject({ pattern: z.string().min(1).max(64), storeMasked: z.boolean() });
export const DefaultTextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('static'), value: z.string().max(10_000) }),
  z.strictObject({ kind: z.literal('template'), value: PlainTemplateSchema }),
]);

export const ShortTextConfigSchema = z.strictObject({
  ...textChrome,
  defaultValue: DefaultTextSchema.exactOptional(),
  minLength: count.max(10_000).exactOptional(),
  maxLength: count.max(10_000).exactOptional(),
  preset: TextPresetSchema.exactOptional(),
  pattern: SafePatternSchema.exactOptional(),
  mask: InputMaskSchema.exactOptional(),
});
export const LongTextConfigSchema = z.strictObject({
  placeholder: z.string().max(200).exactOptional(),
  defaultValue: DefaultTextSchema.exactOptional(),
  rows: z.number().int().min(1).max(50).exactOptional(),
  limit: z.strictObject({ unit: z.enum(['characters', 'words']), min: count.max(50_000).exactOptional(), max: count.max(50_000).exactOptional() }).exactOptional(),
  showCounter: z.boolean().exactOptional(),
});

export const NamePartSchema = z.enum(NAME_PARTS);
export const FullNameConfigSchema = z.strictObject({
  parts: z.array(NamePartSchema).min(1),
  requiredParts: z.array(NamePartSchema),
  prefixInput: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text') }),
    z.strictObject({ kind: z.literal('list'), options: z.array(label) }),
  ]).exactOptional(),
  sublabels: keyed(z.partialRecord(NamePartSchema, label)).exactOptional(),
  placeholders: keyed(z.partialRecord(NamePartSchema, label)).exactOptional(),
});

export const EmailConfigSchema = z.strictObject({
  ...textChrome,
  defaultValue: DefaultTextSchema.exactOptional(),
  confirm: z.boolean().exactOptional(),
  blockFreeProviders: z.boolean().exactOptional(),
  blockDisposable: z.boolean().exactOptional(),
  allowedDomains: z.array(z.string().min(1).max(253)).exactOptional(),
  verify: z.strictObject({ enabled: z.boolean(), codeLength: z.literal([4, 6]), ttlMinutes: z.number().int().min(1).max(60) }).exactOptional(),
});

export const PhoneConfigSchema = z.strictObject({
  placeholder: z.string().max(200).exactOptional(),
  defaultCountry: CountryCodeSchema,
  allowedCountries: z.array(CountryCodeSchema).exactOptional(),
  showCountrySelect: z.boolean(),
  mask: InputMaskSchema.exactOptional(),
});

export const AddressPartSchema = z.enum(ADDRESS_PARTS);
export const AddressConfigSchema = z.strictObject({
  parts: z.array(AddressPartSchema).min(1),
  requiredParts: z.array(AddressPartSchema),
  country: z.strictObject({ mode: z.enum(['any', 'fixed', 'list']), default: CountryCodeSchema.exactOptional(), allowed: z.array(CountryCodeSchema).exactOptional() }),
  stateInput: z.enum(['auto', 'text']),
  validatePostalCode: z.boolean(),
  sublabels: keyed(z.partialRecord(AddressPartSchema, label)).exactOptional(),
});

export const NumberConfigSchema = z.strictObject({
  ...textChrome,
  display: z.enum(['input', 'stepper']),
  defaultValue: DecimalStringSchema.exactOptional(),
  min: DecimalStringSchema.exactOptional(),
  max: DecimalStringSchema.exactOptional(),
  step: DecimalStringSchema.exactOptional(),
  integerOnly: z.boolean().exactOptional(),
  allowNegative: z.boolean().exactOptional(),
  format: NumericValueFormatSchema.exactOptional(),
});

export const UrlConfigSchema = z.strictObject({ ...textChrome, defaultValue: DefaultTextSchema.exactOptional(), schemes: z.array(z.enum(['https', 'http'])).min(1) });

export const ChoiceOptionSchema = z.strictObject({
  id: OptionIdSchema,
  label: LabelTextSchema,
  code: z.string().max(200).exactOptional(),
  image: AssetRefSchema.exactOptional(),
  score: DecimalStringSchema.exactOptional(),
  correct: z.boolean().exactOptional(),
  origin: OriginSchema.exactOptional(),
});
export const OptionPresetSchema = z.enum(OPTION_PRESETS);
export const OtherOptionSchema = z.strictObject({
  enabled: z.boolean(),
  label: label.exactOptional(),
  placeholder: label.exactOptional(),
  textRequired: z.boolean(),
  maxLength: count.max(10_000).exactOptional(),
});
const choiceCommon = {
  options: z.array(ChoiceOptionSchema).min(1).max(5000),
  preset: OptionPresetSchema.exactOptional(),
  other: OtherOptionSchema.exactOptional(),
  shuffle: z.union([z.literal(false), z.strictObject({ keepLast: count })]).exactOptional(),
  columns: z.literal([1, 2, 3, 4]).exactOptional(),
  searchable: z.boolean().exactOptional(),
  placeholder: label.exactOptional(),
};
export const SingleChoiceConfigSchema = z.strictObject({
  ...choiceCommon,
  display: z.enum(['radio', 'dropdown', 'image']),
  defaultOptionId: OptionIdSchema.exactOptional(),
});
export const MultiChoiceConfigSchema = z.strictObject({
  ...choiceCommon,
  display: z.enum(['checkbox', 'dropdown', 'image']),
  defaultOptionIds: z.array(OptionIdSchema).exactOptional(),
  minSelected: count.exactOptional(),
  maxSelected: count.exactOptional(),
  exclusiveOptionIds: z.array(OptionIdSchema).exactOptional(),
});

export const DateBoundSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absolute'), date: IsoDateSchema }),
  z.strictObject({ kind: z.literal('relative'), offset: z.number().int(), unit: z.enum(['day', 'week', 'month', 'year']) }),
  z.strictObject({ kind: z.literal('field'), blockId: BlockIdSchema, offsetDays: z.number().int().exactOptional() }),
]);
const dateRange = z.strictObject({ from: IsoDateSchema, to: IsoDateSchema });
export const DateLimitsSchema = z.strictObject({
  min: DateBoundSchema.exactOptional(),
  max: DateBoundSchema.exactOptional(),
  disallowWeekdays: z.array(WeekdaySchema).exactOptional(),
  disallowDates: z.array(z.union([IsoDateSchema, dateRange])).exactOptional(),
  holidayCalendarId: HolidayCalendarIdSchema.exactOptional(),
  age: z.strictObject({ min: count.max(150).exactOptional(), max: count.max(150).exactOptional() }).exactOptional(),
});
const hourCycle = z.enum(['h12', 'h23']);
const minuteStep = z.literal([1, 5, 10, 15, 30]);
export const DateConfigSchema = z.strictObject({
  pattern: DatePatternSchema,
  separator: z.enum(['-', '/', '.']).exactOptional(),
  picker: z.enum(['calendar', 'selects', 'native']),
  defaultValue: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('today') }), z.strictObject({ kind: z.literal('fixed'), date: IsoDateSchema })]).exactOptional(),
  limits: DateLimitsSchema.exactOptional(),
});
export const DateTimeConfigSchema = z.strictObject({
  pattern: DatePatternSchema,
  hourCycle,
  minuteStep,
  timeZone: z.union([TimeZoneSchema, z.literal('respondent')]),
  defaultValue: z.strictObject({ kind: z.literal('now') }).exactOptional(),
  limits: DateLimitsSchema.exactOptional(),
});
export const TimeConfigSchema = z.strictObject({
  hourCycle,
  minuteStep,
  period: z.enum(['any', 'am_only', 'pm_only']).exactOptional(),
  window: z.strictObject({ from: IsoTimeSchema.exactOptional(), to: IsoTimeSchema.exactOptional() }).exactOptional(),
  defaultValue: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('now') }), z.strictObject({ kind: z.literal('fixed'), time: IsoTimeSchema })]).exactOptional(),
  range: z.strictObject({ enabled: z.boolean(), minMinutes: count.exactOptional(), maxMinutes: count.exactOptional() }).exactOptional(),
});

export const RatingConfigSchema = z.strictObject({
  max: z.number().int().min(1).max(10),
  icon: z.enum(['star', 'heart', 'thumb', 'smiley', 'number']),
  lowLabel: label.exactOptional(),
  highLabel: label.exactOptional(),
  defaultValue: z.number().int().min(1).max(10).exactOptional(),
});
export const LinearScaleConfigSchema = z.strictObject({
  min: z.literal([0, 1]),
  max: z.number().int().min(2).max(10),
  lowLabel: label.exactOptional(),
  midLabel: label.exactOptional(),
  highLabel: label.exactOptional(),
});
export const NpsConfigSchema = z.strictObject({ lowLabel: label.exactOptional(), highLabel: label.exactOptional() });
export const RankingConfigSchema = z.strictObject({
  options: z.array(ChoiceOptionSchema).min(1).max(100),
  shuffle: z.boolean().exactOptional(),
  rankTop: z.number().int().min(1).exactOptional(),
});

export const MatrixRowSchema = z.strictObject({ id: MatrixRowIdSchema, label: LabelTextSchema });
const column = { id: MatrixColumnIdSchema, label };
export const MatrixColumnSchema = z.discriminatedUnion('input', [
  z.strictObject({ ...column, input: z.literal('choice'), score: DecimalStringSchema.exactOptional() }),
  z.strictObject({ ...column, input: z.literal('checkbox'), score: DecimalStringSchema.exactOptional() }),
  z.strictObject({ ...column, input: z.literal('text'), maxLength: count.max(10_000).exactOptional() }),
  z.strictObject({ ...column, input: z.literal('number'), min: DecimalStringSchema.exactOptional(), max: DecimalStringSchema.exactOptional() }),
  z.strictObject({ ...column, input: z.literal('dropdown'), options: z.array(ChoiceOptionSchema).min(1) }),
]);
export const MatrixConfigSchema = z.strictObject({
  mode: z.enum(['single', 'multi', 'grid']),
  rows: z.array(MatrixRowSchema).min(1).max(100),
  columns: z.array(MatrixColumnSchema).min(1).max(20),
  requireEach: z.enum(['none', 'row', 'cell']),
  shuffleRows: z.boolean().exactOptional(),
  mobileLayout: z.enum(['table', 'accordion']).exactOptional(),
});

export const RepeatingGroupConfigSchema = z.strictObject({
  children: z.array(BlockIdSchema).min(1).max(30),
  minRows: count.max(200),
  maxRows: z.number().int().min(1).max(200),
  initialRows: count.max(200).exactOptional(),
  addLabel: label.exactOptional(),
  removeLabel: label.exactOptional(),
  rowTitle: PlainTemplateSchema.exactOptional(),
  layout: z.enum(['stacked', 'table']),
});

const GIB = 1024 ** 3;
export const FileUploadConfigSchema = z.strictObject({
  minFiles: count.max(20).exactOptional(),
  maxFiles: z.number().int().min(1).max(20),
  minFileBytes: count.max(GIB).exactOptional(),
  maxFileBytes: z.number().int().min(1).max(GIB),
  accept: z.strictObject({ extensions: z.array(z.string().regex(/^\.?[A-Za-z0-9]{1,16}$/)), mimeTypes: z.array(z.string().regex(/^[a-z]+\/[a-z0-9.+*-]+$/i)) }),
  capture: z.enum(['none', 'user', 'environment']),
  stripMetadata: z.boolean(),
  scan: z.enum(['off', 'async', 'required']),
});

export const SignatureConfigSchema = z.strictObject({
  penColor: ColorValueSchema,
  heightPx: z.number().int().min(80).max(400),
  allowTyped: z.boolean(),
  statement: InlineDocSchema.exactOptional(),
});

export const HiddenConfigSchema = z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('url_param'), name: z.string().min(1).max(64).exactOptional() }),
    z.strictObject({ kind: z.literal('utm'), param: z.enum(['source', 'medium', 'campaign', 'term', 'content']) }),
    z.strictObject({ kind: z.literal('static'), value: PlainTemplateSchema }),
    z.strictObject({ kind: z.literal('expr'), expr: ExprSchema }),
  ]),
});

export const ConsentItemSchema = z.strictObject({
  id: ConsentItemIdSchema,
  purposeId: PurposeIdSchema.exactOptional(),
  label: InlineDocSchema,
  requiredToSubmit: z.boolean(),
  defaultChecked: z.literal(false),
});
export const ConsentConfigSchema = z.strictObject({
  mode: z.enum(['dpdp', 'terms']),
  notice: RichDocSchema,
  itemiseData: z.boolean(),
  items: z.array(ConsentItemSchema).min(1),
  withdrawalText: InlineDocSchema.exactOptional(),
  presentation: z.enum(['checkboxes', 'scroll_to_agree']),
  termsDocument: AssetRefSchema.exactOptional(),
  noticeLocales: z.array(LocaleSchema).exactOptional(),
  noticeVersion: count,
});

export const CaptchaConfigSchema = z.strictObject({
  provider: z.enum(['platform_default', 'hcaptcha', 'turnstile', 'recaptcha_v3', 'proof_of_work']),
  invisible: z.boolean().exactOptional(),
});

export const ProductOptionSchema = z.strictObject({
  id: ProductOptionIdSchema,
  label,
  required: z.boolean(),
  choices: z.array(z.strictObject({ id: OptionIdSchema, label, priceDelta: MinorUnitsSchema })).min(1),
});
export const ProductSchema = z.strictObject({
  id: ProductIdSchema,
  name: label,
  description: RichDocSchema.exactOptional(),
  images: z.array(AssetRefSchema),
  sku: z.string().max(64).exactOptional(),
  pricing: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('one_time'), amount: MinorUnitsSchema }),
    z.strictObject({
      kind: z.literal('subscription'),
      amount: MinorUnitsSchema,
      interval: z.enum(['day', 'week', 'month', 'year']),
      intervalCount: z.number().int().min(1),
      trialDays: count.exactOptional(),
      setupFee: MinorUnitsSchema.exactOptional(),
      totalCycles: z.number().int().min(1).exactOptional(),
    }),
  ]),
  quantity: z.strictObject({ min: count, max: count, default: count }).exactOptional(),
  options: z.array(ProductOptionSchema).exactOptional(),
  stockTracked: z.boolean(),
  tax: z.strictObject({ hsnSac: z.string().max(16).exactOptional(), ratePct: DecimalStringSchema.exactOptional(), inclusive: z.boolean().exactOptional() }).exactOptional(),
  shipping: z.strictObject({ first: MinorUnitsSchema, additional: MinorUnitsSchema.exactOptional() }).exactOptional(),
  origin: OriginSchema.exactOptional(),
});
export const PaymentAmountSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('products'), selection: z.enum(['single', 'multiple']), products: z.array(ProductSchema).min(1), showImages: z.boolean() }),
  z.strictObject({ kind: z.literal('donation'), suggested: z.array(MinorUnitsSchema), min: MinorUnitsSchema, max: MinorUnitsSchema.exactOptional(), allowCustom: z.boolean() }),
  z.strictObject({ kind: z.literal('calculated'), expr: ExprSchema, description: z.string().max(500) }),
]);
export const TaxConfigSchema = z.strictObject({
  mode: z.enum(['none', 'flat', 'gst_in', 'by_location']),
  inclusive: z.boolean(),
  flatRatePct: DecimalStringSchema.exactOptional(),
  gst: z.strictObject({
    sellerGstin: PlainTemplateSchema,
    sellerStateCode: z.string().min(1).max(8),
    placeOfSupplyBlockId: BlockIdSchema,
    defaultRatePct: DecimalStringSchema,
  }).exactOptional(),
  byLocation: z.array(z.strictObject({
    country: CountryCodeSchema,
    region: z.string().max(64).exactOptional(),
    ratePct: DecimalStringSchema,
    locationBlockId: BlockIdSchema,
  })).exactOptional(),
});
export const PaymentConfigSchema = z.strictObject({
  gateway: z.enum(['stripe', 'razorpay']),
  currency: CurrencyCodeSchema,
  amount: PaymentAmountSourceSchema,
  tax: TaxConfigSchema.exactOptional(),
  shipping: z.strictObject({ mode: z.enum(['none', 'per_item', 'per_order']), perOrder: MinorUnitsSchema.exactOptional() }).exactOptional(),
  couponsEnabled: z.boolean(),
  showTotal: z.boolean(),
  methods: z.array(z.enum(['card', 'upi', 'netbanking', 'wallet', 'apple_pay', 'google_pay', 'ach', 'link'])).exactOptional(),
  billing: z.strictObject({
    nameBlockId: BlockIdSchema.exactOptional(),
    emailBlockId: BlockIdSchema.exactOptional(),
    phoneBlockId: BlockIdSchema.exactOptional(),
    addressBlockId: BlockIdSchema.exactOptional(),
    gstinBlockId: BlockIdSchema.exactOptional(),
  }).exactOptional(),
  holdUntilPaid: z.literal(true),
  invoice: z.strictObject({ enabled: z.boolean(), numberPrefix: z.string().max(32) }).exactOptional(),
});

export const AppointmentConfigSchema = z.strictObject({
  timeZone: TimeZoneSchema,
  allowRespondentTimeZone: z.boolean(),
  slotMinutes: z.number().int().min(1),
  slotStepMinutes: z.number().int().min(1).exactOptional(),
  bufferMinutes: count,
  weekly: z.array(z.strictObject({ weekday: WeekdaySchema, from: IsoTimeSchema, to: IsoTimeSchema })),
  blockedDates: z.array(z.union([IsoDateSchema, dateRange])).exactOptional(),
  holidayCalendarId: HolidayCalendarIdSchema.exactOptional(),
  minNoticeMinutes: count,
  rollingDays: z.number().int().min(1),
  maxPerDay: z.number().int().min(1).exactOptional(),
  capacityPerSlot: z.number().int().min(1),
  reminders: z.array(z.strictObject({ minutesBefore: z.number().int().min(1), emailBlockId: BlockIdSchema })).exactOptional(),
  calendarConnectionId: ConnectionIdSchema.exactOptional(),
  attachIcs: z.boolean(),
});

export const CalculationConfigSchema = z.strictObject({
  expr: ExprSchema,
  resultType: ExprTypeSchema,
  format: ValueFormatSchema.exactOptional(),
  display: z.enum(['visible', 'hidden']),
  declassify: z.strictObject({ reason: z.string().min(1).max(1000) }).exactOptional(),
});
export const ContextConfigSchema = z.strictObject({ source: z.enum(CONTEXT_SOURCES), stripQuery: z.boolean().exactOptional() });
export const UniqueIdConfigSchema = z.strictObject({
  prefix: PlainTemplateSchema,
  padTo: count.max(20),
  startAt: count,
  resetEvery: z.enum(['never', 'year', 'month']),
  showOnEnding: z.boolean(),
});

export const HeadingConfigSchema = z.strictObject({
  level: z.literal([1, 2, 3]),
  text: InlineDocSchema,
  subheading: InlineDocSchema.exactOptional(),
  align: TextAlignSchema.exactOptional(),
});
export const ParagraphConfigSchema = z.strictObject({ content: RichDocSchema });
export const ImageConfigSchema = z.strictObject({
  image: z.union([AssetRefSchema, BrandRefSchema]),
  widthPct: z.number().min(1).max(100),
  align: TextAlignSchema,
  href: SafeUrlSchema.exactOptional(),
});
export const DividerConfigSchema = z.strictObject({
  lineStyle: z.enum(['solid', 'dashed', 'dotted', 'none']),
  color: ColorValueSchema.exactOptional(),
  spacing: z.enum(['sm', 'md', 'lg']),
});
export const SectionConfigSchema = z.strictObject({
  title: InlineDocSchema.exactOptional(),
  description: RichDocSchema.exactOptional(),
  children: z.array(BlockIdSchema),
  collapsible: z.boolean(),
  initiallyCollapsed: z.boolean().exactOptional(),
});

export const BLOCK_CONFIG_SCHEMAS = {
  short_text: ShortTextConfigSchema, long_text: LongTextConfigSchema, full_name: FullNameConfigSchema, email: EmailConfigSchema,
  phone: PhoneConfigSchema, address: AddressConfigSchema, number: NumberConfigSchema, url: UrlConfigSchema,
  single_choice: SingleChoiceConfigSchema, multi_choice: MultiChoiceConfigSchema, date: DateConfigSchema, datetime: DateTimeConfigSchema,
  time: TimeConfigSchema, rating: RatingConfigSchema, linear_scale: LinearScaleConfigSchema, nps: NpsConfigSchema, ranking: RankingConfigSchema,
  matrix: MatrixConfigSchema, repeating_group: RepeatingGroupConfigSchema, file_upload: FileUploadConfigSchema, signature: SignatureConfigSchema,
  hidden: HiddenConfigSchema, consent: ConsentConfigSchema, payment: PaymentConfigSchema, appointment: AppointmentConfigSchema,
  calculation: CalculationConfigSchema, context: ContextConfigSchema, unique_id: UniqueIdConfigSchema, captcha: CaptchaConfigSchema,
  heading: HeadingConfigSchema, paragraph: ParagraphConfigSchema, image: ImageConfigSchema, divider: DividerConfigSchema, section: SectionConfigSchema,
} as const;
export const BlockConfigMapSchema = z.strictObject(BLOCK_CONFIG_SCHEMAS);
