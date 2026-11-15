import { expect } from 'vitest';
import { draftWith } from '../publishable-draft.ts';
import { v1Form } from '../v1-form.ts';
import type { Fixture, IsolationDomain, Res } from './types.ts';

/**
 * Cases for the routes WP-1.06 adds (forms list actions, trash and restore, favourite, clone, import) and for the ones it
 * rewrote (the list, create, the draft routes, merge), which moved here from core.ts. Each is an `auth: 'user'` route, so
 * each needs a case here or the suite fails. If a case needs org A rows the core fixture does not have, add a `seed` that
 * returns them by name in `f.extra`.
 *
 * Every body below is valid for its route (a real definition, a real title), so a refusal can only be the row not being
 * visible to org B: a 422 for a bad body would otherwise hide a missing tenant check behind it.
 */

const itemsOf = (res: Res) => (res.json<{ items?: Array<Record<string, unknown>> }>().items ?? []) as Array<Record<string, unknown>>;

export const FORMS_ISOLATION: IsolationDomain = {
  cases: [
    {
      route: 'GET /v1/forms',
      call: () => ({ url: '/v1/forms?limit=200' }),
      own: {
        status: 200,
        check: (res, f) => {
          const ids = itemsOf(res).map((i) => i.id);
          expect(ids).toContain(f.b.formId);
          expect(ids).not.toContain(f.a.formId);
          expect(ids).not.toContain(f.a.secondFormId);
        },
      },
      note: 'The query names no org; the list is whatever row-level security lets the caller see.',
    },
    {
      route: 'POST /v1/forms',
      call: (f: Fixture) => ({
        url: '/v1/forms',
        body: { from: 'importV1', id: f.a.formId, v1: v1Form({ title: 'Taken over by org B', password: 'org-b-secret-1', closed: true }) },
      }),
      own: { status: 200 },
      note: 'The import variant, because it writes the most: a client-chosen id that is org A’s form inserts nothing, and above all writes no draft, no access settings and no password hash there. The baseline check proves org A’s forms, drafts and form_access are untouched.',
    },
    { route: 'GET /v1/forms/:id', call: (f) => ({ url: `/v1/forms/${f.a.formId}` }) },
    { route: 'PATCH /v1/forms/:id', call: (f) => ({ url: `/v1/forms/${f.a.formId}`, body: { title: 'Renamed by org B' } }) },
    { route: 'PUT /v1/forms/:id/favourite', call: (f) => ({ url: `/v1/forms/${f.a.formId}/favourite` }), note: 'Without the visibility check this would be a foreign-key error that proves the form exists in another org.' },
    { route: 'DELETE /v1/forms/:id/favourite', call: (f) => ({ url: `/v1/forms/${f.a.formId}/favourite` }) },
    { route: 'POST /v1/forms/:id/clone', call: (f) => ({ url: `/v1/forms/${f.a.formId}/clone` }), note: 'A copy of org A’s form in org B would be a read of its whole definition.' },
    { route: 'POST /v1/forms/:id/archive', call: (f) => ({ url: `/v1/forms/${f.a.formId}/archive` }) },
    { route: 'POST /v1/forms/:id/trash', call: (f) => ({ url: `/v1/forms/${f.a.formId}/trash` }) },
    { route: 'POST /v1/forms/:id/restore', call: (f) => ({ url: `/v1/forms/${f.a.formId}/restore` }) },
    { route: 'GET /v1/forms/:id/draft', call: (f) => ({ url: `/v1/forms/${f.a.formId}/draft` }) },
    {
      route: 'PUT /v1/forms/:id/draft',
      call: (f) => ({
        url: `/v1/forms/${f.a.formId}/draft`,
        body: { draft: draftWith(f.a.formId, [], 'Overwritten by org B') },
        headers: { 'if-match': '1' },
      }),
      note: 'A valid definition for org A’s own form id, with a revision that exists: only row-level security stands between org B and an overwrite.',
    },
    { route: 'POST /v1/forms/merge', call: (f) => ({ url: '/v1/forms/merge', body: { formIds: [f.a.formId, f.a.secondFormId], title: 'Stolen' } }) },
  ],
};
