import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid7.ts';

describe('uuidv7', () => {
  it('has the version and variant bits and carries the clock in its first 48 bits', () => {
    const at = Date.UTC(2026, 10, 15, 10, 30, 0, 123);
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at);
  });

  it('sorts by creation time and does not repeat', () => {
    const ids = [1_000, 2_000, 3_000].map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(Array.from({ length: 200 }, () => uuidv7(5_000))).size).toBe(200);
  });
});
