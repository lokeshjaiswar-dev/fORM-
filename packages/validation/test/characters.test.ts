import { describe, expect, it } from 'vitest';
import '../src/index.ts';
import { matchesCharacters } from '../src/formats.ts';

describe('short text characters', () => {
  it('letters and spaces are always allowed; digits and symbols follow the two switches', () => {
    const lettersOnly = { numbers: false, special: false };
    expect(matchesCharacters(lettersOnly, 'Ravi Kumar Śarmā')).toBe(true);
    expect(matchesCharacters(lettersOnly, 'Flat 4')).toBe(false);
    expect(matchesCharacters(lettersOnly, "O'Neil")).toBe(false);

    const withNumbers = { numbers: true, special: false };
    expect(matchesCharacters(withNumbers, 'Flat 4B')).toBe(true);
    expect(matchesCharacters(withNumbers, 'Flat #4')).toBe(false);

    const withSpecial = { numbers: false, special: true };
    expect(matchesCharacters(withSpecial, "O'Neil-Smith")).toBe(true);
    expect(matchesCharacters(withSpecial, 'Agent 007')).toBe(false);

    expect(matchesCharacters({ numbers: true, special: true }, 'anything #1!')).toBe(true);
  });
});
