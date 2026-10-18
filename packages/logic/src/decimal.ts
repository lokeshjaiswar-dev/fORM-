import Decimal from 'decimal.js';

/**
 * Numbers are exact decimals (schema §3.1): decimal.js, full build, precision 34, half-even. Never a JS
 * float, so every engine computes the same digits.
 */
export const D = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });
export type DecimalValue = InstanceType<typeof D>;

/** `DecimalString`: `-?(0|[1-9]\d*)(\.\d{1,10})?`, at most 34 significant digits. */
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d{1,10})?$/;

export function parseDecimal(text: string): DecimalValue | null {
  if (!DECIMAL.test(text)) return null;
  const value = new D(text);
  return value.precision(true) > 34 ? null : value;
}

/** Sign of a − b, or null when either side is not a valid decimal string. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (x === null || y === null) return null;
  return x.comparedTo(y) as -1 | 0 | 1;
}
