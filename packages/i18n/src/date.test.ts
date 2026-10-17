import { describe, expect, it } from 'vitest';
import { SUPPORTED_DATE_PATTERNS, formatDate, formatDateTime, formatTime } from './date';

describe('formatDate', () => {
  it('formats every schema date pattern', () => {
    const out = Object.fromEntries(SUPPORTED_DATE_PATTERNS.map((p) => [p, formatDate('2026-09-05', p)]));
    expect(out).toEqual({
      'DD-MM-YYYY': '05-09-2026',
      'DD/MM/YYYY': '05/09/2026',
      'MM/DD/YYYY': '09/05/2026',
      'YYYY-MM-DD': '2026-09-05',
      'D MMM YYYY': '5 Sep 2026',
      'MMMM D, YYYY': 'September 5, 2026',
    });
  });

  it('defaults to DD-MM-YYYY with a configurable separator', () => {
    expect(formatDate('2027-01-31', 'DD-MM-YYYY')).toBe('31-01-2027');
    expect(formatDate('2027-01-31', 'DD-MM-YYYY', { separator: '.' })).toBe('31.01.2027');
    expect(formatDate('2027-01-31', 'DD/MM/YYYY', { separator: '-' })).toBe('31-01-2027');
  });

  it('rejects invalid dates', () => {
    expect(formatDate('2024-02-29', 'DD-MM-YYYY')).toBe('29-02-2024');
    expect(formatDate('2025-02-29', 'DD-MM-YYYY')).toBe('');
    expect(formatDate('1900-02-29', 'DD-MM-YYYY')).toBe('');
    expect(formatDate('2000-02-29', 'DD-MM-YYYY')).toBe('29-02-2000');
    expect(formatDate('2026-04-31', 'DD-MM-YYYY')).toBe('');
    expect(formatDate('2026-13-01', 'DD-MM-YYYY')).toBe('');
    expect(formatDate('05-09-2026', 'DD-MM-YYYY')).toBe('');
  });
});

describe('formatTime', () => {
  it('formats both hour cycles', () => {
    expect(formatTime('00:05', 'h12')).toBe('12:05 am');
    expect(formatTime('12:00', 'h12')).toBe('12:00 pm');
    expect(formatTime('14:30', 'h12')).toBe('2:30 pm');
    expect(formatTime('14:30', 'h23')).toBe('14:30');
    expect(formatTime('09:07:59', 'h23')).toBe('09:07');
    expect(formatTime('24:00', 'h23')).toBe('');
    expect(formatTime('9:00', 'h23')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('joins the wall-clock date and time', () => {
    expect(formatDateTime('2026-09-05T18:45', 'DD-MM-YYYY', 'h12')).toBe('05-09-2026, 6:45 pm');
    expect(formatDateTime('2026-09-05', 'DD-MM-YYYY', 'h12')).toBe('');
    expect(formatDateTime('2026-09-05T18:45T1', 'DD-MM-YYYY', 'h12')).toBe('');
  });
});
