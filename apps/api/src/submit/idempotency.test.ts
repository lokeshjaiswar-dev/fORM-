import { describe, expect, it } from 'vitest';
import { hashRequest } from './idempotency.ts';

const VERSION = '018f0000-0000-7000-8000-000000000001';

describe('hashRequest', () => {
  const request = { formVersionId: VERSION, locale: 'en-IN', answers: { a: { type: 'short_text', value: 'x' }, b: { type: 'number', value: '3' } }, client: { startedAt: '2026-11-15T09:00:00Z' } };

  it('is 32 bytes and the same for the same request', () => {
    expect(hashRequest(request)).toHaveLength(32);
    expect(hashRequest(request).equals(hashRequest(structuredClone(request)))).toBe(true);
  });

  it('does not depend on the order a client writes its keys in', () => {
    const reordered = { client: request.client, answers: { b: request.answers.b, a: request.answers.a }, locale: 'en-IN', formVersionId: VERSION };
    expect(hashRequest(reordered).equals(hashRequest(request))).toBe(true);
  });

  it('differs when an answer, the version, the language or the page view differs', () => {
    const base = hashRequest(request);
    const same = (patch: Partial<typeof request>) => hashRequest({ ...request, ...patch }).equals(base);
    expect(same({ answers: { ...request.answers, a: { type: 'short_text', value: 'y' } } })).toBe(false);
    expect(same({ formVersionId: '018f0000-0000-7000-8000-000000000002' })).toBe(false);
    expect(same({ locale: 'hi' })).toBe(false);
    expect(same({ client: { startedAt: '2026-11-15T09:00:01Z' } })).toBe(false);
  });

  it('treats a missing page view as null, so a body with and without one are different requests', () => {
    const { client: _client, ...without } = request;
    expect(hashRequest({ ...without, client: undefined }).equals(hashRequest({ ...without, client: null }))).toBe(true);
    expect(hashRequest({ ...without, client: undefined }).equals(hashRequest(request))).toBe(false);
  });
});
