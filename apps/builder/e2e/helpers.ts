import { expect, type Page } from '@playwright/test';

/** Starts a new, empty form from the forms list and waits for the builder at its own id; returns the id. */
export async function openNewForm(page: Page): Promise<string> {
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.waitForURL(/\/builder\/[^/]+$/);
  await expect(page.getByPlaceholder('Form title')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}
