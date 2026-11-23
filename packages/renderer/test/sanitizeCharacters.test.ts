import { describe, expect, it } from 'vitest';
import { sanitizeCharacters } from '../src/controls/sanitize.ts';

describe('sanitizeCharacters', () => {
  it('drops what a short text does not allow as it is typed, keeping letters and spaces', () => {
    expect(sanitizeCharacters('Flat #4, Śarmā', { numbers: false, special: false })).toBe('Flat  Śarmā');
    expect(sanitizeCharacters('Flat #4B', { numbers: true, special: false })).toBe('Flat 4B');
    expect(sanitizeCharacters("O'Neil 007", { numbers: false, special: true })).toBe("O'Neil ");
    expect(sanitizeCharacters('any #1!', { numbers: true, special: true })).toBe('any #1!');
    expect(sanitizeCharacters('any #1!', undefined)).toBe('any #1!');
  });
});
