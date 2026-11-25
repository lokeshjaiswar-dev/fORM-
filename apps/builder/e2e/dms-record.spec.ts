import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * /embed/dms-record (DESIGN-v2 section 4) in a real browser against the production build and its CSP. DMS is a route stub
 * answering from the contract fixture; the replay against the real routes is dms-api's RecordContractTest. The descriptor
 * travels in the URL fragment as DMS+ sends it.
 */

const fixtures = JSON.parse(readFileSync(new URL('../src/embed/record/__fixtures__/dms-record.fixtures.json', import.meta.url), 'utf8'));
const ORIGIN = 'http://localhost:4173';
const MASTER = fixtures.descriptor.add.masterId as string;
const RETURN = `${ORIGIN}/dms-return`;

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const launch = (kind: 'add' | 'edit') => b64url({ ...fixtures.descriptor[kind], returnUrl: RETURN, apiBase: `${ORIGIN}/api` });

async function stubDms(page: Page) {
  await page.addInitScript(() => localStorage.setItem('token', 'e2e-token'));
  const writes: Array<{ method: string; path: string; authorization: string | undefined; body: unknown }> = [];
  await page.route('**/api/dms/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'GET' && path === fixtures.loadMaster.request.path) return json(200, fixtures.loadMaster.response.body);
    if (request.method() === 'GET' && path === fixtures.loadRecord.request.path) return json(200, fixtures.loadRecord.response.body);
    writes.push({ method: request.method(), path, authorization: request.headers()['authorization'], body: request.postDataJSON() });
    if (request.method() === 'POST' && path === fixtures.create.request.path) return json(201, fixtures.create.response.body);
    if (request.method() === 'PATCH' && path === fixtures.update.request.path) return json(200, fixtures.update.response.body);
    return json(404, { message: 'unexpected' });
  });
  await page.route('**/dms-return**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>DMS</title><p>back in DMS</p>' }));
  return writes;
}

test('add: fills the master form, posts the record to DMS and returns with the new record id', async ({ page }) => {
  const writes = await stubDms(page);
  const violations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));

  await page.goto(`/embed/dms-record#fp=${launch('add')}`);
  await expect(page.getByRole('heading', { name: /Add record/ })).toBeVisible();
  expect(page.url()).not.toContain('fp=');
  await expect(page.getByRole('textbox', { name: /Docs/ })).toHaveAttribute('readonly', '');

  await page.getByRole('textbox', { name: /Vendor Name/ }).fill('Acme');
  await page.getByRole('combobox', { name: /Tier/ }).selectOption('Gold');
  await page.getByRole('textbox', { name: /Phone/ }).fill('9876543210');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.saved}`);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.method).toBe('POST');
  expect(writes[0]!.authorization).toBe('Bearer e2e-token');
  expect(writes[0]!.body).toMatchObject({ master_id: MASTER });
  expect((writes[0]!.body as { json_data: Record<string, string> }).json_data).toMatchObject({ 'Vendor Name': 'Acme', Tier: 'Gold', Phone: '9876543210' });
  expect(Object.keys((writes[0]!.body as { json_data: object }).json_data)).not.toContain('Docs');
  expect(violations).toEqual([]);
});

test('edit: loads the record, PATCHes only the changed Tier and returns', async ({ page }) => {
  const writes = await stubDms(page);
  await page.goto(`/embed/dms-record#fp=${launch('edit')}`);
  await expect(page.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme');
  await expect(page.getByRole('combobox', { name: /Tier/ }).locator('option:checked')).toHaveText('Gold');
  await page.getByRole('combobox', { name: /Tier/ }).selectOption('Silver');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.saved}`);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: 'PATCH', path: fixtures.update.request.path });
  expect(writes[0]!.body).toEqual(fixtures.update.request.body);
});

test('edit with nothing changed sends nothing and returns saved; cancel returns cancelled', async ({ page }) => {
  const writes = await stubDms(page);
  await page.goto(`/embed/dms-record#fp=${launch('edit')}`);
  await expect(page.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.saved}`);
  expect(writes).toHaveLength(0);

  await page.goto(`/embed/dms-record#fp=${launch('add')}`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.cancelled}`);
  expect(writes).toHaveLength(0);
});

test('an API base it does not trust is refused and nothing is sent', async ({ page }) => {
  const writes = await stubDms(page);
  const requests: string[] = [];
  page.on('request', (r) => r.url().includes('evil.example') && requests.push(r.url()));
  await page.goto(`/embed/dms-record#fp=${b64url({ ...fixtures.descriptor.add, returnUrl: RETURN, apiBase: 'https://evil.example.test/api' })}`);
  await expect(page.getByText(/not set up to talk to/)).toBeVisible();
  expect(writes).toHaveLength(0);
  expect(requests).toEqual([]);
});
