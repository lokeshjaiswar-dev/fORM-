import { expect, type Page } from '@playwright/test';

/** Starts a new, blank form from the forms list (New form → Blank form) and waits for the builder at its own id; returns the id. */
export async function openNewForm(page: Page): Promise<string> {
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByRole('button', { name: /Blank form/ }).click();
  await page.waitForURL(/\/builder\/[^/]+$/);
  await expect(page.getByPlaceholder('Form title')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

/** Inserts a palette entry from the slash menu on the insert line. */
export async function insert(page: Page, command: string, option: RegExp) {
  await page.getByPlaceholder('Type ‘/’ to insert blocks').fill(command);
  await page.getByRole('option', { name: option }).first().click();
}

/** Types a label into the last question editor. */
export async function label(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Type a question' }).last();
  await editor.click();
  await page.keyboard.type(text);
  await page.evaluate('document.activeElement?.blur()');
}

/** Opens the settings of the `n`-th block on the canvas (its drag handle). */
export async function openSettings(page: Page, n: number) {
  await page.locator('button.size-6.cursor-grab').nth(n).click();
}
