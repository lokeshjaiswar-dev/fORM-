import { expect } from 'vitest';
import type { Fixture, IsolationCase, IsolationDomain, Res, SeedEnv } from './types.ts';

/**
 * Cases for the server-side lookup routes: org API credentials (`/v1/org/api-credentials`) and the author's test route
 * (`POST /v1/forms/:formId/remote/test`). Each is an `auth: 'user'` route, so each needs a case here or the suite fails.
 *
 * Org A's credential is made through the API as org A's owner, so the cases aim a real id at org B's member. Its name and its
 * secret are in `f.secrets`, so the suite also scans every answer for them (the secret is never returned, to anyone).
 */

const bodyOf = (res: Res) => res.json<Record<string, unknown>>();

export const CREDENTIAL_NAME = 'Org A hr api 7c1e';
export const CREDENTIAL_SECRET = 'iso-a-api-token-7c1e-5d90aa11';

async function seed(env: SeedEnv, f: Fixture): Promise<Record<string, string>> {
  const made = await env.as(f.a.ownerId, f.a.orgId, 'POST', '/v1/org/api-credentials', { name: CREDENTIAL_NAME, host: 'hr.iso-a.test', auth: { type: 'bearer', token: CREDENTIAL_SECRET } });
  if (made.statusCode !== 201) throw new Error(`seed: expected 201 for an API credential, got ${made.statusCode} ${made.body}`);
  return { credentialId: made.json<{ id: string }>().id, credentialName: CREDENTIAL_NAME, credentialSecret: CREDENTIAL_SECRET };
}

const cases: IsolationCase[] = [
  {
    route: 'GET /v1/org/api-credentials',
    call: () => ({ url: '/v1/org/api-credentials' }),
    own: {
      status: 200,
      check: (res, f) => {
        const items = bodyOf(res).items as Array<{ id: string }>;
        expect(items.map((c) => c.id)).not.toContain(f.extra.credentialId);
        expect(items).toEqual([]);
      },
    },
    note: 'The route takes no id of org A’s, so org B’s member gets their own org’s list, which is empty: org A’s credential, its name and its host are not in it.',
  },
  {
    route: 'POST /v1/org/api-credentials',
    call: () => ({ url: '/v1/org/api-credentials', body: { name: 'Org B api', host: 'api.iso-b.test', auth: { type: 'bearer', token: 'iso-b-token-0000000000' } } }),
    own: { status: 201, check: (res) => expect(bodyOf(res)).toMatchObject({ name: 'Org B api', host: 'api.iso-b.test' }) },
    note: 'The route takes no org: the credential is org B’s whatever the body says; the baseline check proves org A still has its one credential.',
  },
  {
    route: 'PUT /v1/org/api-credentials/:id',
    call: (f) => ({ url: `/v1/org/api-credentials/${f.extra.credentialId}`, body: { name: 'Org B was here', host: 'attacker.iso-b.test', auth: { type: 'bearer', token: 'attacker-token-000000000' } } }),
    note: 'Would rename org A’s credential, re-bind it to org B’s host and rotate its secret; the baseline check proves all three untouched.',
  },
  {
    route: 'DELETE /v1/org/api-credentials/:id',
    call: (f) => ({ url: `/v1/org/api-credentials/${f.extra.credentialId}` }),
  },
  {
    route: 'POST /v1/forms/:formId/remote/test',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/remote/test`, body: { request: { url: 'https://hr.iso-a.test/people', method: 'GET', credentialRef: { secretId: f.extra.credentialId } }, q: 'x' } }),
    note: 'Would call an API through org A’s credential as org A’s form: the form is looked up (under RLS) before the throttle or any call is made, so org B’s member gets 404.',
  },
];

export const REMOTE_ISOLATION: IsolationDomain = { cases, seed };
