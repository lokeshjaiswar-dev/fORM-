import { describe, expect, it } from 'vitest';
import type { FormDefinition } from '@form/schema';
import { publishableDraft, withRedirectEnding } from '../../test/publishable-draft.ts';
import { redirectIssues } from './redirects.ts';

const PIPE = { pipe: { source: { kind: 'submission', key: 'unique_id' } } };
const ALLOWED = ['forms.acme.test'];

/** The messages `redirectIssues` gives for a redirect ending to `template` (empty when the address is allowed). */
const refused = (template: unknown[], allowlist: readonly string[] | null = ALLOWED) =>
  redirectIssues(withRedirectEnding(publishableDraft('0b2c1f5e-8a1d-4f57-9a43-6f3f6c0d9a11'), template), allowlist).map((i) => i.message);

describe('redirectIssues', () => {
  it('checks nothing when the form set no list (null), and refuses every redirect when it set an empty one', () => {
    expect(refused(['https://anywhere.test/'], null)).toEqual([]);
    expect(refused(['https://forms.acme.test/'], [])).toHaveLength(1);
  });

  it.each([
    ['a plain address', ['https://forms.acme.test/thanks']],
    ['no path at all', ['https://forms.acme.test']],
    ['upper case, and a trailing dot', ['HTTPS://Forms.ACME.test./thanks']],
    ['a port', ['https://forms.acme.test:8443/thanks']],
    ['plain http', ['http://forms.acme.test/thanks']],
    ['a query before a piped answer', ['https://forms.acme.test?id=', PIPE]],
    ['a path before a piped answer', ['https://forms.acme.test/thanks/', PIPE]],
    ['a template split into parts', ['https://forms.', 'acme.test/thanks']],
  ])('lets through %s', (_name, template) => {
    expect(refused(template)).toEqual([]);
  });

  it.each([
    ['another host', ['https://evil.test/thanks']],
    ['a subdomain of a listed host', ['https://evil.forms.acme.test/']],
    ['a listed host as a subdomain of another', ['https://forms.acme.test.evil.test/']],
    ['a listed host as the user name', ['https://forms.acme.test@evil.test/']],
    ['a listed host before a backslash, which browsers read as a slash', ['https://evil.test\\@forms.acme.test/']],
    ['a host that a piped answer can extend', ['https://forms.acme.test', PIPE]],
    ['a host that starts with a piped answer', ['https://', PIPE, '.acme.test/']],
    ['no host', ['https:///thanks']],
  ])('refuses %s', (_name, template) => {
    expect(refused(template)).toHaveLength(1);
  });

  it('matches an allowlist entry however it was written: case, a scheme, a trailing dot, a path', () => {
    for (const entry of ['FORMS.acme.test', 'https://forms.acme.test/', 'forms.acme.test.']) {
      expect(refused(['https://forms.acme.test/x'], [entry]), entry).toEqual([]);
    }
  });

  it('leaves an address that is not http(s) to the scheme check, which already refuses it', () => {
    expect(refused(['javascript:alert(1)'])).toEqual([]);
    expect(refused([])).toEqual([]);
  });

  it('covers a visit_url button of a message ending and a translation of a redirect URL', () => {
    const base = publishableDraft('0b2c1f5e-8a1d-4f57-9a43-6f3f6c0d9a11');
    const [message] = base.endings;
    const withButton = {
      ...base,
      endings: [{ ...message, actions: [...(message as { actions: unknown[] }).actions, { kind: 'visit_url', label: 'Next', url: ['https://evil.test/'] }] }],
    } as unknown as FormDefinition;
    expect(redirectIssues(withButton, ALLOWED).map((i) => i.path)).toEqual(['/endings/0/actions/1/url']);

    const redirect = withRedirectEnding(base, ['https://forms.acme.test/']);
    const translated = {
      ...redirect,
      i18n: { ...redirect.i18n, messages: { 'hi-IN': { 'ending:end_redirect:url': { value: ['https://evil.test/'] } } } },
    } as unknown as FormDefinition;
    expect(redirectIssues(translated, ALLOWED).map((i) => i.path)).toEqual(['/i18n/messages/hi-IN/ending:end_redirect:url/value']);
  });

  it('names the problem at the ending, as an error with the code redirect_not_allowed', () => {
    const issues = redirectIssues(withRedirectEnding(publishableDraft('0b2c1f5e-8a1d-4f57-9a43-6f3f6c0d9a11'), ['https://evil.test/']), ALLOWED);
    expect(issues).toEqual([{ severity: 'error', code: 'redirect_not_allowed', path: '/endings/1/url', message: "'evil.test' is not on this form's redirect allowlist" }]);
  });
});
