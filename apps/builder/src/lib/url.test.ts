import { describe, expect, it } from 'vitest';
import { safeRedirectUrl } from '@/lib/url';

describe('safeRedirectUrl', () => {
  it('S6: redirects accept only http(s) URLs', () => {
    expect(safeRedirectUrl(' https://a.co/thanks ')).toBe('https://a.co/thanks');
    expect(safeRedirectUrl('http://a.co')).toBe('http://a.co');
    for (const url of ['javascript:alert(1)', 'mailto:a@b.co', 'data:text/html,x', '//a.co', '']) expect(safeRedirectUrl(url)).toBeNull();
  });
});
