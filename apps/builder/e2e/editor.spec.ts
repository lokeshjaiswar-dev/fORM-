import { expect, test } from '@playwright/test';
import { openNewForm } from './helpers.ts';

test('typing and formatting a label reaches the preview as safe elements', async ({ page }) => {
  await openNewForm(page);
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

test('copy and paste between labels keeps formatting the strict paste rules drop', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  for (let i = 0; i < 2; i += 1) {
    await page.getByPlaceholder("Type '/' to insert blocks").fill('/short');
    await page.getByRole('option', { name: /Short answer/ }).click();
  }

  const labels = page.getByRole('textbox', { name: 'Type a question' });
  await labels.nth(0).click();
  await page.keyboard.type('Plain ');
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await page.keyboard.type('struck');
  await expect(labels.nth(0).locator('s')).toHaveText('struck');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');

  await labels.nth(1).click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(labels.nth(1)).toHaveText('Plain struck');
  await expect(labels.nth(1).locator('s')).toHaveText('struck');
});
