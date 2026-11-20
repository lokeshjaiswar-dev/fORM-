import { describe, expect, it } from 'vitest';
import { uniqueComparable, uniqueFieldErrors } from '../src/v2/unique.ts';

describe('unique answers', () => {
  const blocks = { name: { unique: { normalize: 'trim_lower' as const, message: 'Taken' } } };

  it('folds case and spaces, and ignores an empty answer', () => {
    expect(uniqueComparable('trim_lower', { type: 'short_text', value: '  Asha   Rao ' })).toBe('asha rao');
    expect(uniqueComparable('exact', { type: 'short_text', value: 'Asha' })).toBe('Asha');
    expect(uniqueComparable('digits', { type: 'number', value: 'EMP-0042' })).toBe('0042');
    expect(uniqueComparable('e164', { type: 'phone', value: { e164: '+919876543210', country: 'IN' } })).toBe('+919876543210');
    expect(uniqueComparable('trim_lower', { type: 'short_text', value: '   ' })).toBeNull();
  });

  it('reports a field that matches an earlier submission', () => {
    const prior = [{ name: { type: 'short_text', value: 'Asha Rao' } }];
    expect(uniqueFieldErrors(blocks, { name: { type: 'short_text', value: ' asha  rao' } }, prior)).toEqual([
      { blockId: 'name', code: 'not_unique', message: 'Taken' },
    ]);
    expect(uniqueFieldErrors(blocks, { name: { type: 'short_text', value: 'Asha R.' } }, prior)).toEqual([]);
  });
});
