import { expect, test, type Page } from '@playwright/test';
import { openNewForm, openSettings } from './helpers.ts';

test('New-form gallery: the five pack templates, instantiated with the network cut off', async ({ page }) => {
  await openNewForm(page);
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Start from a template' }).click();

  for (const title of ['Contact us', 'Customer feedback', 'NPS survey', 'Job application', 'Event registration']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();
  }
  await page.getByRole('button', { name: /^Job application/ }).click();
  await page.getByRole('button', { name: 'Replace this form' }).click();
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeHidden();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Apply to join the team' })).toBeVisible();
  /* The preview is @form/renderer (WP-0.10): a native select with the placeholder as its first option. */
  const role = page.getByRole('combobox', { name: 'Role (required)' });
  await expect(role).toBeVisible();
  await expect(role.locator('option:checked')).toHaveText('Choose a role');
  await expect(page.getByRole('button', { name: 'Resume (required)' })).toBeVisible();
  await page.getByPlaceholder('Your name').fill('Asha');
  await expect(page.getByText('Why do you want to join us?')).toBeVisible();
});

/** A page break right after the `n`-th block, from that block's insert menu. */
async function pageBreakAfter(page: Page, n: number) {
  await page.getByRole('button', { name: 'Insert block' }).nth(n).click();
  await page.keyboard.type('page');
  await page.getByRole('option', { name: 'Page break' }).click();
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

test('create from a template → three pages with a show rule → preview → submit', async ({ page }) => {
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await expect(page.getByRole('button', { name: /^Event registration/ })).toBeVisible();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: /^Event registration/ }).click();
  await page.getByRole('button', { name: 'Use template' }).click();
  await page.waitForURL(/\/builder\/[^/]+$/);
  await expect(page.getByPlaceholder('Form title')).toHaveValue('Event registration');

  /* heading, name, email | ticket, guests | date */
  await pageBreakAfter(page, 2);
  await pageBreakAfter(page, 4);
  await expect(page.getByRole('separator', { name: 'Page break' })).toHaveCount(2);

  /* Number of guests shows only for VIP tickets: a form-level rule with an option operand (D2: hidden until then). */
  await openSettings(page, 4);
  await page.getByRole('tab', { name: 'Logic' }).click();
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await expect(page.getByRole('button', { name: 'Ticket type' })).toBeVisible();
  await page.getByRole('radio', { name: 'VIP' }).check();
  await expect(page.getByText('Hidden until a rule shows it').first()).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const submissions = await recordSubmissions(page);
  await page.getByRole('textbox', { name: /Full name/ }).fill('Asha');
  await page.getByRole('textbox', { name: /Email/ }).fill('asha@example.com');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  /* The template's ticket question is a dropdown. */
  const ticket = page.getByRole('combobox', { name: /Ticket type/ });
  const guests = page.getByRole('spinbutton', { name: /Number of guests/ }).or(page.getByRole('textbox', { name: /Number of guests/ }));
  await ticket.selectOption('General admission');
  await expect(guests).toBeHidden();
  await ticket.selectOption('VIP');
  await expect(guests).toBeVisible();
  await guests.fill('2');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByText('Preferred date')).toBeVisible();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: /thank/i })).toBeVisible();

  const sent = await submissions();
  expect(sent).toHaveLength(1);
  const values = Object.values(sent[0]?.answers ?? {}).map((answer) => answer.value);
  expect(values).toEqual(['Asha', { address: 'asha@example.com' }, { optionId: 'ticket_vip' }, '2']);
});
