import { describe, expect, it } from 'vitest';
import { patternError } from '@/lib/zodFromBlocks';

describe('patternError', () => {
  it('B12: an invalid pattern is reported, a valid or absent one is not', () => {
    expect(patternError('[')).toMatch(/Invalid pattern/);
    expect(patternError('^[0-9]+$')).toBeNull();
    expect(patternError(undefined)).toBeNull();
  });
});
