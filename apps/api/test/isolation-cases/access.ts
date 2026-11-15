import { expect } from 'vitest';
import type { IsolationCase, IsolationDomain } from './types.ts';

/**
 * Cases for the routes WP-1.07 adds for form access (open and close times, limit, allowlists, password, address). Each is
 * an `auth: 'user'` route, so each needs a case here or the suite fails. The respondent's unlock route has no session
 * (it is public on purpose) and is covered by its own integration test, `unlock.int.test.ts`, not by this suite.
 *
 * Org B's member names org A's form. Every route looks the form up first, under row-level security, so org A's form is
 * as absent as one that never existed: 404, and nothing of org A's is written (the suite's baseline hash of every
 * `org_id` table, `form_access` and `form_slugs` among them, would change).
 */

const SETTINGS = { enabled: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };

const cases: IsolationCase[] = [
  {
    route: 'GET /v1/forms/:id/access',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/access` }),
    note: 'Org A’s own owner gets 200 for the same request (the suite checks it): the defaults, for a form nobody configured.',
  },
  {
    route: 'PUT /v1/forms/:id/access',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/access`, body: SETTINGS, headers: { 'if-match': '0' } }),
    note: 'A valid body with the revision a first save sends: it would switch org A’s form off if the form were visible, and it would insert a form_access row for org A.',
  },
  {
    route: 'PUT /v1/forms/:id/access/password',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/access/password`, body: { password: 'org b was here, locked you out' } }),
    note: 'Would put a password on org A’s form: the form is looked up before the password is hashed.',
  },
  {
    route: 'DELETE /v1/forms/:id/access/password',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/access/password` }),
  },
  {
    route: 'GET /v1/forms/:id/slug',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/slug` }),
    note: 'Org A’s form is published, so its owner gets 200 with the address; org B must not learn it.',
  },
  {
    route: 'PUT /v1/forms/:id/slug',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/slug`, body: { slug: 'org-b-takes-over' } }),
    own: {
      status: 404,
      check: (res) => expect(res.body).not.toContain('org-b-takes-over'),
    },
    note: 'Would re-point org A’s public address; the baseline covers forms and form_slugs.',
  },
];

export const ACCESS_ISOLATION: IsolationDomain = { cases };
