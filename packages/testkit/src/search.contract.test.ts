import { describe, expect, it } from 'vitest';
import { searchContractReceivedAt } from './search.contract.ts';

const MINUTE = 60_000;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** BL-262: the contract's documents must land in a month that has a partition (the current one onward) at any moment of the month. */
describe('searchContractReceivedAt', () => {
  it('is a minute before now in the middle of a month', () => {
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(searchContractReceivedAt(now)).toBe(now - MINUTE);
    expect(searchContractReceivedAt(now, 21)).toBe(now - MINUTE + 21);
  });

  it('stays in the current month through the first minute of a month, where now - 60 s is last month', () => {
    for (const now of [Date.UTC(2026, 11, 1, 0, 0, 0, 0), Date.UTC(2026, 11, 1, 0, 0, 20, 500), Date.UTC(2026, 11, 1, 0, 0, 59, 999), Date.UTC(2027, 0, 1, 0, 0, 5)]) {
      const naive = now - MINUTE;
      expect(monthOf(naive), 'the old formula leaves the month').not.toBe(monthOf(now));
      // The offsets the contract adds grow by 7 ms a document; even a few thousand of them stay in the month.
      for (const offset of [0, 7, 700, 7 * 5000]) expect(monthOf(searchContractReceivedAt(now, offset)), `${new Date(now).toISOString()} + ${offset} ms`).toBe(monthOf(now));
    }
  });

  it('is the start of the month, not before it, when the month is a minute old or less', () => {
    const monthStart = Date.UTC(2026, 11, 1);
    expect(searchContractReceivedAt(monthStart + 10_000)).toBe(monthStart);
    expect(searchContractReceivedAt(monthStart + MINUTE)).toBe(monthStart);
    expect(searchContractReceivedAt(monthStart + MINUTE + 1)).toBe(monthStart + 1);
  });

  it('stays in the month on the last second of a month, and in February of a leap year', () => {
    for (const now of [Date.UTC(2026, 10, 30, 23, 59, 59, 999), Date.UTC(2028, 1, 29, 23, 59, 59, 999), Date.UTC(2028, 2, 1, 0, 0, 30)]) {
      expect(monthOf(searchContractReceivedAt(now, 7 * 100))).toBe(monthOf(now));
    }
  });
});
