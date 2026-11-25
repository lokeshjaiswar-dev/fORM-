import { describe, expect, it } from 'vitest';
import { lookupCacheKey, OPTION_LIMITS, publicOptions } from './project.ts';

describe('options route caps (review nit)', () => {
  it('clips ids, codes and labels and keeps at most 500 options', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `${i}-${'i'.repeat(400)}`, label: 'L'.repeat(2048), code: 'c'.repeat(300) }));
    const out = publicOptions(many as never);
    expect(out).toHaveLength(OPTION_LIMITS.count);
    expect(out[0]!.id).toHaveLength(200);
    expect(out[0]!.label).toHaveLength(500);
    expect(out[0]!.code).toHaveLength(200);
    expect(JSON.stringify(out).length).toBeLessThan(500 * 1000);
  });
  it('drops an option with an empty id and keeps a missing label as empty', () => {
    expect(publicOptions([{ id: '', label: 'x' }, { id: 'a', label: 'A' }] as never)).toEqual([{ id: 'a', label: 'A' }]);
  });
});

describe('lookup cache key (review nit: case-sensitive upstream search)', () => {
  it('folds case only when the server filters the list itself', () => {
    expect(lookupCacheKey('v', 'hr', 'MAYA', 'q')).not.toBe(lookupCacheKey('v', 'hr', 'maya', 'q'));
    expect(lookupCacheKey('v', 'hr', ' maya ', 'q')).toBe(lookupCacheKey('v', 'hr', 'maya', 'q'));
    expect(lookupCacheKey('v', 'hr', 'MAYA', undefined)).toBe(lookupCacheKey('v', 'hr', 'maya', undefined));
    expect(lookupCacheKey('v', 'hr', 'é', 'q')).toBe(lookupCacheKey('v', 'hr', 'é', 'q'));
  });
});
