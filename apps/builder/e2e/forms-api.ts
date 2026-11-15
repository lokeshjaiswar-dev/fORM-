import { createHash, randomUUID } from 'node:crypto';
import type { Route } from '@playwright/test';

/*
 * A small stand-in for the forms API, for the e2e suites that run without the real stack (playwright.config.ts). The
 * builder sits behind sign-in and keeps every draft on the server (WP-1.06, BL-206), so a spec that opens /forms or
 * /builder needs a signed-in session and somewhere to save to. This answers `GET /v1/me`, the forms list, a form's
 * draft with `If-Match` (a stale write is a 409 with the server draft, as the real API sends it), validate, publish and
 * trash, the two reads the form settings make when the Review tab opens (a form's review settings, the org's review
 * groups; both empty), the reads the Emails and Email log tabs and the Email senders page make (a form's notifications,
 * its email log, the org's senders and members; nothing set up yet) and the one the Webhooks tab makes (a form's
 * webhooks; none), and the checker's reads and decisions (the org, the review queue, a held response for review and the decision of a
 * unit; the queue is empty and no response is held until a spec adds one). The publish checks are only the one the specs use (a redirect that is not http(s)); the real checks
 * are the API's, and run in apps/api/test/publish.int.test.ts. A spec about what the server decides belongs in a
 * `*.stack.spec.ts`.
 *
 * e2e/test.ts gives every test one of these as the `formsApi` fixture, routed for the whole browser context (a second
 * tab shares it), and signed in as `ME` unless the suite says `test.use({ signedIn: false })`. The app is not told
 * anything: it asks `GET /v1/me` as it would of the real API and gets a member of an org, or a 401.
 */

export const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };
export const ME = {
  user: USER,
  session: { id: 's1', mfaLevel: 'pwd', expiresAt: '2099-01-01T00:00:00Z' },
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

/** What the owner's role grants (`PERMISSIONS` of apps/api/src/authz/roles.ts, as `GET /v1/org` lists them). */
const OWNER_PERMISSIONS = [
  'forms.create',
  'forms.edit',
  'forms.publish',
  'forms.read',
  'submissions.read',
  'submissions.edit',
  'submissions.delete',
  'submissions.export',
  'submissions.review',
  'ops.manage',
  'data.route',
  'compliance.approve_notice',
  'compliance.dsr',
  'compliance.retention',
  'compliance.legal_hold',
  'compliance.statutory_access',
  'members.manage',
  'org.settings',
  'billing.manage',
  'api_keys.manage',
  'brand_kits.manage',
  'org_profile.manage',
];

/** One row of `GET /v1/reviews/queue` (`queueItem` of apps/api/src/modules/reviews/queue.ts). */
export interface FakeQueueItem {
  submissionId: string;
  formId: string;
  formTitle: string;
  unitId: string;
  unitName: string;
  round: number;
  order: number;
  required: boolean;
  receivedAt: string;
  ageSeconds: number;
}

/** One unit of a held response, as `reviewUnitView` of apps/api/src/modules/reviews/decide.ts has it, plus the answers' version (what `answersHash` is made from). */
export interface FakeReviewUnit {
  unitId: string;
  name: string;
  state: 'pending' | 'approved' | 'rejected' | 'not_applicable' | 'closed';
  round: number;
  required: boolean;
  order: number;
  groupId: string;
  groupName: string | null;
  visibility: 'own_unit' | 'whole_submission';
  yours: boolean;
  canDecide: boolean;
  blocked: boolean;
  rev: number;
  /** Moves on when the unit's answers change; a decision that names an older one is a 409 `REVIEW_STALE`. */
  answersVersion: number;
}

/** A held response as `GET /v1/forms/:id/submissions/:sid/review` answers it, kept with the decisions made on it. */
export interface FakeReview {
  formId: string;
  submissionId: string;
  formTitle: string;
  receivedAt: string;
  status: 'pending_review' | 'complete' | 'rejected';
  redacted: boolean;
  units: FakeReviewUnit[];
  decisions: Array<{ id: string; unitId: string; round: number; decision: 'approve' | 'reject'; reasonCode: string | null; decidedAt: string; decidedBy: { userId: string; name: string | null } }>;
  fields: Array<{ id: string; key: string; label: string; type: string; value: string; masked: boolean }>;
  /** The keys of the decisions made, with what each answered: a replay returns the first answer. */
  keys: Map<string, unknown>;
}

/** The token a unit's `answersHash` carries: 64 hex digits that change with the answers (the real one is keyed; a spec only compares them). */
const tokenOf = (review: FakeReview, unit: FakeReviewUnit): string =>
  createHash('sha256').update(`${review.submissionId}:${unit.unitId}:${unit.round}:${unit.answersVersion}`).digest('hex');

/** `reviewDetailResponse` of apps/api/src/modules/reviews/decide.ts. */
function reviewDetailOf(review: FakeReview): Record<string, unknown> {
  return {
    submission: { id: review.submissionId, formId: review.formId, formTitle: review.formTitle, receivedAt: review.receivedAt, status: review.status, versionId: randomUUID(), versionNumber: 1, locale: 'en-IN' },
    redacted: review.redacted,
    units: review.units.map((unit) => {
      const { answersVersion: _version, ...view } = unit;
      return { ...view, answersHash: unit.yours || !review.redacted ? tokenOf(review, unit) : null };
    }),
    decisions: review.decisions,
    fields: review.fields,
    answers: {},
    files: [],
  };
}

export interface FakeIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

interface FakeForm {
  id: string;
  title: string;
  lifecycle: 'active' | 'trashed';
  draft: Record<string, unknown> | null;
  draftRev: number;
  createdAt: string;
  updatedAt: string;
  /** Set once the form is published: the list shows its public link. */
  isLive: boolean;
}

/** The API calls the page made, in order. */
export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}) => ({
  status,
  contentType: 'application/problem+json',
  json: { type: 'about:blank', title, status, code, instance: '/', requestId: randomUUID(), ...extra },
});

/** What the real checks would say about a redirect ending that is not http(s). */
function issuesOf(draft: Record<string, unknown>): FakeIssue[] {
  const endings = Array.isArray(draft.endings) ? (draft.endings as Array<Record<string, unknown>>) : [];
  const issues: FakeIssue[] = [];
  endings.forEach((ending, i) => {
    if (ending.kind !== 'redirect') return;
    const first = Array.isArray(ending.url) ? ending.url[0] : undefined;
    if (typeof first === 'string' && !/^https?:\/\//i.test(first)) {
      issues.push({ severity: 'error', code: 'invalid_url_scheme', path: `/endings/${i}/url`, message: 'the URL must start with https:// or http://' });
    }
  });
  return issues;
}

export class FakeFormsApi {
  readonly forms = new Map<string, FakeForm>();
  readonly calls: FakeCall[] = [];
  /** Whether the browser has a session: `GET /v1/me` and the forms routes answer 401 while it has not. A test may sign in or out midway. */
  signedIn = true;
  /** The units that wait for the member (`GET /v1/reviews/queue`), newest response first as a spec lists them. Empty: nothing waits. */
  readonly reviewQueue: FakeQueueItem[] = [];
  /** The held responses a spec made, by `<formId>/<submissionId>`. A response not in here is a 404, as one of another org is. */
  readonly reviews = new Map<string, FakeReview>();

  /** The calls made to `path` with `method`. */
  called(method: string, path: RegExp): FakeCall[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  /**
   * Changes a form's draft the way another browser, an import or an API client would: the revision moves on, and the
   * page finds out on its next load or save.
   */
  editDraft(id: string, change: (draft: Record<string, unknown>) => Record<string, unknown>): void {
    const form = this.forms.get(id);
    if (!form?.draft) throw new Error(`the fake API has no draft of form ${id}`);
    form.draft = change(structuredClone(form.draft));
    form.draftRev += 1;
    form.updatedAt = new Date().toISOString();
  }

  /**
   * `POST .../review/units/:unitId/decisions`: the key is required and a replay returns the first answer; answers that changed
   * since the checker read them are a 409 `REVIEW_STALE`; a unit that is no longer open is a 409 `REVIEW_CLOSED`. An approve of
   * the last required unit completes the response, a reject of a required unit rejects it.
   */
  private async decide(route: Route, review: FakeReview, unitId: string, key: string | undefined, body: Record<string, unknown>): Promise<void> {
    if (!key) return route.fulfill(problem(400, 'VALIDATION', 'Idempotency-Key is required'));
    const first = review.keys.get(key);
    if (first !== undefined) return route.fulfill({ json: first, headers: { 'idempotent-replayed': 'true', 'cache-control': 'no-store' } });
    const unit = review.units.find((u) => u.unitId === unitId);
    if (!unit) return route.fulfill(problem(404, 'NOT_FOUND', 'That unit is not on a response of this form.'));
    if (unit.state !== 'pending') return route.fulfill(problem(409, 'REVIEW_CLOSED', 'This unit is not waiting for a decision any more.'));
    if (body.answersHash !== tokenOf(review, unit)) return route.fulfill(problem(409, 'REVIEW_STALE', 'The answers of this unit changed since you read them. Reload and read them again.'));
    const decision = body.decision === 'reject' ? 'reject' : 'approve';
    if (decision === 'reject' && typeof body.reasonCode !== 'string') return route.fulfill(problem(400, 'VALIDATION', 'a reject needs a reason code'));
    const decidedAt = new Date().toISOString();
    const decisionId = randomUUID();
    unit.state = decision === 'approve' ? 'approved' : 'rejected';
    unit.canDecide = false;
    review.decisions.push({ id: decisionId, unitId, round: unit.round, decision, reasonCode: decision === 'reject' ? (body.reasonCode as string) : null, decidedAt, decidedBy: { userId: USER.id, name: USER.name } });
    if (decision === 'reject' && unit.required) {
      review.status = 'rejected';
      for (const other of review.units) if (other.state === 'pending') Object.assign(other, { state: 'closed', canDecide: false });
    } else if (review.units.every((u) => !u.required || u.state === 'approved' || u.state === 'not_applicable')) review.status = 'complete';
    const answer = { decisionId, unitId, decision, reasonCode: decision === 'reject' ? (body.reasonCode as string) : null, round: unit.round, decidedAt, unitState: unit.state, submissionStatus: review.status };
    review.keys.set(key, answer);
    return route.fulfill({ json: answer, headers: { 'cache-control': 'no-store' } });
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (!path.startsWith('/v1/')) return route.fallback();
    const body: unknown = request.postData() ? JSON.parse(request.postData() ?? 'null') : undefined;
    const record = () => this.calls.push({ method, path, body });

    const unauthenticated = () => route.fulfill(problem(401, 'UNAUTHENTICATED', 'Authentication required'));

    if (method === 'GET' && path === '/v1/me') return this.signedIn ? route.fulfill({ json: ME }) : unauthenticated();

    if (path === '/v1/forms') {
      if (!this.signedIn) return unauthenticated();
      record();
      if (method === 'GET') {
        // The real row shape (formsListApi.ts); a row missing a field is refused and the page falls back to its offline cache.
        const items = [...this.forms.values()]
          .filter((f) => f.lifecycle === 'active')
          .map(({ id, title, lifecycle, createdAt, updatedAt, isLive }) => ({ id, title, lifecycle, createdAt, updatedAt, favourite: false, submissionCount: 0, isLive }));
        return route.fulfill({ json: { items, nextCursor: null } });
      }
      if (method === 'POST') {
        const { id = randomUUID(), title = '' } = (body ?? {}) as { id?: string; title?: string };
        const now = new Date().toISOString();
        if (!this.forms.has(id)) this.forms.set(id, { id, title, lifecycle: 'active', draft: null, draftRev: 0, createdAt: now, updatedAt: now, isLive: false });
        return route.fulfill({ status: 201, json: { id } });
      }
    }

    // The active org with the caller's role and what it grants (WP-2.33: the Reviews entry shows when `submissions.review` is among them).
    if (method === 'GET' && path === '/v1/org') {
      if (!this.signedIn) return unauthenticated();
      record();
      const org = { id: 'o1', slug: 'acme', name: 'Acme', plan: 'free', region: 'in-mum-1', locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' };
      return route.fulfill({ json: { org, role: 'owner', permissions: OWNER_PERMISSIONS } });
    }

    // The review queue (WP-2.33): the units that wait for the member, filtered by form, unit and age as the real one is.
    if (method === 'GET' && path === '/v1/reviews/queue') {
      if (!this.signedIn) return unauthenticated();
      record();
      const q = url.searchParams;
      const days = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }[q.get('age') ?? ''] ?? 0;
      const items = this.reviewQueue.filter((i) => (!q.get('formId') || i.formId === q.get('formId')) && (!q.get('unitId') || i.unitId === q.get('unitId')) && i.ageSeconds >= days * 86_400);
      return route.fulfill({ json: { items, nextCursor: null }, headers: { 'cache-control': 'no-store' } });
    }

    // A held response for review, and the decision of one of its units (WP-2.33), as apps/api/src/modules/reviews/decide.ts answers them.
    const reviewOf = /^\/v1\/forms\/([^/]+)\/submissions\/([^/]+)\/review(?:\/units\/([^/]+)\/decisions)?$/.exec(path);
    if (reviewOf) {
      if (!this.signedIn) return unauthenticated();
      record();
      const [, formId = '', submissionId = '', unitId] = reviewOf.map((part) => (part === undefined ? part : decodeURIComponent(part)));
      const review = this.reviews.get(`${formId}/${submissionId}`);
      if (!review) return route.fulfill(problem(404, 'NOT_FOUND', 'That response is not on this form.'));
      if (method === 'GET' && unitId === undefined) return route.fulfill({ json: reviewDetailOf(review), headers: { 'cache-control': 'no-store' } });
      if (method === 'POST' && unitId !== undefined) return this.decide(route, review, unitId, request.headers()['idempotency-key'], (body ?? {}) as Record<string, unknown>);
    }

    // The org's review groups (WP-2.33): the Members page lists them and a form's Review tab offers them. A fresh org has none.
    if (method === 'GET' && path === '/v1/org/review-groups') {
      if (!this.signedIn) return unauthenticated();
      record();
      return route.fulfill({ json: { items: [] }, headers: { 'cache-control': 'no-store' } });
    }

    // The org's email senders (WP-1.16): the Email senders page lists them and a form's Emails tab offers them as "send from".
    // A fresh org has none. An item is `senderView` of apps/api/src/routes/email-senders.ts, which never holds the SMTP URL.
    if (method === 'GET' && path === '/v1/email-senders') {
      if (!this.signedIn) return unauthenticated();
      record();
      return route.fulfill({ json: { items: [] }, headers: { 'cache-control': 'private, no-store' } });
    }

    // The org's members (WP-1.02): the recipient picker of a form's Emails tab. The one member is the signed-in user, as `memberView` has it.
    if (method === 'GET' && path === '/v1/org/members') {
      if (!this.signedIn) return unauthenticated();
      record();
      return route.fulfill({ json: { items: [{ userId: USER.id, email: USER.email, name: USER.name, role: 'owner', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' }], accessLinks: false } });
    }

    // A form's webhooks (WP-1.18): the Webhooks tab of the form settings lists them when it opens. A form nobody set one up
    // for answers the empty list, with the no-store header the real route sends. Making, saving and replaying them is the
    // stack suite's: the fake answers only the read, so a spec that opens the tab sees the "no webhooks yet" state.
    const webhooksRead = /^\/v1\/forms\/([^/]+)\/webhooks$/.exec(path);
    if (method === 'GET' && webhooksRead) {
      if (!this.signedIn) return unauthenticated();
      record();
      if (!this.forms.has(decodeURIComponent(webhooksRead[1] ?? ''))) return route.fulfill(problem(404, 'NOT_FOUND', 'That form is not in this organisation.'));
      return route.fulfill({ json: { items: [] }, headers: { 'cache-control': 'no-store' } });
    }

    const match = /^\/v1\/forms\/([^/]+)\/(draft|validate|publish|trash|review|notifications|email-log)$/.exec(path);
    if (!match) return route.fallback();
    if (!this.signedIn) return unauthenticated();
    record();
    const [, id = '', action] = match;
    const form = this.forms.get(id);
    if (!form) return route.fulfill(problem(404, 'NOT_FOUND', 'That form is not in this organisation.'));

    if (action === 'draft' && method === 'GET') {
      if (!form.draft) return route.fulfill(problem(404, 'NOT_FOUND', 'This form has no draft yet.'));
      return route.fulfill({ json: { draftRev: form.draftRev, schemaVersion: 2, draft: form.draft, updatedAt: form.updatedAt, updatedBy: USER.id } });
    }

    if (action === 'draft' && method === 'PUT') {
      const header = request.headers()['if-match'];
      if (header === undefined) return route.fulfill(problem(428, 'PRECONDITION_REQUIRED', 'Send If-Match with the draft revision you read'));
      const read = Number(/^(?:W\/)?"?(\d+)"?$/.exec(header.trim())?.[1]);
      if (read !== form.draftRev) {
        return route.fulfill(problem(409, 'DRAFT_REV_CONFLICT', 'The draft changed since it was read', { draftRev: form.draftRev, updatedAt: form.updatedAt, updatedBy: null, draft: form.draft }));
      }
      const draft = (body as { draft: Record<string, unknown> }).draft;
      form.draft = draft;
      form.title = typeof draft.title === 'string' ? draft.title : form.title;
      form.draftRev += 1;
      form.updatedAt = new Date().toISOString();
      return route.fulfill({ json: { draftRev: form.draftRev, updatedAt: form.updatedAt } });
    }

    if (action === 'validate' && method === 'POST') {
      const issues = form.draft ? issuesOf(form.draft) : [];
      return route.fulfill({ json: { ok: !issues.some((i) => i.severity === 'error'), draftRev: form.draftRev, definitionHash: null, issues, issueCount: issues.length } });
    }

    if (action === 'publish' && method === 'POST') {
      const issues = form.draft ? issuesOf(form.draft) : [];
      if (issues.some((i) => i.severity === 'error')) {
        return route.fulfill(problem(422, 'PUBLISH_BLOCKED', 'This form cannot be published', { detail: 'Fix the problems listed, then publish again.', issues, issueCount: issues.length }));
      }
      form.isLive = true;
      return route.fulfill({ json: { slug: `e2e-${id.slice(0, 8)}`, versionId: randomUUID(), number: 1, draftRev: form.draftRev } });
    }

    // The form's review settings (WP-2.33), as GET /v1/forms/:id/review answers a form nobody set up: review off, no
    // units, revision 0 (the first save names it in If-Match), with the revision as the ETag. A save is the stack suite's.
    if (action === 'review' && method === 'GET') {
      return route.fulfill({ json: { rev: 0, enabled: false, distinctCheckers: false, units: [] }, headers: { etag: '"0"', 'cache-control': 'no-store' } });
    }

    // The form's notifications (WP-1.16), as GET /v1/forms/:id/notifications answers a form with none: an empty list, no cursor.
    if (action === 'notifications' && method === 'GET') {
      return route.fulfill({ json: { items: [] }, headers: { 'cache-control': 'private, no-store' } });
    }

    // The form's email log (WP-1.16): newest first by cursor; a form that has sent nothing has an empty page and no next cursor.
    if (action === 'email-log' && method === 'GET') {
      return route.fulfill({ json: { items: [], nextCursor: null }, headers: { 'cache-control': 'private, no-store' } });
    }

    if (action === 'trash' && method === 'POST') {
      form.lifecycle = 'trashed';
      return route.fulfill({ json: { id } });
    }
    return route.fallback();
  }
}
