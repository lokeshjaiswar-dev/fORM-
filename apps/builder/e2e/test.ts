import { expect, test as base } from '@playwright/test';
import { editionSummary, loadEditionConfig, type EditionSummary } from '@form/config';

export interface CspViolation {
  directive: string;
  disposition: string;
  blockedURI: string;
  sourceFile: string;
  line: number;
  sample: string;
}

declare global {
  interface Window {
    __frCspViolation?: (v: CspViolation) => void;
  }
}

export const SAAS_EDITION = editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' }));

/** What `GET /v1/privacy/notice` answers in the suites without an API (the real text is the API's, CMP-21). */
export const TEST_NOTICE = {
  version: '2026-10-19',
  locale: 'en-IN',
  title: 'Privacy notice for fORM- accounts',
  fiduciary: 'fORM-',
  contact: { name: null, email: 'privacy@form.test' },
  sections: [
    { id: 'who', heading: 'Who is responsible', paragraphs: ['fORM- runs this service and is the Data Fiduciary for the personal data of your account.'], items: [] },
    { id: 'rights', heading: 'Your choices and rights', paragraphs: [], items: ['See and download what we hold about you.', 'Delete your account.'] },
  ],
  hash: 'c'.repeat(64),
};

/**
 * Every e2e test runs under the production CSP (vite preview) and fails on any `securitypolicyviolation` its pages
 * raise, so a flow that needs an inline script or style, `eval` or an HTML sink is caught where it happens. A test that
 * provokes violations on purpose sets `allowCspViolations` and reads `cspViolations`.
 *
 * `GET /v1/meta/edition` answers with `edition` (SaaS by default); `null` makes the API unreachable.
 */
export const test = base.extend<{
  allowCspViolations: boolean;
  cspViolations: CspViolation[];
  edition: EditionSummary | null;
  editionRoute: void;
  realApi: boolean;
  authRoutes: void;
}>({
  allowCspViolations: [false, { option: true }],
  edition: [SAAS_EDITION, { option: true }],
  editionRoute: [
    async ({ context, edition, realApi }, use) => {
      if (!realApi) {
        await context.route('**/v1/meta/edition', (route) =>
          edition ? route.fulfill({ json: edition, headers: { 'cache-control': 'no-store' } }) : route.abort('connectionrefused'),
        );
      }
      await use();
    },
    { auto: true },
  ],
  /* The suites without an API see a signed-out visitor; playwright.stack.config.ts sets `realApi` and mocks nothing. */
  realApi: [false, { option: true }],
  authRoutes: [
    async ({ context, realApi }, use) => {
      if (!realApi) {
        await context.route('**/v1/me', (route) =>
          route.fulfill({ status: 401, contentType: 'application/problem+json', json: { status: 401, code: 'UNAUTHENTICATED', title: 'Authentication required' } }),
        );
        await context.route('**/v1/auth/methods', (route) => route.fulfill({ json: { password: true, emailLinks: true, oauth: [] } }));
        await context.route('**/v1/privacy/notice', (route) => route.fulfill({ json: TEST_NOTICE }));
      }
      await use();
    },
    { auto: true },
  ],
  cspViolations: [
    async ({ context, allowCspViolations }, use) => {
      const seen: CspViolation[] = [];
      await context.exposeBinding('__frCspViolation', (_source, v: CspViolation) => void seen.push(v));
      await context.addInitScript(() => {
        document.addEventListener(
          'securitypolicyviolation',
          (e) =>
            window.__frCspViolation?.({
              directive: e.effectiveDirective,
              disposition: e.disposition,
              blockedURI: e.blockedURI,
              sourceFile: e.sourceFile,
              line: e.lineNumber,
              sample: e.sample,
            }),
          true,
        );
      });
      await use(seen);
      if (!allowCspViolations) expect(seen, 'Content-Security-Policy violations').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from '@playwright/test';
