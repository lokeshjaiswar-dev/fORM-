import { expect, test } from '@playwright/test';
import { insert, label, openNewForm } from './helpers.ts';

test('insert Short answer, preview, fill and submit', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await insert(page, '/short', /Short answer/);
  await label(page, 'Your name');

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Asha');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Thanks for your response!' })).toBeVisible();
});

test('BL-139: the mobile device frame gets the narrow layout (container queries, not the viewport)', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await insert(page, '/short', /Short answer/);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const padding = () => page.locator('.fr-form').evaluate((el) => getComputedStyle(el).paddingLeft);
  await expect(page.locator('.fr-form')).toBeVisible();
  expect(await padding()).not.toBe('16px');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect.poll(padding).toBe('16px');
});

test('the renderer root takes its host width as a flex item, not its content width (inline-size container)', async ({ page }) => {
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await insert(page, '/short', /Short answer/);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.fr-form')).toBeVisible();
  const widths = await page.locator('.fr-root').evaluate((root) => {
    const host = root.parentElement as HTMLElement;
    host.style.display = 'flex';
    host.style.flexDirection = 'row';
    const style = getComputedStyle(host);
    return { root: root.getBoundingClientRect().width, host: host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
  expect(widths.root).toBeGreaterThan(0);
  expect(Math.abs(widths.root - widths.host)).toBeLessThan(1);
});
