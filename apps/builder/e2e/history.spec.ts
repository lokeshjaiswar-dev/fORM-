import { expect, test } from '@playwright/test';
import { openNewForm } from './helpers.ts';

test('selecting blocks adds no undo history', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  const insert = page.getByPlaceholder("Type '/' to insert blocks");
  for (const text of ['First', 'Second']) {
    await insert.fill(text);
    await insert.press('Enter');
  }
  const first = page.getByText('First', { exact: true });
  const second = page.getByText('Second', { exact: true });
  await expect(second).toBeVisible();

  for (let i = 0; i < 10; i++) await (i % 2 ? first : second).click();
  await page.evaluate('document.activeElement?.blur()');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(first).toBeVisible();
  await expect(second).toBeHidden();
});
