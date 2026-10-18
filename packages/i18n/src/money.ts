import { formatNumber, type Grouping } from './number';

/** Active ISO 4217 currency codes, without precious metals, bond-market units, XDR and testing codes. */
export const ISO_4217_CODES: ReadonlySet<string> = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD',
  'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP',
  'CNY', 'COP', 'COU', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD',
  'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR',
  'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK',
  'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK',
  'MXN', 'MXV', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR',
  'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS',
  'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH',
  'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF',
  'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
]);

/** ISO 4217 minor-unit exponents that differ from 2. */
const EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

const SYMBOLS: Readonly<Record<string, string>> = { INR: '₹', EUR: '€', GBP: '£', USD: 'US$' };

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

export interface MoneyFormatOptions {
  grouping?: Grouping;
  /** `symbol` (default) uses ₹, €, £, US$ and falls back to the ISO code; `code` always shows the code. */
  display?: 'symbol' | 'code';
}

/** Integer minor units (paise, cents) as a string, bigint or safe integer. */
export type MinorUnitsInput = string | bigint | number;

/** `formatMoney('123456789', 'INR')` → `₹12,34,567.89`. Invalid input gives `''`. */
export function formatMoney(minor: MinorUnitsInput, currency: string, options: MoneyFormatOptions = {}): string {
  const text = typeof minor === 'number' ? (Number.isSafeInteger(minor) ? String(minor) : '') : String(minor).trim();
  const match = /^(-?)(\d+)$/.exec(text);
  if (!match || !/^[A-Za-z]{3}$/.test(currency)) return '';
  const code = currency.toUpperCase();
  const exponent = currencyExponent(code);
  const digits = (match[2] ?? '').padStart(exponent + 1, '0');
  const major = exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits;
  const amount = formatNumber(major, { grouping: options.grouping ?? 'indian' });
  const isZero = /^0+$/.test(digits);
  const sign = match[1] === '-' && !isZero ? '-' : '';
  const symbol = options.display === 'code' ? undefined : SYMBOLS[code];
  return symbol ? `${sign}${symbol}${amount}` : `${sign}${code} ${amount}`;
}
