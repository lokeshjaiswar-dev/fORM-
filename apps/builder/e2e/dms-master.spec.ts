import { expect, test } from '@playwright/test';
import { RETURN, stubDms } from './support/dmsLaunch.ts';

/*
 * /embed/dms-master (T-FORM-1) in a real browser against the production build and its production CSP. DMS is a route stub here (the pass
 * against a real dms-api is the final e2e): this proves the page, the CSP and the request shape under the ticket launch. DMS hands the
 * page a one-use ticket in the URL fragment and the PKCE verifier in the tab's sessionStorage (e2e/support/dmsLaunch.ts).
 */

const MASTER = 'b9000000-0000-4000-8000-000000000001';
const SEVEN = ['Text Input', 'Number Input', 'Email', 'Phone Number', 'Multi-line Input', 'Dropdown', 'Date'];
const SEED = { name: 'Vendor', doctype_ids: [], folder_ids: [], classification: null } as const;

const created = { status: 201, body: { success: true, data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1' } } };

test('dms-master offers the seven DMS tiles, saves to DMS and returns', async ({ page }) => {
  const dms = await stubDms(page, { answer: (req) => (req.method === 'POST' && req.route === 'master/form' ? created : undefined) });
  const violations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));

  await dms.launch(page, dms.issue({ mode: 'dms-master', seed: SEED }));
  const palette = page.getByRole('complementary').first();
  await expect(palette.getByRole('button', { name: 'Email' })).toBeVisible();
  const tiles = palette.locator('[aria-roledescription="draggable"]');
  await expect(tiles).toHaveText(SEVEN);
  await expect(palette.getByRole('button', { name: 'Page break' })).toHaveCount(0);
  // The ticket is gone from the address bar once read.
  expect(page.url()).not.toContain('fpt=');

  await palette.getByRole('button', { name: 'Email' }).click();
  await palette.getByRole('button', { name: 'Date' }).click();
  await expect(page.getByRole('tab', { name: 'Logic' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save to DMS' }).click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?fp_status=saved&fp_master_id=${MASTER}`);
  const posts = dms.sessionRequests().filter((r) => r.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe('/api/dms/v1/formplus/s/master/form');
  expect(posts[0]!.headers['authorization']).toMatch(/^Bearer fps1_[A-Za-z0-9_-]{43}$/);
  expect(posts[0]!.headers['x-tenant-id']).toBeUndefined();
  expect(posts[0]!.headers['x-workspace-id']).toBeUndefined();
  expect(posts[0]!.body).toMatchObject({
    name: 'Vendor',
    source: 'formplus',
    form_builder_fields: [
      { type: 'email', name: 'Email', value: 'Email', required: false },
      { type: 'date', name: 'Date', value: 'Date', isDefaultToDate: false },
    ],
  });
  expect(dms.violations).toEqual([]);
  expect(violations).toEqual([]);
});

test('dms-master refuses an API base the link names that the build does not list, and sends nothing', async ({ page }) => {
  const dms = await stubDms(page);
  const issued = dms.issue({ mode: 'dms-master', seed: SEED });
  const outside: string[] = [];
  page.on('request', (r) => r.url().includes('evil.example') && outside.push(r.url()));
  await page.addInitScript((v) => sessionStorage.setItem('fp.lv', v), issued.verifier);
  await page.goto(`/embed/dms-master#fpt=${issued.ticket}&api=${encodeURIComponent('https://evil.example.test/api')}`);
  await expect(page.getByText(/not set up to talk to/)).toBeVisible();
  expect(dms.requests).toHaveLength(0);
  expect(outside).toEqual([]);
});

test('dms-master without a launch says it must be opened from DMS', async ({ page }) => {
  await page.goto('/embed/dms-master');
  await expect(page.getByRole('heading', { name: 'This page was not opened from DMS' })).toBeVisible();
});
