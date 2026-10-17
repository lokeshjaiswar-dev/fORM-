import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney } from './money';

describe('formatMoney', () => {
  it('formats INR minor units with the rupee sign and lakh grouping', () => {
    expect(formatMoney('123456789', 'INR')).toBe('₹12,34,567.89');
    expect(formatMoney('49900', 'INR')).toBe('₹499.00');
    expect(formatMoney('5', 'INR')).toBe('₹0.05');
    expect(formatMoney(0n, 'inr')).toBe('₹0.00');
    expect(formatMoney(-150, 'INR')).toBe('-₹1.50');
  });

  it('uses the ISO 4217 exponent of the currency', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('INR')).toBe(2);
    expect(formatMoney('1234567', 'JPY', { grouping: 'international' })).toBe('JPY 1,234,567');
    expect(formatMoney('1234567', 'KWD', { grouping: 'international' })).toBe('KWD 1,234.567');
  });

  it('shows symbols or codes', () => {
    expect(formatMoney('123456', 'USD', { grouping: 'international' })).toBe('US$1,234.56');
    expect(formatMoney('123456', 'EUR', { grouping: 'international' })).toBe('€1,234.56');
    expect(formatMoney('123456', 'INR', { display: 'code' })).toBe('INR 1,234.56');
  });

  it('returns an empty string for invalid input', () => {
    expect(formatMoney('12.50', 'INR')).toBe('');
    expect(formatMoney(1.5, 'INR')).toBe('');
    expect(formatMoney('100', 'RUPEES')).toBe('');
  });
});
