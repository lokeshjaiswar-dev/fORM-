import { describe, expect, it } from 'vitest';
import { defaultGrouping, formatNumber } from './number';

describe('formatNumber', () => {
  it('groups in lakh and crore by default', () => {
    expect(formatNumber(1234567.89)).toBe('12,34,567.89');
    expect(formatNumber(123456789)).toBe('12,34,56,789');
    expect(formatNumber(100000)).toBe('1,00,000');
    expect(formatNumber(99999)).toBe('99,999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-1234567.5)).toBe('-12,34,567.5');
  });

  it('supports international, no grouping and a comma decimal separator', () => {
    expect(formatNumber(1234567.89, { grouping: 'international' })).toBe('1,234,567.89');
    expect(formatNumber(1234567.89, { grouping: 'none' })).toBe('1234567.89');
    expect(formatNumber(1234567.89, { grouping: 'international', decimalSeparator: ',' })).toBe('1.234.567,89');
    expect(formatNumber(1234567.89, { decimalSeparator: ',' })).toBe('12.34.567,89');
  });

  it('rounds half away from zero to fixed decimals', () => {
    expect(formatNumber('1.005', { decimals: 2 })).toBe('1.01');
    expect(formatNumber('1.004', { decimals: 2 })).toBe('1.00');
    expect(formatNumber('-2.5', { decimals: 0 })).toBe('-3');
    expect(formatNumber('99999.96', { decimals: 1 })).toBe('1,00,000.0');
    expect(formatNumber('999.5', { decimals: 0 })).toBe('1,000');
    expect(formatNumber(12, { decimals: 2 })).toBe('12.00');
    expect(formatNumber('-0.001', { decimals: 2 })).toBe('0.00');
  });

  it('keeps decimal strings and bigints exact', () => {
    expect(formatNumber('12345678901234567890.1234567890')).toBe('1,23,45,67,89,01,23,45,67,890.1234567890');
    expect(formatNumber(12345678901234567890n)).toBe('1,23,45,67,89,01,23,45,67,890');
    expect(formatNumber('007.50')).toBe('7.50');
  });

  it('expands exponent notation of JS numbers', () => {
    expect(formatNumber(1e21)).toBe('1,00,00,00,00,00,00,00,00,00,000');
    expect(formatNumber(1.5e-7)).toBe('0.00000015');
    expect(formatNumber(-2.5e-7, { decimals: 7 })).toBe('-0.0000003');
  });

  it('returns an empty string for invalid input', () => {
    expect(formatNumber(Number.NaN)).toBe('');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatNumber('12a')).toBe('');
    expect(formatNumber('1e5')).toBe('');
    expect(formatNumber('')).toBe('');
  });

  it('returns an empty string for non-finite decimals', () => {
    expect(formatNumber(1.5, { decimals: Number.NaN })).toBe('');
    expect(formatNumber(1.5, { decimals: Number.POSITIVE_INFINITY })).toBe('');
    expect(formatNumber(1.5, { decimals: 99 })).toBe(`1.5${'0'.repeat(19)}`);
  });

  it('agrees with Intl en-IN grouping for integers', () => {
    const intl = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
    let seed = 42;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const magnitude = Math.floor((seed / 2147483648) * 10 ** ((i % 15) + 1));
      const value = i % 2 && magnitude ? -magnitude : magnitude;
      expect(formatNumber(value)).toBe(intl.format(value));
    }
  });
});

describe('defaultGrouping', () => {
  it('uses lakh/crore for India and the pseudo-locale', () => {
    expect(defaultGrouping('en-IN')).toBe('indian');
    expect(defaultGrouping('hi-IN')).toBe('indian');
    expect(defaultGrouping('ur-Arab-IN')).toBe('indian');
    expect(defaultGrouping('en-XA')).toBe('indian');
    expect(defaultGrouping('en-US')).toBe('international');
    expect(defaultGrouping('en')).toBe('international');
  });

  it('uses lakh/crore for Indic languages without a region or in their home regions', () => {
    for (const locale of ['hi', 'bn', 'bn-BD', 'mr', 'ta', 'ta-LK', 'te', 'gu', 'ml', 'pa', 'pa-Guru', 'ne-NP', 'hi-Latn']) {
      expect(defaultGrouping(locale), locale).toBe('indian');
    }
    for (const locale of ['kn', 'ur', 'ur-PK', 'pa-Arab', 'pa-PK', 'ta-SG', 'ta-MY', 'de', 'not a locale']) {
      expect(defaultGrouping(locale), locale).toBe('international');
    }
  });
});
