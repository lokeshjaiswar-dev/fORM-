import { describe, expect, it } from 'vitest';
import { serialPeriod } from './serials.ts';

describe('serialPeriod', () => {
  const at = new Date('2026-11-23T10:00:00Z');

  it('uses one period for a field that never resets', () => {
    expect(serialPeriod('never', at, 'Asia/Kolkata')).toBe('');
    expect(serialPeriod('never', new Date('2031-01-01T00:00:00Z'), 'Asia/Kolkata')).toBe('');
  });

  it('keys yearly and monthly counters by the calendar of the form', () => {
    expect(serialPeriod('year', at, 'Asia/Kolkata')).toBe('2026');
    expect(serialPeriod('month', at, 'Asia/Kolkata')).toBe('2026-11');
  });

  it('turns over at midnight in the form time zone, not in UTC', () => {
    // 20:00 UTC on 31 December is 01:30 on 1 January in India.
    const newYearInIndia = new Date('2026-12-31T20:00:00Z');
    expect(serialPeriod('year', newYearInIndia, 'UTC')).toBe('2026');
    expect(serialPeriod('year', newYearInIndia, 'Asia/Kolkata')).toBe('2027');
    expect(serialPeriod('month', newYearInIndia, 'Asia/Kolkata')).toBe('2027-01');
    // 03:00 UTC on 1 March is still 28 February in New York.
    expect(serialPeriod('month', new Date('2026-03-01T03:00:00Z'), 'America/New_York')).toBe('2026-02');
  });

  it('falls back to UTC for a time zone it does not know', () => {
    expect(serialPeriod('month', new Date('2026-12-31T20:00:00Z'), 'Mars/Olympus_Mons')).toBe('2026-12');
  });

  it('always produces a value the period check constraint accepts', () => {
    const allowed = /^([0-9]{4}(-[0-9]{2})?)?$/;
    for (const reset of ['never', 'year', 'month'] as const) {
      expect(serialPeriod(reset, at, 'Pacific/Kiritimati')).toMatch(allowed);
    }
  });
});
