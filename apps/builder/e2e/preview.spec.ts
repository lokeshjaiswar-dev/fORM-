import { expect, test } from './test.ts';
import { enableSectionBreaks, insert, label, openNewForm, openSettings } from './helpers.ts';

test('section breaks name a stepper that highlights the current section', async ({ page }) => {
  await openNewForm(page);
  await enableSectionBreaks(page);
  await page.getByRole('button', { name: /^Drag & drop your first element/ }).click();
  await insert(page, '/section', /Section break/);
  await insert(page, '/short', /Short answer/);
  await insert(page, '/section', /Section break/);
  await insert(page, '/short', /Short answer/);
  await expect(page.getByRole('navigation', { name: 'Form sections' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Form sections' })).toContainText('Section 1');
  await expect(page.getByRole('navigation', { name: 'Form sections' })).toContainText('Section 2');

  await openSettings(page, 0);
  await page.getByRole('complementary', { name: 'Block settings' }).getByRole('textbox', { name: 'Section name' }).fill('Personal information');
  /* How the current section is marked is a form setting: Form settings → Sections → Look. */
  await page.getByRole('group', { name: 'Builder view' }).getByRole('button', { name: 'Form settings' }).click();
  await page.getByRole('tab', { name: 'Sections' }).click();
  await page.getByRole('combobox', { name: 'Current section' }).click();
  await page.getByRole('option', { name: 'Pulse', exact: true }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Form sections' });
  await expect(nav).toBeVisible();
  await expect(nav).toContainText('Personal information');
  await expect(nav.locator('[data-state="current"]')).toContainText('Personal information');
});

test('a 3-page form with a required field on page 3 advances from page 1', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: /^Drag & drop your first element/ }).click();
  await insert(page, '/short', /Short answer/);
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await label(page, 'Third');
  await expect(page.getByRole('separator', { name: 'Page break' })).toHaveCount(2);

  await openSettings(page, 2);
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByRole('button', { name: 'Required' }).click();

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
