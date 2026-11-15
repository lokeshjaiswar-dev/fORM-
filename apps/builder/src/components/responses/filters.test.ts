import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FILTERS, dayEnd, dayStart, hasFilters, rangeIsBackwards, toGridQuery, useDebounced, type ResponseFilters } from '@/components/responses/filters';

const filters = (change: Partial<ResponseFilters>): ResponseFilters => ({ ...NO_FILTERS, ...change });

describe('dayStart and dayEnd', () => {
  it('are the first and the last moment of the member’s day, as ISO instants', () => {
    expect(dayStart('2026-11-15')).toBe(new Date('2026-11-15T00:00:00').toISOString());
    expect(dayEnd('2026-11-15')).toBe(new Date('2026-11-15T23:59:59.999').toISOString());
    expect(Date.parse(dayEnd('2026-11-15')!) - Date.parse(dayStart('2026-11-15')!)).toBeGreaterThanOrEqual(23 * 3600_000);
  });

  it('are nothing for no day or for text that is not a date', () => {
    expect(dayStart('')).toBeUndefined();
    expect(dayEnd('')).toBeUndefined();
    expect(dayStart('15/11/2026')).toBeUndefined();
    expect(dayEnd('not a date')).toBeUndefined();
  });
});

describe('toGridQuery', () => {
  it('is the folder alone when nothing is set', () => {
    expect(toGridQuery('inbox', NO_FILTERS)).toEqual({ view: 'inbox' });
    expect(toGridQuery('trash', NO_FILTERS)).toEqual({ view: 'trash' });
  });

  it('maps each control to the API’s filter: search words trimmed, dates as instants, read as a boolean, starred only when ticked', () => {
    const query = toGridQuery('archived', filters({ q: '  ada ', from: '2026-11-01', to: '2026-11-02', read: 'unread', starred: true, status: 'spam' }));
    expect(query).toEqual({
      view: 'archived',
      q: 'ada',
      from: new Date('2026-11-01T00:00:00').toISOString(),
      to: new Date('2026-11-02T23:59:59.999').toISOString(),
      read: false,
      starred: true,
      status: 'spam',
    });
    expect(toGridQuery('inbox', filters({ read: 'read' }))).toEqual({ view: 'inbox', read: true });
  });

  it('leaves out a blank search, an unticked star and "all"', () => {
    expect(toGridQuery('inbox', filters({ q: '   ', starred: false, read: 'all', status: 'all' }))).toEqual({ view: 'inbox' });
  });

  it('is null for a range that ends before it starts, and fine for one day', () => {
    expect(rangeIsBackwards(filters({ from: '2026-11-20', to: '2026-11-10' }))).toBe(true);
    expect(toGridQuery('inbox', filters({ from: '2026-11-20', to: '2026-11-10' }))).toBeNull();
    expect(rangeIsBackwards(filters({ from: '2026-11-10', to: '2026-11-10' }))).toBe(false);
    expect(toGridQuery('inbox', filters({ from: '2026-11-10', to: '2026-11-10' }))).not.toBeNull();
    expect(rangeIsBackwards(filters({ from: '2026-11-20' }))).toBe(false);
  });
});

describe('hasFilters', () => {
  it('is true for every control that narrows the list, and false for none', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters(filters({ q: ' ' }))).toBe(false);
    for (const change of [{ q: 'a' }, { from: '2026-11-01' }, { to: '2026-11-01' }, { read: 'read' as const }, { starred: true }, { status: 'spam' as const }]) {
      expect(hasFilters(filters(change))).toBe(true);
    }
  });
});

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives the value once it has stopped changing for the pause, and only the last one', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), { initialProps: { value: '' } });
    rerender({ value: 'a' });
    act(() => void vi.advanceTimersByTime(200));
    rerender({ value: 'ab' });
    act(() => void vi.advanceTimersByTime(200));
    // 400 ms in, but only 200 since the last key.
    expect(result.current).toBe('');
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBe('ab');
  });
});
