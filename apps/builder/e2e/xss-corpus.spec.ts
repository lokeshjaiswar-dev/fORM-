/// <reference lib="dom" />
import { expect, test, type Page } from './test.ts';
import { XSS_PAYLOADS } from '@form/schema/test-fixtures';
import { openNewForm } from './helpers.ts';

/** Every handler attribute and script-capable URL in the live DOM, plus any open dialog element. */
function sinks(page: Page) {
  return page.evaluate(() => {
    const handlers: string[] = [];
    const urls: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        if (attr.name.startsWith('on')) handlers.push(`${el.tagName}[${attr.name}]`);
        if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(attr.name) && /^\s*(javascript|data|vbscript):/i.test(attr.value)) urls.push(attr.value);
      }
    }
    return { handlers, urls, dialogs: document.querySelectorAll('dialog, iframe, object, embed').length };
  });
}

test('the XSS corpus pasted into the editors never runs, in the builder or the preview', async ({ page }) => {
  expect(XSS_PAYLOADS.length).toBeGreaterThanOrEqual(150);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  const insert = page.getByPlaceholder('Type ‘/’ to insert blocks');
  await insert.fill('Paragraph');
  await insert.press('Enter');
  await insert.fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();
  const editors = page.locator('.ProseMirror');
  await expect(editors).toHaveCount(2);

  await page.evaluate((payloads) => {
    const targets = [...document.querySelectorAll<HTMLElement>('.ProseMirror')];
    payloads.forEach((html, i) => {
      const target = targets[i % targets.length];
      if (!target) return;
      target.focus();
      const data = new DataTransfer();
      data.setData('text/html', html);
      data.setData('text/plain', html);
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
  }, XSS_PAYLOADS);

  await expect(page.locator('body')).toContainText('deep quote');
  await expect(page.locator('body')).toContainText('custom element');
  expect(await sinks(page)).toEqual({ handlers: [], urls: [], dialogs: 0 });

  await page.evaluate('document.activeElement?.blur()');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await expect(page.getByText('deep quote')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await sinks(page)).toEqual({ handlers: [], urls: [], dialogs: 0 });
  expect(dialogs).toEqual([]);
});
