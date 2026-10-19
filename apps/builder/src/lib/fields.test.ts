import { describe, expect, it } from 'vitest';
import { ratingCount, scaleRange } from '@/lib/fields';
import { block } from '@/test/fixtures';

describe('B28: rating and scale clamps', () => {
  it('ratingCount stays within 1-10 and defaults to 5', () => {
    expect(ratingCount(block('rating'))).toBe(5);
    expect(ratingCount(block('rating', { customize: { ratingMax: 1e7 } }))).toBe(10);
    expect(ratingCount(block('rating', { customize: { ratingMax: -3 } }))).toBe(1);
    expect(ratingCount(block('rating', { customize: { ratingMax: Number.NaN } }))).toBe(5);
  });

  it('scaleRange is the migrated v2 range: start 0 or 1, end 2-10', () => {
    expect(scaleRange(block('linear_scale'))).toEqual([1, 5]);
    expect(scaleRange(block('linear_scale', { customize: { scaleMin: 0, scaleMax: 10 } }))).toEqual([0, 10]);
    expect(scaleRange(block('linear_scale', { customize: { scaleMin: 0, scaleMax: 1e7 } }))).toEqual([0, 10]);
    expect(scaleRange(block('linear_scale', { customize: { scaleMin: -5, scaleMax: 4 } }))).toEqual([0, 4]);
    expect(scaleRange(block('linear_scale', { customize: { scaleMin: 5, scaleMax: 2 } }))).toEqual([1, 2]);
  });
});
