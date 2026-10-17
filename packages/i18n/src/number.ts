export type Grouping = 'indian' | 'international' | 'none';
export type DecimalSeparator = '.' | ',';

/** A JS number, a bigint, or an exact decimal string (`-?\d+(\.\d+)?`, e.g. a `DecimalString`). */
export type NumericInput = number | bigint | string;

export interface NumberFormatOptions {
  /** Fixed fraction digits (0–20), rounded half away from zero. Omitted: the value's own digits; non-finite gives `''`. */
  decimals?: number;
  grouping?: Grouping;
  decimalSeparator?: DecimalSeparator;
}

interface Decimal {
  negative: boolean;
  int: string;
  frac: string;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function expandExponent(text: string): string {
  const [mantissa = '', exp = '0'] = text.split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exp);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function toDecimal(value: NumericInput): Decimal | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = (value < 0 ? '-' : '') + expandExponent(String(Math.abs(value)));
  } else if (typeof value === 'bigint') {
    text = value.toString();
  } else {
    text = value.trim();
  }
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const int = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  return { negative: match[1] === '-', int, frac: match[3] ?? '' };
}

function increment(digits: string): string {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '9') {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
    out[i] = '0';
  }
  return `1${out.join('')}`;
}

function round(value: Decimal, decimals: number): Decimal {
  if (value.frac.length <= decimals) return { ...value, frac: value.frac.padEnd(decimals, '0') };
  const kept = value.int + value.frac.slice(0, decimals);
  const next = value.frac.charCodeAt(decimals) - 48;
  const digits = next >= 5 ? increment(kept) : kept;
  const intLength = digits.length - decimals;
  return { negative: value.negative, int: digits.slice(0, intLength) || '0', frac: digits.slice(intLength) };
}

function group(int: string, grouping: Grouping, separator: string): string {
  if (grouping === 'none' || int.length <= 3) return int;
  const head = int.slice(0, -3);
  const tail = int.slice(-3);
  const size = grouping === 'indian' ? 2 : 3;
  const groups: string[] = [];
  for (let end = head.length; end > 0; end -= size) groups.unshift(head.slice(Math.max(0, end - size), end));
  return [...groups, tail].join(separator);
}

/**
 * Locale-independent number formatting: `formatNumber(1234567.89)` → `12,34,567.89`.
 * Exact for decimal strings of any length; invalid input gives `''`.
 */
export function formatNumber(value: NumericInput, options: NumberFormatOptions = {}): string {
  let decimal = toDecimal(value);
  if (!decimal) return '';
  if (options.decimals !== undefined) {
    if (!Number.isFinite(options.decimals)) return '';
    decimal = round(decimal, Math.min(20, Math.max(0, Math.trunc(options.decimals))));
  }
  const decimalSeparator = options.decimalSeparator ?? '.';
  const groupSeparator = decimalSeparator === ',' ? '.' : ',';
  const int = group(decimal.int, options.grouping ?? 'indian', groupSeparator);
  const isZero = /^0*$/.test(decimal.int + decimal.frac);
  const sign = decimal.negative && !isZero ? '-' : '';
  return sign + int + (decimal.frac ? decimalSeparator + decimal.frac : '');
}

/** Languages whose CLDR default groups in lakh/crore in their home regions (`kn`, `ur` do not). */
const INDIAN_GROUPING_LANGUAGES: ReadonlySet<string> = new Set([
  'as', 'bn', 'brx', 'dz', 'gu', 'hi', 'kok', 'ml', 'mr', 'ne', 'or', 'pa', 'sa', 'ta', 'te',
]);
const INDIAN_GROUPING_REGIONS: ReadonlySet<string> = new Set(['BD', 'BT', 'LK', 'NP']);
const LOCALE_TAG = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?(?:-|$)/i;

/**
 * Region `IN` (any language, and the `en-XA` pseudo-locale) groups in lakh/crore, as do the Indic
 * languages above without a region or in their home regions: `hi` and `bn-BD` → indian, `ta-SG`,
 * `pa-Arab` and `en` → international. A fixed table, so results never depend on the host's CLDR.
 */
export function defaultGrouping(locale: string): Grouping {
  const match = LOCALE_TAG.exec(locale);
  if (!match) return 'international';
  const language = (match[1] ?? '').toLowerCase();
  const script = match[2]?.toLowerCase();
  const region = match[3]?.toUpperCase();
  if (region === 'IN' || region === 'XA') return 'indian';
  if (!INDIAN_GROUPING_LANGUAGES.has(language) || script === 'arab') return 'international';
  return region === undefined || INDIAN_GROUPING_REGIONS.has(region) ? 'indian' : 'international';
}
