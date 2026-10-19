import { expect, test } from '@playwright/test';

test('New-form gallery: the five pack templates, instantiated with the network cut off', async ({ page }) => {
  await page.goto('/builder/demo');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Start from a template' }).click();

  for (const title of ['Contact us', 'Customer feedback', 'NPS survey', 'Job application', 'Event registration']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();
  }
  await page.getByRole('button', { name: /^Job application/ }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeHidden();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Apply to join the team' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a role' })).toBeVisible();
  await expect(page.getByText('Resume *')).toBeVisible();
  await page.getByPlaceholder('Your name').fill('Asha');
  await expect(page.getByText('Why do you want to join us?')).toBeVisible();
});
