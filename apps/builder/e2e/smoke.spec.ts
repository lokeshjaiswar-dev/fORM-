import { expect, test } from '@playwright/test';

test('insert Short answer, preview, fill and submit', async ({ page }) => {
  await page.goto('/builder/demo');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();

  await page.getByPlaceholder("Type '/' to insert blocks").fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByPlaceholder('Enter short answer').fill('Asha');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Thanks for your response!' })).toBeVisible();
});
