import { expect, test, type Page } from '@playwright/test';

/*
 * /embed/dms-master (T-FORM-1) in a real browser against the production build and its production CSP. DMS is a
 * route stub here: the pass against a real dms-api (T1) is the milestone gate, this one proves the page, the CSP and
 * the request shape. The descriptor travels in the URL fragment exactly as DMS+ sends it.
 */

const ORIGIN = 'http://localhost:4173';
const MASTER = 'b9000000-0000-4000-8000-000000000001';
const SEVEN = ['Text Input', 'Number Input', 'Email', 'Phone Number', 'Multi-line Input', 'Dropdown', 'Date'];

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const descriptor = (over: Record<string, unknown> = {}) => ({
  v: 1,
  mode: 'dms-master',
  profile: 'dms-v1',
  tenantId: 'acme',
  workspaceId: 'ws_1',
  master: { name: 'Vendor', doctypeIds: [], folderIds: [] },
  returnUrl: `${ORIGIN}/dms-return`,
  apiBase: `${ORIGIN}/api`,
  ...over,
});

async function stubDms(page: Page) {
  await page.addInitScript(() => localStorage.setItem('token', 'e2e-token'));
  const posted: Array<{ method: string; headers: Record<string, string>; body: unknown }> = [];
  await page.route('**/api/dms/v1/master/form**', async (route) => {
    const request = route.request();
    posted.push({ method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1' } }) });
  });
  await page.route('**/dms-return**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>DMS</title><p>back in DMS</p>' }));
  return posted;
}

test('dms-master offers the seven DMS tiles, saves to DMS and returns', async ({ page }) => {
  const posted = await stubDms(page);
  const violations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));

  await page.goto(`/embed/dms-master#fp=${b64url(descriptor())}`);
  const palette = page.getByRole('complementary').first();
  await expect(palette.getByRole('button', { name: 'Email' })).toBeVisible();
  const tiles = palette.locator('[aria-roledescription="draggable"]');
  await expect(tiles).toHaveText(SEVEN);
  await expect(palette.getByRole('button', { name: 'Page break' })).toHaveCount(0);
  // The fragment is gone from the address bar once parsed.
  expect(page.url()).not.toContain('fp=');

  await palette.getByRole('button', { name: 'Email' }).click();
  await palette.getByRole('button', { name: 'Date' }).click();
  await expect(page.getByRole('tab', { name: 'Logic' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save to DMS' }).click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${ORIGIN}/dms-return?fp_status=saved&fp_master_id=${MASTER}`);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.method).toBe('POST');
  expect(posted[0]!.headers['authorization']).toBe('Bearer e2e-token');
  expect(posted[0]!.headers['x-tenant-id']).toBe('acme');
  expect(posted[0]!.body).toMatchObject({
    name: 'Vendor',
    source: 'formplus',
    form_builder_fields: [
      { type: 'email', name: 'Email', value: 'Email', required: false },
      { type: 'date', name: 'Date', value: 'Date', isDefaultToDate: false },
    ],
  });
  expect(violations).toEqual([]);
});

test('dms-master refuses an API base it does not trust and sends nothing', async ({ page }) => {
  const posted = await stubDms(page);
  await page.goto(`/embed/dms-master#fp=${b64url(descriptor({ apiBase: 'https://evil.example.test/api' }))}`);
  await expect(page.getByText(/not set up to talk to/)).toBeVisible();
  expect(posted).toHaveLength(0);
});

test('dms-master without a descriptor says it must be opened from DMS', async ({ page }) => {
  await page.goto('/embed/dms-master');
  await expect(page.getByRole('heading', { name: 'This page was not opened from DMS' })).toBeVisible();
});
