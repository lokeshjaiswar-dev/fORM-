import { describe, expect, it } from 'vitest';
import { firstUnstorable, storableJson, storableString, unstorableText } from './text-safety.ts';
import { z } from 'zod';

describe('text Postgres can store', () => {
  it('refuses NUL and other control characters, but not tab, line feed, carriage return or ordinary Unicode', () => {
    expect(unstorableText('a\u0000b')).toBe('control_character');
    expect(unstorableText('bell\u0007')).toBe('control_character');
    expect(unstorableText('esc\u001b[31m')).toBe('control_character');
    expect(unstorableText('del\u007f')).toBe('control_character');
    expect(unstorableText('one\ttwo\r\nthree')).toBeNull();
    expect(unstorableText('नमस्ते, café, 日本語, 😀')).toBeNull();
  });

  it('refuses a lone surrogate, which JSON writes as an escape that jsonb rejects', () => {
    expect(unstorableText('\ud800')).toBe('broken_unicode');
    expect(unstorableText('x\udc00y')).toBe('broken_unicode');
    expect(unstorableText('😀')).toBeNull();
  });

  it('finds the path of the first bad key or value at any depth', () => {
    expect(firstUnstorable({ a: { b: ['ok', { c: 'bad\u0000' }] } })).toEqual(['a', 'b', 1, 'c']);
    expect(firstUnstorable({ 'k\u0000ey': 1 })).toEqual(['k\u0000ey']);
    expect(firstUnstorable({ a: ['x', 1, null, true], b: { c: 'fine' } })).toBeNull();
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(firstUnstorable(deep)).toHaveLength(5000);
  });

  it('is usable as a zod refinement that names the path', () => {
    const body = z.object({ answers: storableJson(z.record(z.string(), z.unknown())), label: storableString(10) });
    expect(body.safeParse({ answers: { q: { value: 'fine' } }, label: 'ok' }).success).toBe(true);
    const bad = body.safeParse({ answers: { q: { value: 'a\u0000b' } }, label: 'ok' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['answers', 'q', 'value']);
    expect(body.safeParse({ answers: {}, label: 'x\u0000' }).success).toBe(false);
    expect(body.safeParse({ answers: {}, label: 'x'.repeat(11) }).success).toBe(false);
  });
});
