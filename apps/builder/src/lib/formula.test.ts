import { describe, expect, it } from 'vitest';
import type { BlockId } from '@form/schema';
import { formatFormula, parseFormula } from '@/lib/formula';

const fields = new Map<string, BlockId>([
  ['qty', 'qty' as BlockId],
  ['price', 'price' as BlockId],
  ['tax', 'tax' as BlockId],
]);
const keys = new Map<BlockId, string>([
  ['qty' as BlockId, 'qty'],
  ['price' as BlockId, 'price'],
  ['tax' as BlockId, 'tax'],
]);

describe('parseFormula', () => {
  it('parses sums and products of field keys', () => {
    const parsed = parseFormula('qty * price + tax', fields);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatFormula(parsed.expr, keys)).toBe('qty * price + tax');
  });

  it('respects parentheses and unary minus', () => {
    const parsed = parseFormula('(qty + price) * -2', fields);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatFormula(parsed.expr, keys)).toBe('(qty + price) * -2');
  });

  it('rejects an unknown key', () => {
    expect(parseFormula('qty * missing', fields)).toMatchObject({ ok: false });
  });
});
