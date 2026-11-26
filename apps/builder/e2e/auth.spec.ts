import { expect, test } from './test.ts';

test('the forms list does not offer sign-in', async ({ page }) => {
  await page.goto('/forms');
  await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
});

test('old sign-in addresses open the forms list', async ({ page }) => {
  await page.goto('/auth/sign-in');
  await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
});
