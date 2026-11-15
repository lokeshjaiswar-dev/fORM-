import { vi } from 'vitest';
import type { Me } from '@/auth/client';

/*
 * The checker's API as the review screens' tests need it (WP-2.33): `fetch` is replaced by a fake that answers the shapes of
 * apps/api/src/modules/reviews (the queue, a held response for review, the decision of a unit) and `GET /v1/org`. Every
 * answer is built fresh, because a Response body can be read once. A test says what each call answers and reads `calls`.
 */

export const ORG = 'o1';
export const FORM = 'f1';
export const SUB = '0196f0a0-0000-7000-8000-0000000000e1';

export const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: true },
  session: null,
  orgs: [{ id: ORG, slug: 'acme', name: 'Acme', role: 'editor' }],
  activeOrgId: ORG,
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });
export const problem = (status: number, code: string, detail = 'server wording, never shown') => json(status, { type: 'about:blank', title: code, status, code, detail });

/** A token of 64 hex digits for a unit's answers, as the API's keyed token looks (a test compares them, never computes one). `version` stands for the answers. */
export const tokenFor = (unitId: string, version = 1): string =>
  [...`${unitId}:${version}`].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64);

/** A unit as `reviewUnitView` has it: a pending, required unit of the member's own group that they may decide. */
export function unitJson(unitId: string, name: string, over: Record<string, unknown> = {}) {
  return {
    unitId,
    name,
    state: 'pending',
    round: 1,
    required: true,
    order: 1,
    groupId: '01970000-0000-7000-8000-0000000000a1',
    groupName: 'Finance',
    visibility: 'own_unit',
    yours: true,
    canDecide: true,
    blocked: false,
    answersHash: tokenFor(unitId),
    rev: 1,
    ...over,
  };
}

/** The review detail as `reviewDetailResponse` has it. */
export function detailJson(over: Record<string, unknown> = {}, units: unknown[] = [unitJson('u_id', 'Identity check')]) {
  return {
    submission: { id: SUB, formId: FORM, formTitle: 'Loan application', receivedAt: '2026-11-15T10:00:00.000Z', status: 'pending_review', versionId: '0196f0a0-0000-7000-8000-0000000000f1', versionNumber: 2, locale: 'en-IN' },
    redacted: false,
    units,
    decisions: [],
    fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: 'Ravi Kumar', masked: false }],
    answers: {},
    files: [],
    ...over,
  };
}

/** What a decision answers (`decisionResponse`). */
export const decidedJson = (unitId: string, over: Record<string, unknown> = {}) => ({
  decisionId: '0196f0a0-0000-7000-8000-0000000000d1',
  unitId,
  decision: 'approve',
  reasonCode: null,
  round: 1,
  decidedAt: '2026-11-16T09:00:00.000Z',
  unitState: 'approved',
  submissionStatus: 'pending_review',
  ...over,
});

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export interface FakeReviewApiOptions {
  /** The review detail for the n-th read (1 for the first). A Response is sent as it is, an Error is a network failure, a promise is waited for. */
  detail?: (n: number) => unknown | Response | Error;
  /** The answer to the n-th decision. */
  decide?: (n: number, call: Call) => Response | Error;
  /** What `GET /v1/org` grants. */
  permissions?: string[];
  /** The answer to the n-th read of the queue, given its call. */
  queue?: (n: number, call: Call) => unknown | Response | Error;
  /** Every other call (the responses grid, one response, its flags): what it answers, or undefined for a 404. */
  other?: (call: Call) => unknown | Response | Error | undefined;
}

export interface FakeReviewApi {
  calls: Call[];
  /** The calls made with `method` to a path that matches `pattern`. */
  to: (method: string, pattern: RegExp) => Call[];
}

const answer = (value: unknown): Promise<Response> => {
  if (value instanceof Promise) return value.then(answer);
  if (value instanceof Error) return Promise.reject(value);
  return Promise.resolve(value instanceof Response ? value : json(200, value));
};

/** Replaces `fetch` with the fake. Restore it with `vi.unstubAllGlobals()` after each test. */
export function fakeReviewApi(o: FakeReviewApiOptions = {}): FakeReviewApi {
  const calls: Call[] = [];
  let reads = 0;
  let decisions = 0;
  let queueReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const call: Call = { method, path: url, headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
      calls.push(call);
      const path = url.split('?')[0] ?? url;
      if (method === 'GET' && path === '/v1/org') return Promise.resolve(json(200, { org: { id: ORG }, role: 'editor', permissions: o.permissions ?? ['forms.read', 'submissions.read', 'submissions.review'] }));
      if (method === 'GET' && path === '/v1/reviews/queue') {
        queueReads += 1;
        return answer(o.queue ? o.queue(queueReads, call) : { items: [], nextCursor: null });
      }
      if (method === 'GET' && path === `/v1/forms/${FORM}/submissions/${SUB}/review`) {
        reads += 1;
        return answer(o.detail ? o.detail(reads) : detailJson());
      }
      if (method === 'POST' && /^\/v1\/forms\/[^/]+\/submissions\/[^/]+\/review\/units\/[^/]+\/decisions$/.test(path)) {
        decisions += 1;
        return answer(o.decide ? o.decide(decisions, call) : json(200, decidedJson('u_id')));
      }
      const other = o.other?.(call);
      return other === undefined ? Promise.resolve(problem(404, 'NOT_FOUND')) : answer(other);
    }),
  );
  return { calls, to: (method, pattern) => calls.filter((c) => c.method === method && pattern.test(c.path)) };
}
