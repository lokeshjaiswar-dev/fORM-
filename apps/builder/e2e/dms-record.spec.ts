import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { RETURN, stubDms, type DmsStub, type SessionRequest } from './support/dmsLaunch.ts';

/*
 * /embed/dms-record (DESIGN-v2 section 4) in a real browser against the production build and its CSP, under the ticket launch. DMS is a
 * route stub answering from the contract fixture (written in the legacy paths; the stub maps the session routes back to them); the
 * replay against the real routes is dms-api's RecordContractTest.
 */

const fixtures = JSON.parse(readFileSync(new URL('../src/embed/record/__fixtures__/dms-record.fixtures.json', import.meta.url), 'utf8'));
const MASTER = fixtures.descriptor.add.masterId as string;
const RECORD = fixtures.descriptor.edit.recordId as string;

function answer(req: SessionRequest) {
  if (req.method === 'GET' && req.legacy === fixtures.loadMaster.request.path) return { status: 200, body: fixtures.loadMaster.response.body };
  if (req.method === 'GET' && req.legacy === fixtures.loadRecord.request.path) return { status: 200, body: fixtures.loadRecord.response.body };
  if (req.method === 'POST' && req.legacy === fixtures.create.request.path) return { status: 201, body: fixtures.create.response.body };
  if (req.method === 'PATCH' && req.legacy === fixtures.update.request.path) return { status: 200, body: fixtures.update.response.body };
  return undefined;
}

const writes = (dms: DmsStub) => dms.sessionRequests().filter((r) => r.method !== 'GET');
const launch = (dms: DmsStub, kind: 'add' | 'edit') => dms.issue({ mode: 'dms-record', masterId: MASTER, recordId: kind === 'edit' ? RECORD : null, seed: null });

test('add: fills the master form, posts the record to DMS and returns with the new record id', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  const violations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));

  await dms.launch(page, launch(dms, 'add'));
  await expect(page.getByRole('heading', { name: /Add record/ })).toBeVisible();
  expect(page.url()).not.toContain('fpt=');
  await expect(page.getByRole('textbox', { name: /Docs/ })).toHaveAttribute('readonly', '');

  await page.getByRole('textbox', { name: /Vendor Name/ }).fill('Acme');
  await page.getByRole('combobox', { name: /Tier/ }).selectOption('Gold');
  await page.getByRole('textbox', { name: /Phone/ }).fill('9876543210');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.saved}`);
  const sent = writes(dms);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe('POST');
  expect(sent[0]!.path).toBe('/api/dms/v1/formplus/s/master-records');
  expect(sent[0]!.headers['authorization']).toMatch(/^Bearer fps1_/);
  expect(sent[0]!.body).toMatchObject({ master_id: MASTER });
  expect((sent[0]!.body as { json_data: Record<string, string> }).json_data).toMatchObject({ 'Vendor Name': 'Acme', Tier: 'Gold', Phone: '9876543210' });
  expect(Object.keys((sent[0]!.body as { json_data: object }).json_data)).not.toContain('Docs');
  expect(dms.violations).toEqual([]);
  expect(violations).toEqual([]);
});

test('edit: loads the record, PATCHes only the changed Tier and returns', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  await dms.launch(page, launch(dms, 'edit'));
  await expect(page.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme');
  await expect(page.getByRole('combobox', { name: /Tier/ }).locator('option:checked')).toHaveText('Gold');
  await page.getByRole('combobox', { name: /Tier/ }).selectOption('Silver');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.saved}`);
  const sent = writes(dms);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: 'PATCH', path: `/api/dms/v1/formplus/s/master-records/${RECORD}` });
  expect(sent[0]!.body).toEqual(fixtures.update.request.body);
  expect(dms.violations).toEqual([]);
});

test('edit with nothing changed sends nothing and returns saved; cancel returns cancelled', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  await dms.launch(page, launch(dms, 'edit'));
  await expect(page.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.saved}`);
  expect(writes(dms)).toHaveLength(0);

  // A second launch is a second ticket, a second verifier: the same tab hands them over once each.
  await dms.launch(page, launch(dms, 'add'));
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?${fixtures.return.cancelled}`);
  expect(writes(dms)).toHaveLength(0);
  expect(dms.violations).toEqual([]);
});

test('an API base the link names that the build does not list is refused and nothing is sent', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  const issued = launch(dms, 'add');
  const outside: string[] = [];
  page.on('request', (r) => r.url().includes('evil.example') && outside.push(r.url()));
  await page.addInitScript((v) => sessionStorage.setItem('fp.lv', v), issued.verifier);
  await page.goto(`/embed/dms-record#fpt=${issued.ticket}&api=${encodeURIComponent('https://evil.example.test/api')}`);
  await expect(page.getByText(/not set up to talk to/)).toBeVisible();
  expect(dms.requests).toHaveLength(0);
  expect(outside).toEqual([]);
});
