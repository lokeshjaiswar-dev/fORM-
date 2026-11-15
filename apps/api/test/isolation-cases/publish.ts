import type { IsolationDomain } from './types.ts';

/**
 * Cases for the routes of WP-1.07 that publish and check a form (versions, retirement and ops come with their own
 * routes). Each is an `auth: 'user'` route, so each needs a case here or the suite fails. If a case needs org A rows the
 * core fixture does not have, add a `seed` that returns them by name in `f.extra`.
 *
 * Org B's member names org A's form, which has a draft and a live version: row-level security makes the form not exist
 * for them (404), so the pipeline never runs on org A's draft and no answer can carry its issues.
 */
export const PUBLISH_ISOLATION: IsolationDomain = {
  cases: [
    {
      route: 'POST /v1/forms/:id/publish',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/publish`, body: { expectedDraftRev: 1, label: 'Taken over by org B' } }),
      note: 'Naming org A’s form and its draft revision publishes nothing into either org: org A keeps its one version and its live pointer (the baseline check).',
    },
    {
      route: 'POST /v1/forms/:id/validate',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/validate`, body: {} }),
      note: 'The dry run reads the draft through row-level security, so org A’s draft is not there to be checked, and it writes nothing.',
    },
    {
      route: 'GET /v1/forms/:id/live',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/live` }),
      note: 'Org A’s slug and live version are not readable by org B.',
    },
  ],
};
