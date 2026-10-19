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

/**
 * Every e2e test runs under the production CSP (vite preview) and fails on any `securitypolicyviolation` its pages
 * raise, so a flow that needs an inline script or style, `eval` or an HTML sink is caught where it happens. A test that
 * provokes violations on purpose sets `allowCspViolations` and reads `cspViolations`.
 *
 * `GET /v1/meta/edition` answers with `edition` (SaaS by default); `null` makes the API unreachable.
 */
export const test = base.extend<{ allowCspViolations: boolean; cspViolations: CspViolation[]; edition: EditionSummary | null; editionRoute: void }>({
  allowCspViolations: [false, { option: true }],
  edition: [SAAS_EDITION, { option: true }],
  editionRoute: [
    async ({ context, edition }, use) => {
      await context.route('**/v1/meta/edition', (route) =>
        edition ? route.fulfill({ json: edition, headers: { 'cache-control': 'no-store' } }) : route.abort('connectionrefused'),
      );
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
