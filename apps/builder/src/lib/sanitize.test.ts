import { describe, expect, it } from 'vitest';
import { escapeHtml, isSafeLink, safeRedirectUrl, sanitizeHtml } from '@/lib/sanitize';

describe('sanitizeHtml', () => {
  it('keeps the allowed formatting tags', () => {
    expect(sanitizeHtml('<b>b</b><i>i</i><u>u</u><s>s</s><p>p<br></p><span>x</span>')).toBe(
      '<b>b</b><i>i</i><u>u</u><s>s</s><p>p<br></p><span>x</span>',
    );
  });

  it('drops script, event handlers and tags outside the allowlist, keeping their text', () => {
    expect(sanitizeHtml('<img src=x onerror=alert(1)><script>alert(1)</script><b onclick="x()">ok</b>')).toBe('<b>ok</b>');
    expect(sanitizeHtml('<div><font color="red">t</font></div><svg><a>x</a></svg>')).toBe('t');
  });

  it('keeps only color and background-color in style', () => {
    expect(sanitizeHtml('<span style="color: red; background-color: #fff; position: fixed; background-image: url(x)">t</span>')).toBe(
      '<span style="color: red; background-color: rgb(255, 255, 255);">t</span>',
    );
    expect(sanitizeHtml('<span style="position: fixed">t</span>')).toBe('<span>t</span>');
  });

  it('allows only http, https, mailto and tel links, with a safe rel', () => {
    const a = (href: string) => new DOMParser().parseFromString(sanitizeHtml(`<a href="${href}">x</a>`), 'text/html').querySelector('a')!;
    for (const href of ['https://a.co', 'http://a.co', 'mailto:a@b.co', 'tel:+911234']) expect(a(href).getAttribute('href')).toBe(href);
    for (const href of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative']) {
      expect(a(href).hasAttribute('href')).toBe(false);
    }
    expect(a('https://a.co').getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });
});

describe('escapeHtml', () => {
  it('escapes markup so typed text renders as text', () => {
    expect(escapeHtml(`<img src=x onerror="a('1')"> & co`)).toBe('&lt;img src=x onerror=&quot;a(&#39;1&#39;)&quot;&gt; &amp; co');
    expect(sanitizeHtml(escapeHtml('<b>x</b>'))).toBe('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('isSafeLink and safeRedirectUrl', () => {
  it('S4: links accept only https, http, mailto and tel', () => {
    expect(['https://a.co', 'http://a.co', 'mailto:a@b.co', 'tel:123'].every(isSafeLink)).toBe(true);
    expect(['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'ftp://a.co', 'not a url', ''].some(isSafeLink)).toBe(false);
  });

  it('S6: redirects accept only http(s) URLs', () => {
    expect(safeRedirectUrl(' https://a.co/thanks ')).toBe('https://a.co/thanks');
    expect(safeRedirectUrl('http://a.co')).toBe('http://a.co');
    for (const url of ['javascript:alert(1)', 'mailto:a@b.co', 'data:text/html,x', '//a.co', '']) expect(safeRedirectUrl(url)).toBeNull();
  });
});
