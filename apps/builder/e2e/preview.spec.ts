import { expect, test } from './test.ts';
import { enableSectionBreaks, insert, label, openNewForm, openSettings } from './helpers.ts';

test('section breaks name a stepper that highlights the current section', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await enableSectionBreaks(page);
  await insert(page, '/section', /Section break/);
  await insert(page, '/short', /Short answer/);
  await insert(page, '/section', /Section break/);
  await insert(page, '/short', /Short answer/);
  await expect(page.getByRole('navigation', { name: 'Form sections' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Form sections' })).toContainText('Section 1');
  await expect(page.getByRole('navigation', { name: 'Form sections' })).toContainText('Section 2');

  await openSettings(page, 0);
  const settings = page.getByRole('complementary', { name: 'Block settings' });
  await settings.getByLabel('Section name').fill('Personal information');
  /* How the navigator marks the current section is a setting of the form (Form settings → Sections), not of one break. */
  await page.getByRole('button', { name: 'Form settings' }).click();
  const form = page.getByRole('dialog', { name: 'Form settings' });
  await form.getByRole('tab', { name: 'Sections' }).click();
  await form.getByRole('combobox', { name: 'Current section' }).click();
  await page.getByRole('option', { name: 'Pulse' }).click();
  await form.getByRole('button', { name: 'Close' }).click();
  await expect(form).toBeHidden();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Form sections' });
  await expect(nav).toBeVisible();
  await expect(nav).toContainText('Personal information');
  await expect(nav.locator('[data-state="current"]')).toContainText('Personal information');
});

test('a 3-page form with a required field on page 3 advances from page 1', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
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
