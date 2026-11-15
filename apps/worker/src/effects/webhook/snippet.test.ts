import { describe, expect, it } from 'vitest';
import { MAX_SNIPPET_CHARS, scrubSnippet } from './snippet.ts';

/*
 * WP-1.18: what the delivery log keeps of a receiver's answer. A receiver may echo the response it was sent, so the stored
 * text must not hold an address or a long number, and must fit the column (1024 characters, no NUL).
 */

describe('scrubSnippet', () => {
  it('replaces email-like words, including the ones glued to punctuation', () => {
    expect(scrubSnippet('thanks asha.kumar@example.com, saved')).toBe('thanks [email], saved');
    expect(scrubSnippet('{"email":"a+b@example.co.in"}')).toBe('{"email":"[email]"}');
    expect(scrubSnippet('user@localhost')).toBe('[email]');
  });

  it('replaces runs of six or more digits, also split by spaces or dashes and in other scripts', () => {
    expect(scrubSnippet('phone 9876543210 ok')).toBe('phone [number] ok');
    expect(scrubSnippet('card 4111 1111 1111 1111 ok')).toBe('card [number] ok');
    expect(scrubSnippet('aadhaar 1234-5678-9012')).toBe('aadhaar [number]');
    expect(scrubSnippet('फोन ९८७६५४३२१०')).toBe('फोन [number]');
  });

  it('keeps short numbers, dotted addresses and status words', () => {
    expect(scrubSnippet('HTTP 500 at 169.254.169.254 after 12345 ms')).toBe('HTTP 500 at 169.254.169.254 after 12345 ms');
  });

  it('collapses white space and control characters, so a NUL never reaches the column', () => {
    expect(scrubSnippet('a\u0000b\r\n\t c\u007fd')).toBe('a b c d');
  });

  it('cuts to the column limit after scrubbing, so an address cut in half cannot leave a fragment', () => {
    const text = `${'x'.repeat(MAX_SNIPPET_CHARS - 6)} asha@example.com tail`;
    const out = scrubSnippet(text)!;
    expect(out.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(out).not.toContain('asha');
    expect(out).not.toContain('example');
    expect(scrubSnippet('y'.repeat(5000))).toHaveLength(MAX_SNIPPET_CHARS);
  });

  it('is null when nothing is left', () => {
    expect(scrubSnippet('')).toBeNull();
    expect(scrubSnippet(' \n\t\u0000 ')).toBeNull();
  });
});
