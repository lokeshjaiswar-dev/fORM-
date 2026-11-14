import { readFile } from 'node:fs/promises';
import { expect, test } from './test.ts';

/*
 * The platform privacy pages (WP-1.31, CMP-21) under the production CSP, with the API mocked: the notice at sign-up
 * and on /privacy, and on the account's Privacy page the export download and account deletion. The real flow is
 * privacy.stack.spec.ts.
 */

const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };
const ME = { user: USER, session: { id: 's1', mfaLevel: 'pwd', expiresAt: '2026-11-02T00:00:00Z' }, orgs: [], notice: { version: '2026-10-19', acknowledgedVersion: '2026-10-19', current: true } };

test('sign-up shows the privacy notice and sends the version it showed', async ({ page }) => {
  let sent: unknown;
  await page.route('**/v1/auth/signup', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { status: 'verification_sent' } });
  });
  await page.goto('/auth/sign-up');
  await page.getByText('Read the privacy notice: what we collect, why, how long we keep it, and your rights.').click();
  await expect(page.getByRole('heading', { name: 'Who is responsible' })).toBeVisible();
  await page.getByLabel('Work email').fill('asha@example.test');
  await page.getByLabel('Password').fill('violet-anchor-teapot-91');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('We sent a link to asha@example.test');
  expect(sent).toMatchObject({ email: 'asha@example.test', noticeVersion: '2026-10-19' });
});

test('anyone can read the notice at /privacy', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy notice for fORM- accounts' })).toBeVisible();
  await expect(page.getByText('Delete your account.')).toBeVisible();
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/v1/me', (route) => route.fulfill({ json: ME }));
    await page.route('**/v1/me/grievances', (route) => route.fulfill({ json: { items: [] } }));
  });

  test('downloads the account export', async ({ page }) => {
    await page.route('**/v1/me/export', (route) =>
      route.fulfill({ json: { format: 'fr.account-export@1', user: { email: USER.email } }, headers: { 'content-disposition': 'attachment; filename="form-account-2026-10-19.json"' } }),
    );
    await page.goto('/account/privacy');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download my data' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('form-account-2026-10-19.json');
    expect(JSON.parse(await readFile((await file.path())!, 'utf8'))).toMatchObject({ format: 'fr.account-export@1', user: { email: USER.email } });
  });

  test('deletes the account after the address is typed', async ({ page }) => {
    await page.route('**/v1/me/deletion', (route) => route.fulfill({ json: { status: 'ready', orgs: [], recentSignIn: true, signInWithinMinutes: 15 } }));
    await page.route('**/v1/me/delete', (route) => route.fulfill({ json: { status: 'deleted', orgsLeft: 0, formsReassigned: 0, backupsExpireBy: '2026-11-23T10:00:00.000Z' } }));
    await page.goto('/account/privacy');
    await page.getByRole('button', { name: 'Delete my account…' }).click();
    await page.getByLabel('Type your email address to confirm').fill(USER.email);
    await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your account was deleted' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Copies in our backups expire by 23 Nov 2026.');
  });
});
