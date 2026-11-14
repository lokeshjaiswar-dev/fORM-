// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { browserSession } from '../src/index.ts';

describe('browserSession', () => {
  afterEach(() => window.history.pushState({}, '', '/'));

  it('reports the page URL, its query parameters and the user agent for the host to pass as `session`', () => {
    window.history.pushState({}, '', '/f/launch?utm_source=news&utm_medium=email');
    const session = browserSession();
    expect(session.pageUrl).toBe(window.location.href);
    expect(session.urlParams).toEqual({ utm_source: 'news', utm_medium: 'email' });
    expect(session.userAgent).toBe(navigator.userAgent);
    expect(session).not.toHaveProperty('referrer');
    expect(session).not.toHaveProperty('embedOrigin');
  });
});
