import type { IsolationDomain } from './types.ts';

/**
 * Cases for the routes WP-1.12 and WP-1.15 add or rewrite for submissions (the responses grid, one response, the inbox
 * flags, bulk actions); the rewritten list and detail moved here from `core.ts`. The reveal, export and file download
 * routes add theirs when they land (the file download is still in `core.ts`). Each is an `auth: 'user'` route, so each
 * needs a case here or the suite fails. If a case needs org A rows the core fixture does not have, add a `seed` that
 * returns them by name in `f.extra`.
 *
 * Every body below is valid for its route, so a refusal can only be the form or response not being visible to org B: a
 * 422 for a bad body would otherwise hide a missing tenant check behind it.
 */

export const SUBMISSIONS_ISOLATION: IsolationDomain = {
  cases: [
    {
      route: 'GET /v1/forms/:formId/submissions',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/submissions` }),
      note: 'A page of org A’s form is a read of its responses and a record on the audit chain: org B must get neither, not an empty inbox that proves the form exists.',
    },
    {
      route: 'GET /v1/forms/:formId/submissions/:id',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/submissions/${f.a.submissionId}` }),
    },
    {
      route: 'PATCH /v1/forms/:formId/submissions/:id',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/submissions/${f.a.submissionId}`, body: { read: true, starred: true } }),
      note: 'The baseline check proves org A’s response is not marked read or starred.',
    },
    {
      route: 'POST /v1/forms/:formId/submissions/bulk',
      call: (f) => ({ url: `/v1/forms/${f.a.formId}/submissions/bulk`, body: { ids: [f.a.submissionId], action: 'delete' } }),
      note: 'Delete forever, the action that does the most: org B’s owner has the permission for it, so only the form not being visible stops it, and org A’s response, search document and file must all still be there afterwards (the baseline check).',
    },
  ],
};
