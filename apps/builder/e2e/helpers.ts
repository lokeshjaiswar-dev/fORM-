import { expect, type Page } from '@playwright/test';

/** Starts a new, blank form from the forms list (New form → Start from scratch) and waits for the builder at its own id; returns the id. */
export async function openNewForm(page: Page): Promise<string> {
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByRole('button', { name: 'Start from scratch' }).click();
  await page.waitForURL(/\/builder\/[^/]+$/);
  await expect(page.getByPlaceholder('Form title')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

/** Hovers the `n`-th block on the canvas so its margin controls (drag handle, insert, menu) take the pointer. */
export async function hoverBlock(page: Page, n: number) {
  const block = page.locator('[data-block-id]').nth(n);
  await block.hover();
  return block;
}

/** Turns the section navigator on (Form settings → Sections), which offers the Section break block, then returns to Edit. */
export async function enableSections(page: Page) {
  const views = page.getByRole('group', { name: 'Builder view' });
  await views.getByRole('button', { name: 'Form settings' }).click();
  await page.getByRole('tab', { name: 'Sections' }).click();
  await page.getByRole('switch', { name: 'Section break' }).click();
  await views.getByRole('button', { name: 'Edit', exact: true }).click();
}

/** Inserts a palette entry from the slash menu on the insert line. */
export async function insert(page: Page, command: string, option: RegExp) {
  await page.getByPlaceholder('Type ‘/’ to insert blocks').fill(command);
  await page.getByRole('option', { name: option }).first().click();
}

/** Replaces the label of the last question editor (a new field starts with its type's name as the label). */
export async function label(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Type a question' }).last();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.evaluate('document.activeElement?.blur()');
}

/** Opens the settings of the `n`-th block on the canvas (a click on its drag handle). */
export async function openSettings(page: Page, n: number) {
  const block = await hoverBlock(page, n);
  await block.getByRole('button', { name: 'Drag to reorder · click for settings' }).click();
}
