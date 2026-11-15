import type { Browser } from '@playwright/test';
import { expect, test, type Page } from './test.ts';
import { openNewForm } from './helpers.ts';
import { PASSWORD, mailLink, newEmail } from './stack.ts';
import { STACK_PORTS } from './stack-ports.ts';

/*
 * WP-1.06 end to end against the real API: the same member in two browsers edits one form. The one that saves second
 * is refused (409 on the draft revision) and gets the merge dialog instead of silently overwriting the other; keep mine
 * saves its version on top, take theirs loads the other's, and a reload shows the latest draft either way.
 */

test.use({ realApi: true });

const BASE_URL = `http://localhost:${STACK_PORTS.builder}`;
const TITLE = (page: Page) => page.getByPlaceholder('Form title');
const DIALOG = 'This form changed somewhere else';

/** Sign-up with an organisation name, then the emailed link: the browser ends signed in on the forms list, in that org. */
async function signUpWithOrg(page: Page, email: string): Promise<void> {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Your name').fill('Asha');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Organisation name (optional)').fill('Drafts E2E');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText(`We sent a link to ${email}`);
  await page.goto(await mailLink(email, '/auth/verify'));
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByRole('combobox', { name: 'Organisation' })).toContainText('Drafts E2E');
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/forms');
}

/** The title of the draft the server holds for form `id`, read as this browser's session (a different answer than the page shows when a save has not landed). */
async function serverTitle(page: Page, id: string): Promise<string> {
  const me = (await (await page.request.get('/v1/me')).json()) as { activeOrgId: string | null; orgs: Array<{ id: string }> };
  const org = me.activeOrgId ?? me.orgs[0]?.id ?? '';
  const res = await page.request.get(`/v1/forms/${id}/draft`, { headers: { 'x-fr-org': org } });
  if (!res.ok()) return '';
  return ((await res.json()) as { draft: { title: string } }).draft.title;
}

/**
 * The same member in two browsers, both with form `id` open at "Draft one". The first browser (`page`) then saves
 * "Draft two (A)". The second one (`other`) is still on the revision before it.
 */
async function twoBrowsers(page: Page, browser: Browser) {
  const email = newEmail();
  await signUpWithOrg(page, email);
  const id = await openNewForm(page);
  await TITLE(page).fill('Draft one');
  await expect.poll(() => serverTitle(page, id)).toBe('Draft one');

  const context = await browser.newContext({ baseURL: BASE_URL });
  const other = await context.newPage();
  await signIn(other, email);
  await other.goto(`/builder/${id}`);
  await expect(TITLE(other)).toHaveValue('Draft one');

  await TITLE(page).fill('Draft two (A)');
  await expect.poll(() => serverTitle(page, id)).toBe('Draft two (A)');
  return { id, other, context };
}

test('keep mine: the second browser to save gets the merge dialog, keeps its version, and a reload shows it', async ({ page, browser }) => {
  const { id, other, context } = await twoBrowsers(page, browser);

  await TITLE(other).fill('Draft two (B)');
  const dialog = other.getByRole('dialog', { name: DIALOG });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Form settings that differ' })).toContainText('Title');
  // Nothing was overwritten while the choice is open.
  expect(await serverTitle(other, id)).toBe('Draft two (A)');

  await dialog.getByRole('button', { name: 'Keep mine' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => serverTitle(other, id)).toBe('Draft two (B)');

  // The first browser still shows its own version until it loads again; then it has the latest draft.
  await page.reload();
  await expect(TITLE(page)).toHaveValue('Draft two (B)');
  await other.reload();
  await expect(TITLE(other)).toHaveValue('Draft two (B)');
  await context.close();
});

test('take theirs: the second browser loads the other version and nothing of its own is saved over it', async ({ page, browser }) => {
  const { id, other, context } = await twoBrowsers(page, browser);

  await TITLE(other).fill('Draft two (B)');
  const dialog = other.getByRole('dialog', { name: DIALOG });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Take theirs' }).click();
  await expect(dialog).toBeHidden();
  await expect(TITLE(other)).toHaveValue('Draft two (A)');

  // Give an autosave time to run: it must have nothing to send.
  await other.waitForTimeout(3000);
  expect(await serverTitle(other, id)).toBe('Draft two (A)');
  await other.reload();
  await expect(TITLE(other)).toHaveValue('Draft two (A)');
  await context.close();
});
