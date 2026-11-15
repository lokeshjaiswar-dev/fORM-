import { describe, expect, it } from 'vitest';
import { MAX_CURSOR_LENGTH, readCursor, signCursor } from './cursor.ts';

const SECRET = new Uint8Array(32).fill(7);
const OTHER_SECRET = new Uint8Array(32).fill(8);
const SCOPE = 'forms:org-a:updated:desc';

describe('signed cursors', () => {
  it('read back the values they were signed with, in order and type', () => {
    const token = signCursor(SECRET, SCOPE, ['2026-11-15 10:00:00.123456+00', '0192e0f0-1111-7000-8000-000000000001']);
    expect(readCursor(SECRET, SCOPE, token)).toEqual(['2026-11-15 10:00:00.123456+00', '0192e0f0-1111-7000-8000-000000000001']);
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, [42, null, 'x']))).toEqual([42, null, 'x']);
  });

  it('keep text that is not ASCII (a title is a sort key)', () => {
    const values = ['प्रपत्र "quoted" \\ ünïcode 😀', 'id'];
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, values))).toEqual(values);
  });

  it('are refused when any part was edited', () => {
    const token = signCursor(SECRET, SCOPE, ['a', 'b']);
    const [prefix, payload, signature] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify(['a', 'c']), 'utf8').toString('base64url');
    expect(readCursor(SECRET, SCOPE, `${prefix}.${forgedPayload}.${signature}`)).toBeNull();
    expect(readCursor(SECRET, SCOPE, `${prefix}.${payload}.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(readCursor(SECRET, SCOPE, `c2.${payload}.${signature}`)).toBeNull();
  });

  it('are refused for another key, or for another list (scope)', () => {
    const token = signCursor(SECRET, SCOPE, ['a', 'b']);
    expect(readCursor(OTHER_SECRET, SCOPE, token)).toBeNull();
    expect(readCursor(SECRET, 'forms:org-b:updated:desc', token)).toBeNull();
    expect(readCursor(SECRET, 'forms:org-a:updated:asc', token)).toBeNull();
  });

  it('are refused when they are not cursors at all', () => {
    for (const junk of ['', 'abc', 'c1', 'c1..', 'c1.a.b', 'c1.a.b.c', '.'.repeat(5), 'x'.repeat(MAX_CURSOR_LENGTH + 1)]) {
      expect(readCursor(SECRET, SCOPE, junk), junk).toBeNull();
    }
  });

  it('are refused when the signed payload is not a short, flat list of strings, numbers and nulls', () => {
    // Validly signed, wrongly shaped: only this API can sign, but a later bug must not turn into a crash in a query.
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, []))).toBeNull();
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, [['nested'] as unknown as string]))).toBeNull();
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, [{ a: 1 } as unknown as string]))).toBeNull();
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, [true as unknown as string]))).toBeNull();
    expect(readCursor(SECRET, SCOPE, signCursor(SECRET, SCOPE, Array.from({ length: 9 }, (_, i) => i)))).toBeNull();
  });
});
