import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { insert, label, openNewForm, openSettings } from './helpers.ts';

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
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await insert(page, '/short', /Short answer/);
  await label(page, 'Attending');
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await label(page, 'Reason');
  await insert(page, '/page', /Page break/);
  await insert(page, '/short', /Short answer/);
  await label(page, 'City');

  await openSettings(page, 1);
  await page.getByRole('tab', { name: 'Validation' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();
  await page.getByRole('tab', { name: 'Logic' }).click();
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await expect(page.getByRole('button', { name: 'Attending' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Value' }).fill('yes');
  await expect(page.getByText('Hidden until a rule shows it').first()).toBeVisible();
  await openSettings(page, 2);
  await page.getByRole('tab', { name: 'Validation' }).click();
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
  /* About 13 s alone and close to the default 30 s under six workers (BL-146). */
  test.slow();
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  const fields: Array<[string, RegExp, string]> = [
    ['/short', /Short answer/, 'Full name'],
    ['/email', /Email/, 'Email address'],
    ['/phone', /Phone/, 'Phone number'],
    ['/long', /Long answer/, 'Comments'],
    ['/dropdown', /Dropdown/, 'Favourite colour'],
    ['/check', /Checkboxes/, 'Interests'],
    ['/rating', /Rating/, 'Rate us'],
    ['/nps', /Net Promoter Score/, 'Recommend us'],
    ['/rank', /Ranking/, 'Rank these'],
    ['/date', /Date/, 'Start date'],
    ['/file', /File upload/, 'Your CV'],
    ['/sign', /Signature/, 'Sign here'],
  ];
  for (const [command, option, text] of fields) {
    await insert(page, command, option);
    await label(page, text);
  }
  await openSettings(page, 0);
  await page.getByRole('tab', { name: 'Validation' }).click();
  await page.getByRole('switch', { name: 'Required' }).click();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('This field is required.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Full name/ })).toBeFocused();
  await expect(page.locator('.fr-root')).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
