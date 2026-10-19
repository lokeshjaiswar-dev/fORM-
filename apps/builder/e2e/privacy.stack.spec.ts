import { readFile } from 'node:fs/promises';
import { expect, test } from './test.ts';
import { newEmail, PASSWORD, signUpAndVerify } from './stack.ts';

/*
 * WP-1.31 acceptance, end to end against the real API (playwright.stack.config.ts): the notice version shown at
 * sign-up is recorded; the user downloads their data, sends a privacy request and deletes their account, which
 * signs them out and frees the address.
 */

test.use({ realApi: true });

test('a user exports their data, sends a privacy request and deletes their account', async ({ page }) => {
  const email = newEmail();
  await signUpAndVerify(page, email);
  await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
  // The notice of sign-up is the current one: nothing to acknowledge.
  await expect(page.getByRole('button', { name: 'I have read the privacy notice' })).toHaveCount(0);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^form-account-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await readFile((await file.path())!, 'utf8')) as { user: { email: string }; notices: Array<{ context: string }>; activity: Array<{ action: string }> };
  expect(data.user.email).toBe(email);
  expect(data.notices.map((n) => n.context)).toEqual(['signup']);

  await page.getByLabel('Kind of request').selectOption('information');
  await page.getByLabel('Your request').fill('Which of my data do you keep after I delete my account?');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status')).toContainText(/Sent\. Your reference is GRV-[A-Z2-7]{8}/);
  await expect(page.getByRole('list', { name: 'Your requests' })).toContainText('What do you hold about me? · open');

  await page.getByRole('button', { name: 'Delete my account…' }).click();
  await page.getByLabel('Type your email address to confirm').fill(email);
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your account was deleted' })).toBeVisible();

  // Signed out, and the account no longer signs in.
  await page.goto('/forms');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
});
