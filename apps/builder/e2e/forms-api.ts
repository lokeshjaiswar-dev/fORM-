import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';

/*
 * A small stand-in for the forms API, for the e2e suites that run without the real stack (playwright.config.ts). The
 * builder sits behind sign-in and keeps every draft on the server (WP-1.06, BL-206), so a spec that opens /forms or
 * /builder needs a signed-in session and somewhere to save to. This answers `GET /v1/me`, the forms list, a form's
 * draft with `If-Match` (a stale write is a 409 with the server draft, as the real API sends it), validate, publish and
 * trash. The publish checks are only the one the specs use (a redirect that is not http(s)); the real checks are the
 * API's, and run in apps/api/test/publish.int.test.ts. A spec about what the server decides belongs in a `*.stack.spec.ts`.
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
  updatedAt: string;
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

    if (method === 'GET' && path === '/v1/me') return route.fulfill({ json: ME });

    if (path === '/v1/forms') {
      record();
      if (method === 'GET') {
        const items = [...this.forms.values()].filter((f) => f.lifecycle === 'active').map(({ id, title, lifecycle, updatedAt }) => ({ id, title, lifecycle, updatedAt }));
        return route.fulfill({ json: { items, nextCursor: null } });
      }
      if (method === 'POST') {
        const { id = randomUUID(), title = '' } = (body ?? {}) as { id?: string; title?: string };
        if (!this.forms.has(id)) this.forms.set(id, { id, title, lifecycle: 'active', draft: null, draftRev: 0, updatedAt: new Date().toISOString() });
        return route.fulfill({ status: 201, json: { id } });
      }
    }

    const match = /^\/v1\/forms\/([^/]+)\/(draft|validate|publish|trash)$/.exec(path);
    if (!match) return route.fallback();
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
      return route.fulfill({ json: { slug: `e2e-${id.slice(0, 8)}`, versionId: randomUUID(), number: 1, draftRev: form.draftRev } });
    }

    if (action === 'trash' && method === 'POST') {
      form.lifecycle = 'trashed';
      return route.fulfill({ json: { id } });
    }
    return route.fallback();
  }
}

/** Signs the page's browser in as `ME` and gives it a forms API to save to. Returns the API, to read what the page sent. */
export async function signInWithFormsApi(page: Page): Promise<FakeFormsApi> {
  const api = new FakeFormsApi();
  await page.route((url) => url.pathname.startsWith('/v1/'), (route) => api.handle(route));
  return api;
}
