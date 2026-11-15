import { expect } from 'vitest';
import type { Fixture, IsolationCase, IsolationDomain, Res, SeedEnv } from './types.ts';

/**
 * Cases for the approvals routes (WP-2.33): review groups, review settings, the review queue and decisions. Each is an
 * `auth: 'user'` route, so each needs a case here or the suite fails. If a case needs org A rows the core fixture does
 * not have (a group, a held response), add a `seed` that returns them by name in `f.extra`.
 *
 * The setup task's cases: the group routes and a form's review settings. Org A's group is made by the seed through the
 * API as org A's owner, with its owner as the one member, so the cases aim real ids at org B's member. Every body is
 * valid for its route, so a refusal can only be the group or the form not being visible to org B.
 *
 * The cases of the review queue and the decisions are appended by the review queue task, after these.
 */

const bodyOf = (res: Res) => res.json<Record<string, unknown>>();

/** Org A's group, which the cases below name. Its name is in `extra` too, so the suite also looks for it in every answer. */
export const REVIEW_GROUP_NAME = 'Org A checkers 5c1e';

async function seed(env: SeedEnv, f: Fixture): Promise<Record<string, string>> {
  const created = await env.as(f.a.ownerId, f.a.orgId, 'POST', '/v1/org/review-groups', { name: REVIEW_GROUP_NAME });
  if (created.statusCode !== 201) throw new Error(`seed: expected 201 for a review group, got ${created.statusCode} ${created.body}`);
  const { id } = created.json<{ id: string }>();
  const added = await env.as(f.a.ownerId, f.a.orgId, 'PUT', `/v1/org/review-groups/${id}/members/${f.a.ownerId}`);
  if (added.statusCode !== 200) throw new Error(`seed: expected 200 for a group member, got ${added.statusCode} ${added.body}`);
  return { reviewGroupId: id, reviewGroupName: REVIEW_GROUP_NAME };
}

const cases: IsolationCase[] = [
  {
    route: 'GET /v1/org/review-groups',
    call: () => ({ url: '/v1/org/review-groups?includeArchived=true' }),
    own: {
      status: 200,
      check: (res, f) => {
        const items = bodyOf(res).items as Array<{ id: string }>;
        expect(items.map((g) => g.id)).not.toContain(f.extra.reviewGroupId);
        expect(items).toEqual([]);
      },
    },
    note: 'The route takes no id of org A’s, so org B’s member gets their own org’s list, which is empty: org A’s group, its name and its members are not in it (the suite also scans the answer for them).',
  },
  {
    route: 'POST /v1/org/review-groups',
    call: () => ({ url: '/v1/org/review-groups', body: { name: 'Org B checkers' } }),
    own: { status: 201, check: (res) => expect(bodyOf(res)).toMatchObject({ name: 'Org B checkers', archivedAt: null, members: [] }) },
    note: 'The route takes no org: the group is org B’s, whatever the body says. The baseline check proves org A has the one group the seed made.',
  },
  {
    route: 'PATCH /v1/org/review-groups/:id',
    call: (f) => ({ url: `/v1/org/review-groups/${f.extra.reviewGroupId}`, body: { name: 'Renamed by org B', archived: true } }),
    note: 'Would rename and archive org A’s group; the baseline check proves it is untouched.',
  },
  {
    route: 'PUT /v1/org/review-groups/:id/members/:userId',
    call: (f) => ({ url: `/v1/org/review-groups/${f.extra.reviewGroupId}/members/${f.a.memberId}` }),
    note: 'Org B’s owner has members.manage, so only the group not being visible stops them adding org A’s other member to it.',
  },
  {
    route: 'DELETE /v1/org/review-groups/:id/members/:userId',
    call: (f) => ({ url: `/v1/org/review-groups/${f.extra.reviewGroupId}/members/${f.a.ownerId}` }),
    note: 'Would empty org A’s group of its one checker; the baseline check proves the member is still there.',
  },
  {
    route: 'GET /v1/forms/:id/review',
    call: (f) => ({ url: `/v1/forms/${f.a.formId}/review` }),
    note: 'Org A’s own owner gets 200 for the same request (the suite checks it): the defaults, for a form nobody set up. Org B must not learn that the form exists.',
  },
  {
    route: 'PUT /v1/forms/:id/review',
    call: (f) => ({
      url: `/v1/forms/${f.a.formId}/review`,
      body: { enabled: true, distinctCheckers: true, units: [] },
      headers: { 'if-match': '0' },
    }),
    note: 'A valid body with the revision a first save sends: it would switch review on for org A’s form and insert a form_review_settings row, if the form were visible.',
  },
];

export const REVIEWS_ISOLATION: IsolationDomain = { cases, seed };
