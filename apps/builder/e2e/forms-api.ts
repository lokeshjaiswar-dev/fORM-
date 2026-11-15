import { randomUUID } from 'node:crypto';
import type { Route } from '@playwright/test';

/*
 * A small stand-in for the forms API, for the e2e suites that run without the real stack (playwright.config.ts). The
 * builder sits behind sign-in and keeps every draft on the server (WP-1.06, BL-206), so a spec that opens /forms or
 * /builder needs a signed-in session and somewhere to save to. This answers `GET /v1/me`, the forms list, a form's
 * draft with `If-Match` (a stale write is a 409 with the server draft, as the real API sends it), validate, publish and
 * trash, the two reads the form settings make when the Review tab opens (a form's review settings, the org's review
 * groups; both empty), and the reads the Emails and Email log tabs and the Email senders page make (a form's notifications,
 * its email log, the org's senders and members; nothing set up yet). The publish checks are only the one the specs use (a redirect that is not http(s)); the real checks are the
 * API's, and run in apps/api/test/publish.int.test.ts. A spec about what the server decides belongs in a `*.stack.spec.ts`.
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
