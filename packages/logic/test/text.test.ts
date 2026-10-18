import { GRAPHEME_UNICODE_VERSION } from '@form/i18n';
import { describe, expect, it } from 'vitest';
import { CASE_FOLD_UNICODE_VERSION, caseFold, comparable, compareDecimal, nfc, parseDecimal, textLength } from '../src/index.ts';

describe('text', () => {
  it('pins case folding to the Unicode version of the grapheme segmenter', () => {
    expect(CASE_FOLD_UNICODE_VERSION).toBe(GRAPHEME_UNICODE_VERSION);
  });

  it('folds simply (C + S), never with host or full mappings', () => {
    expect(caseFold('ΣΊΣΥΦΟΣ')).toBe('σίσυφοσ');
    expect(caseFold('straße')).toBe('straße');
    expect(caseFold('ẞ')).toBe('ß');
    expect(caseFold('İ')).toBe('İ');
    expect(caseFold('ǅ')).toBe('ǆ');
    expect(caseFold('ꭰ')).toBe('Ꭰ');
    expect(caseFold('\u{10400}')).toBe('\u{10428}');
    expect(caseFold('Å')).toBe('å');
    expect(caseFold('नमस्ते')).toBe('नमस्ते');
  });

  it('compares in NFC, folded unless case-sensitive', () => {
    expect(nfc('Cafe\u0301')).toBe('Café');
    expect(comparable('CAFE\u0301', false)).toBe('café');
    expect(comparable('CAFE\u0301', true)).toBe('CAFÉ');
  });

  it('counts grapheme clusters with the pinned segmenter', () => {
    expect(textLength('क्षत्रिय')).toBe(3);
    expect(textLength('👩🏽‍💻🇮🇳')).toBe(2);
    expect(textLength('e\u0301')).toBe(1);
  });
});

describe('decimal', () => {
  it('accepts DecimalString only', () => {
    expect(parseDecimal('12.5')?.toString()).toBe('12.5');
    for (const bad of ['1e3', '01', '.5', '1.', '1.12345678901', ' 1', 'NaN', 'Infinity', '']) expect(parseDecimal(bad), bad).toBeNull();
    expect(parseDecimal('123456789012345678901234567.12345678')).toBeNull();
  });

  it('orders exactly', () => {
    expect(compareDecimal('0.3', '0.30')).toBe(0);
    expect(compareDecimal('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareDecimal('-0', '0')).toBe(0);
    expect(compareDecimal('x', '0')).toBeNull();
  });
});
