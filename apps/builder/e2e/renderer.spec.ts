import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function insert(page: Page, command: string, option: RegExp) {
  await page.getByPlaceholder("Type '/' to insert blocks").fill(command);
  await page.getByRole('option', { name: option }).first().click();
}

/** Types a label into the last question editor. */
async function label(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Type a question' }).last();
  await editor.click();
  await page.keyboard.type(text);
  await page.evaluate('document.activeElement?.blur()');
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).include('.fr-root').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((v: { impact?: string | null }) => v.impact === 'serious' || v.impact === 'critical')
    .map((v: { id: string; nodes: Array<{ html: string }> }) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) }));
}

/** Collects the preview's submit payloads (PreviewPane dispatches each as a `form-preview-submit` event). */
async function recordSubmissions(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { submissions: unknown[] };
    w.submissions = [];
    window.addEventListener('form-preview-submit', (e) => void w.submissions.push((e as CustomEvent).detail));
  });
  return () => page.evaluate(() => (window as unknown as { submissions: Array<{ answers: Record<string, { type: string; value: unknown }> }> }).submissions);
}

test('three pages: logic hides a required field, the form submits, and the hidden answer is absent from onSubmit', async ({ page }) => {
  await page.goto('/builder/demo');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  await insert(page, '/short', /Short answer/);
  await label(page, 'Attending');
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await label(page, 'Reason');
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await label(page, 'City');

  await page.locator('button.size-6.cursor-grab').nth(2).click();
  await page.getByRole('button', { name: 'Validations' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();
  await page.getByRole('button', { name: 'Logic' }).click();
  await page.getByRole('switch', { name: 'Conditional logic' }).click();
  await page.getByRole('button', { name: 'Select a question' }).click();
  await page.getByRole('button', { name: 'Attending' }).click();
  await page.getByRole('complementary').getByRole('textbox').last().fill('yes');
  await page.locator('button.size-6.cursor-grab').nth(4).click();
  await page.getByRole('button', { name: 'Validations' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const submissions = await recordSubmissions(page);
  await page.getByRole('textbox', { name: 'Attending' }).fill('yes');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /Reason/ })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('This field is required.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: /Reason/ }).fill('Keynote');

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Attending' }).fill('no');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /Reason/ })).toBeHidden();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('textbox', { name: /City/ }).fill('Pune');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thanks for your response!' })).toBeVisible();

  const sent = await submissions();
  expect(sent).toHaveLength(1);
  const values = Object.values(sent[0]?.answers ?? {}).map((answer) => answer.value);
  expect(values.sort()).toEqual(['Pune', 'no']);
  expect(JSON.stringify(sent[0])).not.toContain('Keynote');
});

test('the preview has no serious or critical axe violations, before and after validation', async ({ page }) => {
  await page.goto('/builder/demo');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  const fields: Array<[string, RegExp, string]> = [
    ['/short', /Short answer/, 'Full name'],
    ['/email', /Email/, 'Email address'],
    ['/phone', /Phone/, 'Phone number'],
    ['/long', /Long answer/, 'Comments'],
    ['/dropdown', /Dropdown/, 'Favourite colour'],
    ['/check', /Checkboxes/, 'Interests'],
    ['/rating', /Rating/, 'Rate us'],
    ['/nps', /NPS/, 'Recommend us'],
    ['/rank', /Ranking/, 'Rank these'],
    ['/date', /Date/, 'Start date'],
    ['/file', /File upload/, 'Your CV'],
    ['/sign', /Signature/, 'Sign here'],
  ];
  for (const [command, option, text] of fields) {
    await insert(page, command, option);
    await label(page, text);
  }
  await page.locator('button.size-6.cursor-grab').first().click();
  await page.getByRole('button', { name: 'Validations' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('This field is required.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Full name/ })).toBeFocused();
  expect(await seriousViolations(page)).toEqual([]);
});
