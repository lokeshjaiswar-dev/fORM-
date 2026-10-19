import { expect, test } from './test.ts';
import { insert, label, openNewForm, openSettings } from './helpers.ts';

test('a 3-page form with a required field on page 3 advances from page 1', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  await insert(page, '/short', /Short answer/);
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await label(page, 'Third');
  await expect(page.getByRole('separator', { name: 'Page break' })).toHaveCount(2);

  await openSettings(page, 2);
  await page.getByRole('tab', { name: 'Validation' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('This field is required.', { exact: true })).toBeVisible();

  const answer = page.getByRole('textbox', { name: /Third/ });
  await answer.fill('Asha');
  await answer.press('Enter');
  await expect(page.getByRole('heading', { name: 'Thanks for your response!' })).toBeVisible();
});
