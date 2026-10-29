import type { BlockType, ConsentItemId, CurrencyCode, DecimalString, Expr, IsoTime, Locale, MinorUnits, RichDoc, TimeZone, Weekday } from '@form/schema';
import { defineStub, defineStubBlock } from './define.ts';
import { DEFAULT_TEXT, datePatternFor, hourCycleFor, message, regionOf } from './messages.ts';

/* Capabilities for types without a named one use the extension form `x-field:<type>`, like FeatureId `field:<type>`. */

const emptyDoc = (): RichDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });
const isIndia = (locale: Locale) => regionOf(locale) === 'IN';
const WORKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const ZERO: Expr = { k: 'lit', value: { type: 'number', value: '0' as DecimalString } };

export const address = defineStub('address', 'x-field:address', (locale) => ({
  parts: ['line1', 'line2', 'city', 'state', 'postalCode', 'country'],
  requiredParts: ['line1', 'city', 'state', 'postalCode', 'country'],
  country: { mode: 'fixed', default: regionOf(locale) },
  stateInput: 'auto',
  validatePostalCode: true,
}));

export const datetime = defineStub('datetime', 'x-field:datetime', (locale) => ({
  pattern: datePatternFor(locale),
  hourCycle: hourCycleFor(locale),
  minuteStep: 5,
  timeZone: 'respondent',
}));

/**
 * Children are blocks of their own, so a new group starts empty and the builder inserts its first child:
 * this default is a draft that `configSchema` rejects (1..30 children), listed in DRAFT_DEFAULT_CONFIG_TYPES.
 */
export const repeatingGroup = defineStub(
  'repeating_group',
  'repeating_groups',
  () => ({ children: [], minRows: 0, maxRows: 10, layout: 'stacked' }),
  (value) => value.rows.length === 0,
);

/** The only types whose `defaultConfig` fails `configSchema` until the builder completes it; generic callers skip them. */
export const DRAFT_DEFAULT_CONFIG_TYPES = ['repeating_group'] as const satisfies readonly BlockType[];

export const consent = defineStub('consent', 'consent_dpdp', (locale) => ({
  mode: 'terms',
  notice: emptyDoc(),
  itemiseData: false,
  items: [{
    id: 'item_1' as ConsentItemId,
    label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: message(locale, DEFAULT_TEXT['defaults.terms_item']) }] }] },
    requiredToSubmit: true,
    defaultChecked: false,
  }],
  presentation: 'checkboxes',
  noticeVersion: 0,
}), (value) => Object.values(value.items).every((granted) => granted === undefined));

export const payment = defineStub('payment', 'payments', (locale) => ({
  gateway: 'razorpay',
  currency: (isIndia(locale) ? 'INR' : 'USD') as CurrencyCode,
  amount: { kind: 'donation', suggested: [], min: '100' as MinorUnits, allowCustom: true },
  couponsEnabled: false,
  showTotal: true,
  holdUntilPaid: true,
}), (value) => (value.items ?? []).length === 0 && value.customAmount === undefined);

export const appointment = defineStub('appointment', 'appointments', (locale) => ({
  timeZone: (isIndia(locale) ? 'Asia/Kolkata' : 'UTC') as TimeZone,
  allowRespondentTimeZone: false,
  slotMinutes: 30,
  bufferMinutes: 0,
  weekly: WORKDAYS.map((weekday) => ({ weekday, from: '09:00' as IsoTime, to: '17:00' as IsoTime })),
  minNoticeMinutes: 60,
  rollingDays: 30,
  capacityPerSlot: 1,
  attachIcs: true,
}));

export const calculation = defineStub('calculation', 'x-field:calculation', () => ({ expr: ZERO, resultType: 'number', display: 'visible' }));
export const context = defineStub('context', 'x-field:context', () => ({ source: 'page_url' }));
export const uniqueId = defineStub('unique_id', 'x-field:unique_id', () => ({ prefix: [], padTo: 6, startAt: 1, resetEvery: 'never', showOnEnding: true }));

export const captcha = defineStubBlock('captcha', 'transient', 'x-field:captcha', () => ({ provider: 'platform_default' }));
export const image = defineStubBlock('image', 'content', 'x-field:image', () => ({ image: { ref: 'brand.logo' }, widthPct: 100, align: 'center' }));
export const section = defineStubBlock('section', 'container', 'x-field:section', () => ({ children: [], collapsible: false }));
