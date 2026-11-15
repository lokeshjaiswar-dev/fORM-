import type { Browser, Page } from '@playwright/test';
import { expect, test } from './test.ts';
import { insert, label, openNewForm } from './helpers.ts';
import { PASSWORD, mailLink, newEmail } from './stack.ts';
import { STACK_PORTS } from './stack-ports.ts';

/*
 * WP-1.15 end to end against the real API, Postgres and search index: two people fill the published form, the member
 * finds the responses in the grid, searches them, moves one to the trash, and restores it. The grid, the search, the
 * bulk call and the folders are the API's own (apps/api/test/submissions.int.test.ts proves their contracts); this is
 * the page on top of them. Needs the search index in the e2e stack (apps/api/test/e2e-stack.ts) and the search
 * document the submit pipeline writes (WP-1.12).
 */

test.use({ realApi: true });

const BASE_URL = `http://localhost:${STACK_PORTS.builder}`;

/** Sign-up with an organisation name, then the emailed link: the browser ends signed in on the forms list. */
async function signUpWithOrg(page: Page, email: string): Promise<void> {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Your name').fill('Asha');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Organisation name (optional)').fill('Responses E2E');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText(`We sent a link to ${email}`);
  await page.goto(await mailLink(email, '/auth/verify'));
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByRole('combobox', { name: 'Organisation' })).toContainText('Responses E2E');
}

/** A form with one short-answer question, published: its id, and the link a respondent opens. */
async function publishForm(page: Page): Promise<{ id: string; link: string }> {
  const id = await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await insert(page, '/short', /Short answer/);
  await label(page, 'Your name');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  const share = page.getByRole('dialog', { name: 'Share form' });
  await expect(share).toBeVisible();
  return { id, link: await share.getByRole('textbox', { name: 'Share link' }).inputValue() };
}

/** A respondent who is not signed in fills the published form once. */
async function respond(browser: Browser, link: string, name: string): Promise<void> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const respondent = await context.newPage();
    await respondent.goto(link);
    await respondent.getByLabel('Your name').fill(name);
    const posted = respondent.waitForResponse((res) => res.request().method() === 'POST' && /\/v1\/p\/[^/]+\/submissions$/.test(new URL(res.url()).pathname));
    await respondent.getByRole('button', { name: 'Submit' }).click();
    expect((await posted).ok()).toBe(true);
  } finally {
    await context.close();
  }
}

test('public submit → the row appears → search finds it → trash → restore', async ({ page, browser }) => {
  await signUpWithOrg(page, newEmail());
  const { id, link } = await publishForm(page);
  await respond(browser, link, 'Asha Rao');
  await respond(browser, link, 'Dev Patel');

  await page.goto(`/forms/${id}/responses`);
  const grid = page.getByRole('table', { name: 'Responses' });
  const rowOf = (name: string) => grid.getByRole('row').filter({ hasText: name });
  await expect(grid.getByRole('columnheader', { name: 'Your name' })).toBeVisible();
  await expect(rowOf('Asha Rao')).toHaveCount(1);
  await expect(rowOf('Dev Patel')).toHaveCount(1);

  // Search narrows the list to the response whose answer has the word, and an unmatched word to nothing.
  const search = page.getByRole('searchbox', { name: 'Search responses' });
  await search.fill('Patel');
  await expect(rowOf('Dev Patel')).toHaveCount(1);
  await expect(rowOf('Asha Rao')).toHaveCount(0);
  await search.fill('nobody-by-this-name');
  await expect(page.getByText('No responses match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rowOf('Asha Rao')).toHaveCount(1);

  // Opening a response shows it in the pane and marks it read.
  await expect(rowOf('Dev Patel')).toHaveAttribute('data-unread', 'true');
  await rowOf('Dev Patel').getByRole('button').last().click();
  await expect(page.getByRole('complementary', { name: 'Response' })).toContainText('Dev Patel');
  await expect(rowOf('Dev Patel')).not.toHaveAttribute('data-unread', 'true');
  await page.getByRole('button', { name: 'Close response' }).click();

  // Trash moves it out of the inbox, into the Trash tab; restore brings it back.
  await rowOf('Dev Patel').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(rowOf('Dev Patel')).toHaveCount(0);
  await expect(rowOf('Asha Rao')).toHaveCount(1);

  await page.getByRole('tab', { name: 'Trash' }).click();
  await expect(rowOf('Dev Patel')).toHaveCount(1);
  await expect(rowOf('Asha Rao')).toHaveCount(0);
  await rowOf('Dev Patel').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('The trash is empty.', { exact: false })).toBeVisible();

  await page.getByRole('tab', { name: 'Inbox' }).click();
  await expect(rowOf('Dev Patel')).toHaveCount(1);
  await expect(rowOf('Asha Rao')).toHaveCount(1);
});
