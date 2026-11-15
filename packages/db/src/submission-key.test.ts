import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isUuidV7, newSubmissionKey, submissionKey, uuidV7, uuidV7Time } from './submission-key.ts';

const dialect = new PgDialect();

describe('uuidV7', () => {
  it('makes a version 7, variant 10 uuid that carries the moment it was made for', () => {
    const at = new Date('2026-11-15T09:30:00.123Z');
    const id = uuidV7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuidV7(id)).toBe(true);
    expect(uuidV7Time(id)?.toISOString()).toBe('2026-11-15T09:30:00.123Z');
  });

  it('is the same moment the first 48 bits say, whatever the random bits are', () => {
    for (const fill of [0x00, 0xff, 0xa5]) {
      const id = uuidV7(new Date(1_700_000_000_000), (n) => new Uint8Array(n).fill(fill));
      expect(uuidV7Time(id)?.getTime()).toBe(1_700_000_000_000);
      expect(isUuidV7(id)).toBe(true);
    }
  });

  it('sorts by time: a later moment is a larger id', () => {
    const ids = [0, 1, 1000, 86_400_000, 2 ** 40].map((ms) => uuidV7(new Date(ms)));
    expect([...ids].sort()).toEqual(ids);
  });

  it('refuses a moment a 48-bit millisecond clock cannot hold', () => {
    expect(() => uuidV7(new Date(-1))).toThrow(RangeError);
    expect(() => uuidV7(new Date(2 ** 48))).toThrow(RangeError);
    expect(() => uuidV7(new Date(Number.NaN))).toThrow(RangeError);
    expect(uuidV7Time(uuidV7(new Date(2 ** 48 - 1)))?.getTime()).toBe(2 ** 48 - 1);
  });
});

describe('uuidV7Time', () => {
  it('is null for anything that is not a UUIDv7: the database would refuse to take its moment', () => {
    for (const id of [randomUUID(), '00000000-0000-0000-0000-000000000000', '018f0000-0000-7000-c000-000000000000', '018f0000-0000-6000-8000-000000000000', 'x', '']) {
      expect(uuidV7Time(id), id).toBeNull();
      expect(isUuidV7(id), id).toBe(false);
    }
    expect(isUuidV7(undefined)).toBe(false);
  });

  it('reads an upper-case id too', () => {
    const id = uuidV7(new Date(1_700_000_000_123));
    expect(uuidV7Time(id.toUpperCase())?.getTime()).toBe(1_700_000_000_123);
  });
});

describe('newSubmissionKey', () => {
  it('has the received_at the CHECK wants: exactly the moment inside the id', () => {
    const key = newSubmissionKey(new Date('2026-11-15T09:30:00.987Z'));
    expect(key.receivedAt.toISOString()).toBe('2026-11-15T09:30:00.987Z');
    expect(uuidV7Time(key.id)?.getTime()).toBe(key.receivedAt.getTime());
  });
});

describe('submissionKey', () => {
  it('names the id and the partition key it implies', () => {
    const id = uuidV7(new Date('2026-11-15T09:30:00.123Z'));
    const { sql, params } = dialect.sqlToQuery(submissionKey(id));
    expect(sql).toBe('("submissions"."id" = $1 and "submissions"."received_at" = $2)');
    expect(params[0]).toBe(id);
    expect(new Date(params[1] as Date).toISOString()).toBe('2026-11-15T09:30:00.123Z');
  });

  it('is false for an id that is not a UUIDv7, so a made-up id in a URL finds nothing instead of raising', () => {
    const { sql, params } = dialect.sqlToQuery(submissionKey(randomUUID()));
    expect(sql).toBe('false');
    expect(params).toEqual([]);
  });
});
