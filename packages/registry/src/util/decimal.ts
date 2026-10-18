const SCALE = 10;
const DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,10}))?$/;

/** A `DecimalString` as an exact integer count of 10⁻¹⁰ units; null when it is not one. */
export function scaled(value: string): bigint | null {
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const [, sign = '', int = '0', frac = ''] = match;
  const n = BigInt(int + frac.padEnd(SCALE, '0'));
  return sign ? -n : n;
}

/** Sign of a − b for two valid decimal strings. */
export function compareDecimal(a: string, b: string): number {
  const x = scaled(a);
  const y = scaled(b);
  if (x === null || y === null) return Number.NaN;
  return x === y ? 0 : x < y ? -1 : 1;
}

export const isInteger = (value: string): boolean => {
  const n = scaled(value);
  return n !== null && n % 10n ** BigInt(SCALE) === 0n;
};

/** (value − base) is a whole multiple of step; a non-positive step never matches. */
export function isStepOf(value: string, step: string, base = '0'): boolean {
  const v = scaled(value);
  const s = scaled(step);
  const b = scaled(base);
  if (v === null || s === null || b === null || s <= 0n) return false;
  return (v - b) % s === 0n;
}
