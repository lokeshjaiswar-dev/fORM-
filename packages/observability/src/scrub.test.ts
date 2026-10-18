import { describe, expect, it } from 'vitest';
import { scrubPath, scrubQuery, scrubUrl } from './scrub.ts';

describe('scrubUrl', () => {
  it('drops query values except allowlisted names', () => {
    expect(scrubUrl('/f/kyc?name=Asha&email=a%40b.in&lang=hi&embed=1&utm_source=mail&utm_campaign=x')).toBe(
      '/f/kyc?lang=hi&embed=1&utm_source&utm_campaign',
    );
  });

  it('keeps an allowlisted name but not an unsafe value', () => {
    expect(scrubUrl('/f/kyc?lang=%3Cscript%3E&embed=' + 'x'.repeat(40))).toBe('/f/kyc?lang&embed');
  });

  it('removes the question mark when nothing survives', () => {
    expect(scrubUrl('/v1/forms?q=secret')).toBe('/v1/forms');
    expect(scrubUrl('/v1/forms?')).toBe('/v1/forms');
  });

  it('replaces secret path segments', () => {
    expect(scrubUrl('/s/abcDEF123?x=1')).toBe('/s/:token');
    expect(scrubUrl('/v1/invites/tok_123/accept')).toBe('/v1/invites/:token/accept');
    expect(scrubUrl('/f/kyc/drafts/resume-abc')).toBe('/f/kyc/drafts/:resumeToken');
    expect(scrubPath('/f/kyc/session')).toBe('/f/kyc/session');
  });

  it('handles absolute URLs, credentials and fragments', () => {
    expect(scrubUrl('https://user:pw@forms.example.in/s/tok?phone=98#frag')).toBe('https://forms.example.in/s/:token');
    expect(scrubUrl('http://api.local:8080/v1/forms?lang=en')).toBe('http://api.local:8080/v1/forms?lang=en');
  });

  it('ignores undecodable parameters', () => {
    expect(scrubQuery('%E0%A4%A=1&lang=en&utm_%ZZ=1')).toBe('lang=en');
    expect(scrubQuery('?utm_medium=x&&utm_bad-name=y')).toBe('utm_medium');
  });
});
