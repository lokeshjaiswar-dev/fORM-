import { expect, test } from './test.ts';
import { openNewForm } from './helpers.ts';

test('selecting blocks adds no undo history', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  const insert = page.getByPlaceholder('Type ‘/’ to insert blocks');
  for (const text of ['First', 'Second']) {
    await insert.fill(text);
    await insert.press('Enter');
  }
  const first = page.getByText('First', { exact: true });
  const second = page.getByText('Second', { exact: true });
  await expect(second).toBeVisible();

  for (let i = 0; i < 10; i++) await (i % 2 ? first : second).click();
  /*
   * The toolbar's Undo, not Ctrl+Z: the shortcut only reaches the form from outside an editor, and the editor of the
   * last block clicked takes focus back after a save on a busy machine, so the key then goes to the editor and undoes nothing.
   */
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(first).toBeVisible();
  await expect(second).toBeHidden();
});
