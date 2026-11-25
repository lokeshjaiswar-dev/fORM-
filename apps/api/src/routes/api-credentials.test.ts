import { describe, expect, it } from 'vitest';
import { ProblemError } from '../errors.ts';
import { normaliseHost, planCredentialUpdate } from './api-credentials.ts';

const stored = { name: 'Payroll', type: 'bearer', host: 'api.payroll.example', last4: 'abcd' };
const bearer = { type: 'bearer' as const, token: 'new-token-0123456789' };

describe('PUT /v1/org/api-credentials/:id plan (review should-fix: host re-bind without the secret)', () => {
  it('refuses a new host unless the secret is sent again', () => {
    expect(() => planCredentialUpdate(stored, { host: 'evil.example' })).toThrow(ProblemError);
    expect(() => planCredentialUpdate(stored, { host: 'evil.example', name: 'x' })).toThrow(/secret again/);
  });

  it('takes a new host with a new secret, audited as its own change kind', () => {
    const plan = planCredentialUpdate(stored, { host: 'evil.example', auth: bearer });
    expect(plan.meta).toMatchObject({ host: 'evil.example', type: 'bearer', last4: '6789' });
    expect(plan.change).toBe('rebound');
    expect(plan.changedKeys).toEqual(['host', 'auth']);
  });

  it('the same host again (normalised) is no re-bind and needs no secret', () => {
    const plan = planCredentialUpdate(stored, { host: normaliseHost('API.Payroll.example:443')!, name: 'Renamed' });
    expect(plan.change).toBe('updated');
    expect(plan.changedKeys).toEqual(['name']);
    expect(plan.meta).toMatchObject({ name: 'Renamed', host: 'api.payroll.example', last4: 'abcd' });
  });

  it('a rotation keeps the host', () => {
    const plan = planCredentialUpdate(stored, { auth: bearer });
    expect(plan).toMatchObject({ change: 'rotated', changedKeys: ['auth'], meta: { host: 'api.payroll.example' } });
  });
});
