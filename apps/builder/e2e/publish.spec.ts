import { expect, test } from './test.ts';
import { openNewForm } from './helpers.ts';

/*
 * Publish is for signed-in members of an org. The API has no anonymous publish, so a visitor who is not signed in is
 * sent to sign in, the draft they were building stays in this browser, and after signing in they land on it again.
 * The API is mocked here (the suites without a stack see a signed-out visitor); the real publish is in publish.int.test.ts.
 */

const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };
const ME = {
  user: USER,
  session: { id: 's1', mfaLevel: 'pwd', expiresAt: '2099-01-01T00:00:00Z' },
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

test('Publish sends a signed-out visitor to sign in, keeps the draft, and returns to it after signing in', async ({ page }) => {
  const publishCalls: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/v1\/(p\/publish|forms\/[^/]+\/publish)/.test(request.url())) publishCalls.push(request.url());
  });

  const id = await openNewForm(page);
  await page.getByPlaceholder('Form title').fill('Kept draft');
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await page.getByPlaceholder('Type ‘/’ to insert blocks').fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(publishCalls).toEqual([]);

  // Signing in brings the person back to the form they were building, with the draft intact.
  await page.route('**/v1/auth/login', (route) => route.fulfill({ json: { status: 'signed_in', user: USER } }));
  await page.route('**/v1/me', (route) => route.fulfill({ json: ME }));
  await page.getByLabel('Email').fill('asha@example.test');
  await page.getByLabel('Password').fill('violet-anchor-teapot-91');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/builder/${id}$`));
  await expect(page.getByPlaceholder('Form title')).toHaveValue('Kept draft');
});
