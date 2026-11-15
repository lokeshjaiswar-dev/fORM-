import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { draftWith, fieldBlock } from '../publishable-draft.ts';
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
 * The review queue task's: the queue, the review detail of a response and the decision of one of its units. Org A's seed
 * also makes a form with two review units, assigned to that group, and a respondent's answer to it, which the review
 * puts on hold (`pending_review`). The cases aim at that response, its unit and its real answers hash (the token org A's
 * checker reads in the review detail), so a refusal can only be the response not being visible to org B.
 */

const bodyOf = (res: Res) => res.json<Record<string, unknown>>();

/** Org A's group, which the cases below name. Its name is in `extra` too, so the suite also looks for it in every answer. */
export const REVIEW_GROUP_NAME = 'Org A checkers 5c1e';

/** What the seed's reviewed form and response say, so the suite also looks for them in every answer org B gets. */
const REVIEW_FORM_TITLE = 'Review intake 3b7e';
const REVIEW_UNIT_A = 'unit_a_5e91';
const REVIEW_UNIT_A_NAME = 'Applicant details 3b7e';
const REVIEW_UNIT_B = 'unit_b_5e91';
const REVIEW_ANSWER = 'Review answer 8d41';

async function expectStatus<T>(res: Res, status: number, what: string): Promise<T> {
  if (res.statusCode !== status) throw new Error(`seed: expected ${status} for ${what}, got ${res.statusCode} ${res.body}`);
  return res.json<T>();
}

async function seed(env: SeedEnv, f: Fixture): Promise<Record<string, string>> {
  const created = await env.as(f.a.ownerId, f.a.orgId, 'POST', '/v1/org/review-groups', { name: REVIEW_GROUP_NAME });
  if (created.statusCode !== 201) throw new Error(`seed: expected 201 for a review group, got ${created.statusCode} ${created.body}`);
  const { id } = created.json<{ id: string }>();
  const added = await env.as(f.a.ownerId, f.a.orgId, 'PUT', `/v1/org/review-groups/${id}/members/${f.a.ownerId}`);
  if (added.statusCode !== 200) throw new Error(`seed: expected 200 for a group member, got ${added.statusCode} ${added.body}`);

  // A form with a review unit per page, both assigned to that group, and a respondent's answer, which the review holds.
  const form = await expectStatus<{ id: string }>(await env.as(f.a.ownerId, f.a.orgId, 'POST', '/v1/forms', { title: REVIEW_FORM_TITLE }), 200, 'a reviewed form');
  const base = draftWith(form.id, [fieldBlock('name', 'short_text'), fieldBlock('note', 'short_text')], REVIEW_FORM_TITLE);
  const draft = {
    ...base,
    pages: [
      { ...base.pages[0]!, children: ['name'] },
      { id: 'page_2', children: ['note'] },
    ],
    review: {
      units: [
        { id: REVIEW_UNIT_A, name: REVIEW_UNIT_A_NAME, target: { kind: 'page', pageId: 'page_1' } },
        { id: REVIEW_UNIT_B, name: 'Notes 3b7e', target: { kind: 'page', pageId: 'page_2' } },
      ],
    },
  };
  const saved = await env.app.inject({
    method: 'PUT',
    url: `/v1/forms/${form.id}/draft`,
    headers: { 'x-fr-dev-user': f.a.ownerId, 'x-fr-org': f.a.orgId, 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin', 'if-match': '0' },
    payload: { draft } as Record<string, unknown>,
  });
  await expectStatus(saved, 200, 'the reviewed form’s draft');
  const settings = await env.app.inject({
    method: 'PUT',
    url: `/v1/forms/${form.id}/review`,
    headers: { 'x-fr-dev-user': f.a.ownerId, 'x-fr-org': f.a.orgId, 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin', 'if-match': '0' },
    payload: {
      enabled: true,
      distinctCheckers: false,
      units: [
        { unitId: REVIEW_UNIT_A, groupId: id, order: 1, required: true, visibility: 'own_unit' },
        { unitId: REVIEW_UNIT_B, groupId: id, order: 2, required: true, visibility: 'own_unit' },
      ],
    },
  });
  await expectStatus(settings, 200, 'the review settings');
  const live = await expectStatus<{ slug: string; versionId: string }>(await env.as(f.a.ownerId, f.a.orgId, 'POST', `/v1/forms/${form.id}/publish`, {}), 200, 'publishing the reviewed form');
  const submitted = await expectStatus<{ submissionId: string; held?: string }>(
    await env.app.inject({
      method: 'POST',
      url: `/v1/p/${live.slug}/submissions`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { formVersionId: live.versionId, answers: { name: { type: 'short_text', value: REVIEW_ANSWER }, note: { type: 'short_text', value: 'Private note 8d41' } }, fields: [], locale: 'en-IN' },
    }),
    200,
    'a response to the reviewed form',
  );
  if (submitted.held !== 'pending_review') throw new Error(`seed: the response was not held for review (${JSON.stringify(submitted)})`);
  // What a checker of org A holds: the unit's answers hash as the review detail gives it (a keyed token, not the digest the row holds).
  const read = await expectStatus<{ units: Array<{ unitId: string; answersHash: string | null }> }>(
    await env.as(f.a.ownerId, f.a.orgId, 'GET', `/v1/forms/${form.id}/submissions/${submitted.submissionId}/review`),
    200,
    'the review detail of the held response',
  );
  const token = read.units.find((u) => u.unitId === REVIEW_UNIT_A)?.answersHash;
  if (!token) throw new Error('seed: the review detail gave org A’s owner no answers hash for the unit');
  return {
    reviewGroupId: id,
    reviewGroupName: REVIEW_GROUP_NAME,
    reviewFormId: form.id,
    reviewSubmissionId: submitted.submissionId,
    reviewUnitId: REVIEW_UNIT_A,
    reviewUnitHash: token,
    reviewFormTitle: REVIEW_FORM_TITLE,
    reviewUnitName: REVIEW_UNIT_A_NAME,
    reviewAnswer: REVIEW_ANSWER,
  };
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
  {
    route: 'GET /v1/reviews/queue',
    call: () => ({ url: '/v1/reviews/queue' }),
    own: {
      status: 200,
      check: (res, f) => {
        const body = bodyOf(res);
        expect(body).toEqual({ items: [], nextCursor: null });
        expect(JSON.stringify(body)).not.toContain(f.extra.reviewSubmissionId);
      },
    },
    note: 'The route takes no id of org A’s, so org B’s checker gets their own org’s queue, which is empty: org A has a held response whose unit waits for its group, and none of it (not the form’s title, the unit’s name or the response’s id) is in the answer.',
  },
  {
    route: 'GET /v1/forms/:formId/submissions/:id/review',
    call: (f) => ({ url: `/v1/forms/${f.extra.reviewFormId}/submissions/${f.extra.reviewSubmissionId}/review` }),
    note: 'Org A’s own owner gets 200 for the same request (the suite checks it): the held response with its units and answers. Org B must learn neither that it exists nor any answer, and its read leaves no `submission.viewed` record on org A’s chain.',
  },
  {
    route: 'POST /v1/forms/:formId/submissions/:id/review/units/:unitId/decisions',
    call: (f) => ({
      url: `/v1/forms/${f.extra.reviewFormId}/submissions/${f.extra.reviewSubmissionId}/review/units/${f.extra.reviewUnitId}/decisions`,
      body: { decision: 'approve', answersHash: f.extra.reviewUnitHash },
      headers: { 'idempotency-key': 'isolation-decision-1' },
    }),
    note: 'The real unit with its real answers hash, from a checker of org B (an owner, who holds submissions.review, though without two-factor sign-in): the response is looked up first, so it answers 404 and not 403 MFA_REQUIRED, and the baseline check proves the unit is still pending, with no decision row.',
  },
];

export const REVIEWS_ISOLATION: IsolationDomain = { cases, seed };
