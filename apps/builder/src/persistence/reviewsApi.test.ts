import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { FORM, ORG, SUB, decidedJson, detailJson, fakeReviewApi, json, problem, tokenFor, unitJson } from '@/components/review/fakeReviewApi';
import { canReviewIn, createDecider, getReviewDetail, getReviewQueue, isIndeterminate, queuePath, sendDecision, type DecisionRequest } from '@/persistence/reviewsApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DECISION_PATH = `/v1/forms/${FORM}/submissions/${SUB}/review/units/u_id/decisions`;
const HASH = tokenFor('u_id');

const approve = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ org: ORG, formId: FORM, submissionId: SUB, unitId: 'u_id', decision: 'approve', answersHash: HASH, ...over });
const header = (call: { headers: Record<string, string> } | undefined, name: string) => call?.headers[name];

describe('a decision (WP-2.33)', () => {
  it('Approve sends the Idempotency-Key, the answersHash the checker read, the org and the client header, and nothing else', async () => {
    const api = fakeReviewApi({ decide: () => json(200, decidedJson('u_id')) });
    const decided = await createDecider().decide(approve());

    expect(decided).toMatchObject({ unitState: 'approved', submissionStatus: 'pending_review' });
    const [call, ...others] = api.to('POST', /decisions$/);
    expect(others).toHaveLength(0);
    expect(call?.path).toBe(DECISION_PATH);
    expect(call?.body).toEqual({ decision: 'approve', answersHash: HASH });
    expect(header(call, 'idempotency-key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(header(call, 'x-fr-org')).toBe(ORG);
    expect(header(call, 'x-fr-client')).toBe('builder');
  });

  it('never sends a reason with an approve (the API refuses one), and sends the reason of a reject', async () => {
    const api = fakeReviewApi();
    const decider = createDecider();
    await decider.decide(approve({ reasonCode: 'other' }));
    await decider.decide(approve({ decision: 'reject', reasonCode: 'missing_document' }));
    expect(api.to('POST', /decisions$/).map((c) => c.body)).toEqual([
      { decision: 'approve', answersHash: HASH },
      { decision: 'reject', reasonCode: 'missing_document', answersHash: HASH },
    ]);
  });

  it('sends nothing the client could forge: no user, org id, time or id in the body', async () => {
    const api = fakeReviewApi();
    await createDecider().decide(approve());
    expect(Object.keys(api.to('POST', /decisions$/)[0]?.body ?? {}).sort()).toEqual(['answersHash', 'decision']);
  });

  it('a retry after a network error sends the same Idempotency-Key, so a decision that was stored is not made twice', async () => {
    const api = fakeReviewApi({ decide: (n) => (n === 1 ? new TypeError('network down') : json(200, decidedJson('u_id'))) });
    const decider = createDecider();

    await expect(decider.decide(approve())).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(decider.decide(approve())).resolves.toMatchObject({ unitState: 'approved' });

    const keys = api.to('POST', /decisions$/).map((c) => header(c, 'idempotency-key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('a retry after a 5xx reuses the key too, and a key survives several failures', async () => {
    const api = fakeReviewApi({ decide: (n) => (n === 1 ? problem(503, 'UNAVAILABLE') : n === 2 ? new TypeError('network down') : json(200, decidedJson('u_id'))) });
    const decider = createDecider();
    await expect(decider.decide(approve())).rejects.toMatchObject({ status: 503 });
    await expect(decider.decide(approve())).rejects.toBeInstanceOf(ApiUnreachable);
    await decider.decide(approve());
    expect(new Set(api.to('POST', /decisions$/).map((c) => header(c, 'idempotency-key'))).size).toBe(1);
  });

  it('a decision that was answered spends its key: the next click is a new action with a new key', async () => {
    const api = fakeReviewApi();
    const decider = createDecider();
    await decider.decide(approve());
    await decider.decide(approve());
    const [first, second] = api.to('POST', /decisions$/).map((c) => header(c, 'idempotency-key'));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('a refusal is an answer too: the next click after a 409 gets a new key', async () => {
    const api = fakeReviewApi({ decide: (n) => (n === 1 ? problem(409, 'REVIEW_STALE') : json(200, decidedJson('u_id'))) });
    const decider = createDecider();
    await expect(decider.decide(approve())).rejects.toMatchObject({ status: 409, code: 'REVIEW_STALE' });
    await decider.decide(approve({ answersHash: tokenFor('u_id', 2) }));
    const [first, second] = api.to('POST', /decisions$/).map((c) => header(c, 'idempotency-key'));
    expect(second).not.toBe(first);
  });

  it('another request after an unanswered one (other answers, another reason or decision, another unit) never borrows its key', async () => {
    const api = fakeReviewApi({ decide: (n) => (n <= 4 ? new TypeError('network down') : json(200, decidedJson('u_id'))) });
    const decider = createDecider();
    const requests = [approve(), approve({ answersHash: tokenFor('u_id', 2) }), approve({ decision: 'reject', reasonCode: 'incorrect', answersHash: tokenFor('u_id', 2) }), approve({ unitId: 'u_other' })];
    for (const request of requests) await expect(decider.decide(request)).rejects.toBeInstanceOf(ApiUnreachable);
    const keys = api.to('POST', /decisions$/).map((c) => header(c, 'idempotency-key'));
    expect(new Set(keys).size).toBe(4);
  });

  it('percent-encodes the ids it puts in the path', async () => {
    const api = fakeReviewApi();
    await sendDecision(approve({ unitId: 'a/b c' }), 'key-1').catch(() => undefined);
    expect(api.calls[0]?.path).toBe(`/v1/forms/${FORM}/submissions/${SUB}/review/units/a%2Fb%20c/decisions`);
  });

  it('reads a refusal as an ApiProblem with its code, and an answer it cannot read as an unreachable API', async () => {
    fakeReviewApi({ decide: (n) => (n === 1 ? problem(403, 'FOUR_EYES_VIOLATION') : json(200, { nope: true })) });
    await expect(sendDecision(approve(), 'k1')).rejects.toMatchObject({ status: 403, code: 'FOUR_EYES_VIOLATION' });
    await expect(sendDecision(approve(), 'k2')).rejects.toBeInstanceOf(ApiUnreachable);
  });
});

describe('isIndeterminate', () => {
  it('is true for an unreachable API and any 5xx, and false for every answer the API gave on purpose', () => {
    expect(isIndeterminate(new ApiUnreachable())).toBe(true);
    for (const status of [500, 502, 503, 504]) expect(isIndeterminate(new ApiProblem(status, 'X', ''))).toBe(true);
    for (const status of [400, 403, 404, 409, 422, 429]) expect(isIndeterminate(new ApiProblem(status, 'X', ''))).toBe(false);
    expect(isIndeterminate(new Error('boom'))).toBe(false);
  });
});

describe('the queue and the review detail', () => {
  it('asks for the queue with only the filters that are set, and a cursor only for a later page', () => {
    expect(queuePath({})).toBe('/v1/reviews/queue?limit=50');
    expect(queuePath({ formId: FORM, unitId: 'u_id', age: '7d' }, 'c1')).toBe('/v1/reviews/queue?limit=50&formId=f1&unitId=u_id&age=7d&cursor=c1');
    expect(queuePath({ formId: '', unitId: undefined, age: undefined }, null)).toBe('/v1/reviews/queue?limit=50');
  });

  it('reads a page of the queue, and sends the org', async () => {
    const item = { submissionId: SUB, formId: FORM, formTitle: 'Loan application', unitId: 'u_id', unitName: 'Identity check', round: 1, order: 1, required: true, receivedAt: '2026-11-15T10:00:00.000Z', ageSeconds: 3600 };
    const api = fakeReviewApi({ queue: () => ({ items: [item], nextCursor: 'next' }) });
    expect(await getReviewQueue(ORG, { formId: FORM })).toEqual({ items: [item], nextCursor: 'next' });
    expect(api.calls[0]?.path).toBe('/v1/reviews/queue?limit=50&formId=f1');
    expect(header(api.calls[0], 'x-fr-org')).toBe(ORG);
  });

  it('reads the review detail of a response, keeping only what the screens show', async () => {
    fakeReviewApi({ detail: () => detailJson({}, [unitJson('u_id', 'Identity check', { groupId: 'g1', rev: 4 })]) });
    const detail = await getReviewDetail(ORG, FORM, SUB);
    expect(detail.submission.status).toBe('pending_review');
    expect(detail.units).toEqual([
      { unitId: 'u_id', name: 'Identity check', state: 'pending', round: 1, required: true, order: 1, groupName: 'Finance', yours: true, canDecide: true, blocked: false, answersHash: HASH },
    ]);
    expect(detail.fields.map((f) => f.value)).toEqual(['Ravi Kumar']);
  });

  it('turns a refusal of the queue into an ApiProblem and a body it cannot read into an unreachable API', async () => {
    fakeReviewApi({ queue: (n) => (n === 1 ? problem(403, 'FORBIDDEN') : { items: 'nope' }) });
    await expect(getReviewQueue(ORG, {})).rejects.toMatchObject({ status: 403 });
    await expect(getReviewQueue(ORG, {})).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('knows whether the role grants submissions.review from GET /v1/org', async () => {
    fakeReviewApi({ permissions: ['forms.read', 'submissions.review'] });
    expect(await canReviewIn(ORG)).toBe(true);
    fakeReviewApi({ permissions: ['forms.read', 'submissions.read'] });
    expect(await canReviewIn(ORG)).toBe(false);
  });
});
