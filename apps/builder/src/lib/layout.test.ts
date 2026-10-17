import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isHalf, packRows } from '@/lib/layout';
import type { FormBlock } from '@/types/form';
import { block } from '@/test/fixtures';

function half(id: string, besidePrevious = false) {
  return block('text', { id, customize: { width: 'half', besidePrevious } });
}

const ids = (rows: FormBlock[][]) => rows.map((r) => r.map((b) => b.id));

describe('isHalf', () => {
  it('is true only for width half', () => {
    expect(isHalf(half('a'))).toBe(true);
    expect(isHalf(block('text', { customize: { width: 'full' } }))).toBe(false);
    expect(isHalf(block('text'))).toBe(false);
  });
});

describe('packRows', () => {
  it('puts a half block beside a preceding lone half block', () => {
    expect(ids(packRows([half('a'), half('b', true)]))).toEqual([['a', 'b']]);
  });

  it('starts a new row without besidePrevious', () => {
    expect(ids(packRows([half('a'), half('b')]))).toEqual([['a'], ['b']]);
  });

  it('never puts more than two blocks in a row', () => {
    expect(ids(packRows([half('a'), half('b', true), half('c', true)]))).toEqual([['a', 'b'], ['c']]);
  });

  it('does not pair with a full-width block on either side', () => {
    const full = block('text', { id: 'f' });
    expect(ids(packRows([full, half('b', true)]))).toEqual([['f'], ['b']]);
    const fullBeside = block('text', { id: 'g', customize: { besidePrevious: true } });
    expect(ids(packRows([half('a'), fullBeside]))).toEqual([['a'], ['g']]);
  });

  it('keeps a leading besidePrevious block on its own row', () => {
    expect(ids(packRows([half('a', true)]))).toEqual([['a']]);
  });

  it('preserves block order and uses rows of one or two', () => {
    const arb = fc.array(
      fc.record({ width: fc.constantFrom('full' as const, 'half' as const, undefined), besidePrevious: fc.boolean() }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(arb, (specs) => {
        const blocks = specs.map((customize, i) => block('text', { id: String(i), customize }));
        const rows = packRows(blocks);
        expect(rows.flat().map((b) => b.id)).toEqual(blocks.map((b) => b.id));
        for (const row of rows) {
          expect(row.length === 1 || (row.length === 2 && row.every(isHalf))).toBe(true);
        }
      }),
    );
  });
});
