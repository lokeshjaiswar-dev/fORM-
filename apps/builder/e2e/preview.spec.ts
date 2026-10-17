import { expect, test, type Page } from '@playwright/test';

async function insert(page: Page, command: string, option: RegExp) {
  await page.getByPlaceholder("Type '/' to insert blocks").fill(command);
  await page.getByRole('option', { name: option }).first().click();
}

test('a 3-page form with a required field on page 3 advances from page 1', async ({ page }) => {
  await page.goto('/builder/demo');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  await insert(page, '/short', /Short answer/);
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);

  await page.locator('button.cursor-grab').last().click();
  await page.getByRole('button', { name: 'Validations' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Required', { exact: true })).toBeVisible();

  const answer = page.getByPlaceholder('Enter short answer');
  await answer.fill('Asha');
  await answer.press('Enter');
  await expect(page.getByRole('heading', { name: 'Thanks for your response!' })).toBeVisible();
});
