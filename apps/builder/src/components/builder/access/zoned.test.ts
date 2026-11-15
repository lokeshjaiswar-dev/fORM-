import { describe, expect, it } from 'vitest';
import { instantToZoned, isKnownZone, zonedToInstant } from '@/components/builder/access/zoned';

describe('zonedToInstant', () => {
  it('reads a wall-clock time in Asia/Kolkata (UTC+5:30) as the UTC instant it is', () => {
    expect(zonedToInstant('2026-12-31T18:00', 'Asia/Kolkata')).toBe('2026-12-31T12:30:00.000Z');
    expect(zonedToInstant('2026-01-01T00:00', 'Asia/Kolkata')).toBe('2025-12-31T18:30:00.000Z');
  });

  it('follows daylight saving time: the same wall time is a different instant in winter and summer', () => {
    expect(zonedToInstant('2026-01-15T09:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z');
    expect(zonedToInstant('2026-07-15T09:00', 'Europe/London')).toBe('2026-07-15T08:00:00.000Z');
    expect(zonedToInstant('2026-07-15T09:00', 'America/New_York')).toBe('2026-07-15T13:00:00.000Z');
  });

  it('does not depend on the time zone of the machine that runs it', () => {
    expect(zonedToInstant('2026-12-31T18:00', 'UTC')).toBe('2026-12-31T18:00:00.000Z');
  });

  it('refuses text that is not a real date and time, and a zone Intl does not know', () => {
    expect(zonedToInstant('2026-02-31T10:00', 'Asia/Kolkata')).toBeNull();
    expect(zonedToInstant('2026-13-01T10:00', 'Asia/Kolkata')).toBeNull();
    expect(zonedToInstant('2026-12-31T25:00', 'Asia/Kolkata')).toBeNull();
    expect(zonedToInstant('31/12/2026 18:00', 'Asia/Kolkata')).toBeNull();
    expect(zonedToInstant('', 'Asia/Kolkata')).toBeNull();
    expect(zonedToInstant('2026-12-31T18:00', 'Mars/Olympus')).toBeNull();
  });
});

describe('instantToZoned', () => {
  it('shows an instant as the wall clock of the zone, and is the inverse of zonedToInstant', () => {
    expect(instantToZoned('2026-12-31T12:30:00.000Z', 'Asia/Kolkata')).toBe('2026-12-31T18:00');
    for (const [local, zone] of [
      ['2026-12-31T18:00', 'Asia/Kolkata'],
      ['2026-07-15T09:30', 'America/New_York'],
      ['2026-01-01T00:00', 'Pacific/Auckland'],
      ['2026-06-30T23:59', 'Asia/Kolkata'],
    ] as const) {
      expect(instantToZoned(zonedToInstant(local, zone) ?? '', zone)).toBe(local);
    }
  });

  it('is empty for an instant or a zone it cannot read', () => {
    expect(instantToZoned('not a date', 'Asia/Kolkata')).toBe('');
    expect(instantToZoned('2026-12-31T12:30:00.000Z', 'Mars/Olympus')).toBe('');
  });
});

describe('isKnownZone', () => {
  it('knows IANA names', () => {
    expect(isKnownZone('Asia/Kolkata')).toBe(true);
    expect(isKnownZone('Nowhere/City')).toBe(false);
  });
});
