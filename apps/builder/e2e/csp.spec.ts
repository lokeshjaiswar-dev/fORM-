/// <reference lib="dom" />
import { expect, test, type Page } from './test.ts';

/*
 * FND-20: the builder's production policy (vite preview serves the build with the same headers as the static server).
 * Violations are blocked, raise `securitypolicyviolation`, and reach the report endpoint.
 */

const REPORTS = '/__csp-report';

interface Report {
  directive: string;
  blocked: string;
}

/** The collector is shared by parallel tests: each test's pages carry its id, and it reads only their reports. */
const run = () => `/forms?run=${test.info().testId}`;

/** Legacy `report-uri` bodies and Reporting API batches of this test's pages, reduced to directive and blocked URL. */
async function reports(page: Page): Promise<Report[]> {
  const res = await page.request.get(REPORTS);
  const list = (await res.json()) as Array<{ 'csp-report'?: Record<string, string>; body?: Record<string, string> }>;
  return list
    .map((r) => r['csp-report'] ?? r.body ?? {})
    .filter((b) => (b['document-uri'] ?? b.documentURL ?? '').includes(run()))
    .map((b) => ({ directive: b['effective-directive'] ?? b.effectiveDirective ?? '', blocked: b['blocked-uri'] ?? b.blockedURL ?? '' }));
}

test.use({ allowCspViolations: true });


test('the builder is served with the production policy and Referrer-Policy', async ({ page }) => {
  const res = await page.goto('/forms');
  const headers = res?.headers() ?? {};
  const csp = headers['content-security-policy'] ?? '';
  for (const directive of ["script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'", "object-src 'none'", "base-uri 'none'"]) {
    expect(csp.split('; ')).toContain(directive);
  }
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(csp.split('; ')).toContain(`report-uri ${REPORTS}`);
});

test('violations are blocked, raise securitypolicyviolation, and are reported', async ({ page, cspViolations }) => {
  await page.goto(run());
  await expect(page.getByRole('button', { name: 'New form' })).toBeVisible();
  expect(cspViolations).toEqual([]);

  const outcome = await page.evaluate(async () => {
    const sink = (() => {
      try {
        new DOMParser().parseFromString('<img src=x>', 'text/html');
        return 'assigned';
      } catch (e) {
        return e instanceof TypeError ? 'TypeError' : String(e);
      }
    })();
    const style = document.createElement('style');
    style.append(document.createTextNode('body { background: rgb(255, 0, 0) }'));
    document.head.append(style);
    const fetched = await fetch('https://csp-test.invalid/beacon').then(
      () => 'fetched',
      () => 'blocked',
    );
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = img.onerror = () => resolve();
      img.src = 'https://csp-test.invalid/pixel.png';
    });
    return { sink, fetched, background: getComputedStyle(document.body).backgroundColor };
  });
  expect(outcome).toEqual({ sink: 'TypeError', fetched: 'blocked', background: 'rgb(255, 255, 255)' });

  await expect.poll(() => cspViolations.map((v) => v.directive).sort()).toEqual(['connect-src', 'img-src', 'require-trusted-types-for', 'style-src-elem']);
  expect(cspViolations.every((v) => v.disposition === 'enforce')).toBe(true);

  await expect
    .poll(async () => [...new Set((await reports(page)).map((r) => r.directive))].sort())
    .toEqual(['connect-src', 'img-src', 'require-trusted-types-for', 'style-src-elem']);
  expect((await reports(page)).find((r) => r.directive === 'img-src')?.blocked).toMatch(/^https:\/\/csp-test\.invalid/);
});

test('the builder refuses to be framed (frame-ancestors none)', async ({ page }) => {
  /* A frame-ancestors report names only the origin, so this test counts them instead of filtering by its run id. */
  const frameReports = async () => {
    const list = (await (await page.request.get(REPORTS)).json()) as Array<{ 'csp-report'?: Record<string, string> }>;
    return list.filter((r) => r['csp-report']?.['effective-directive'] === 'frame-ancestors').length;
  };
  const before = await frameReports();
  await page.goto(run());
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = 'framed builder';
    document.body.append(frame);
  }, `${run()}&framed=1`);
  await expect.poll(frameReports).toBeGreaterThan(before);
  await expect(page.frameLocator('iframe[title="framed builder"]').getByRole('button', { name: 'New form' })).toHaveCount(0);
});
