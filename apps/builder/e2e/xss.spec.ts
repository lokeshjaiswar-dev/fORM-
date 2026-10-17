import { expect, test } from '@playwright/test';

const payload = '<img src=x onerror=alert(1)>';

test('a typed label never runs script in the builder or preview', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto('/builder/demo');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  const insert = page.getByPlaceholder("Type '/' to insert blocks");
  await insert.fill(payload);
  await insert.press('Enter');
  await expect(page.getByText(payload)).toBeVisible();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await expect(page.getByText(payload)).toBeVisible();
  await page.waitForTimeout(500);

  expect(dialogs).toEqual([]);
});
