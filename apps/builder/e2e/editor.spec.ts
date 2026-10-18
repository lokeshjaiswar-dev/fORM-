import { expect, test } from '@playwright/test';

test('typing and formatting a label reaches the preview as safe elements', async ({ page }) => {
  await page.goto('/builder/demo');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  await page.getByPlaceholder("Type '/' to insert blocks").fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();

  const label = page.getByRole('textbox', { name: 'Type a question' });
  await label.click();
  await page.keyboard.type('Your ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('full');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type(' name');
  await expect(label).toHaveText('Your full name');

  await page.evaluate('document.activeElement?.blur()');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('label strong')).toHaveText('full');
  await expect(page.locator('label').filter({ hasText: 'Your full name' })).toBeVisible();
});
