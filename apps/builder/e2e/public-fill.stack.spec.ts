import type { Page } from '@playwright/test';
import { expect, test } from './test.ts';
import { insert, label, openNewForm } from './helpers.ts';
import { PASSWORD, mailLink, newEmail } from './stack.ts';
import { STACK_PORTS } from './stack-ports.ts';

/*
 * WP-1.07 end to end against the real API: an author protects a form with a password in the Access section, publishes
 * it, and a visitor with no account (a separate browser context, nothing shared with the author's session) opens the
 * public link. The form's questions are withheld until the password is unlocked on the server; a wrong password is
 * refused; the right one opens the form, and the visitor fills it in and submits. The response then shows in the author's
 * responses. The password is only ever typed into the Access panel and the prompt: it is not in the builder's browser
 * storage afterwards (BL-145).
 */

test.use({ realApi: true });

const BASE_URL = `http://localhost:${STACK_PORTS.builder}`;
const FORM_PASSWORD = 'maple-lantern-orbit-47';

/** Sign-up with an organisation name, then the emailed link: the browser ends signed in on the forms list. */
async function signUpWithOrg(page: Page, email: string): Promise<void> {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Your name').fill('Asha');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Organisation name (optional)').fill('Public Fill E2E');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText(`We sent a link to ${email}`);
  await page.goto(await mailLink(email, '/auth/verify'));
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByRole('combobox', { name: 'Organisation' })).toContainText('Public Fill E2E');
}

/** Everything this browser keeps in IndexedDB (the builder's offline cache), as one string. */
async function indexedDbDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: unknown[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        out.push({ name, store, rows });
      }
      db.close();
    }
    return JSON.stringify(out);
  });
}

test('password form: the visitor cannot see the questions, a wrong password is refused, the right one opens the form and a submit lands in the responses', async ({ page, browser }) => {
  await signUpWithOrg(page, newEmail());
  const id = await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await insert(page, '/short', /Short answer/);
  await label(page, 'Full name');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // The Access section is in the Submit settings. The password goes to the server once and is never shown again.
  await page.getByRole('button', { name: 'Form settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Form settings' });
  await settings.getByRole('tab', { name: 'Submit' }).click();
  await expect(settings.getByRole('switch', { name: 'Close form' })).toBeVisible();
  await settings.getByLabel('Password', { exact: true }).fill(FORM_PASSWORD);
  await settings.getByRole('button', { name: 'Set password' }).click();
  await expect(settings.getByText('Password set')).toBeVisible();
  await expect(settings.getByLabel('Password', { exact: true })).toHaveValue('');
  expect(await page.content()).not.toContain(FORM_PASSWORD);
  expect(await indexedDbDump(page)).not.toContain(FORM_PASSWORD);

  await page.getByRole('button', { name: 'Publish' }).click();
  const share = page.getByRole('dialog', { name: 'Share form' });
  await expect(share).toBeVisible();
  const link = await share.getByRole('textbox', { name: 'Share link' }).inputValue();
  expect(link).toMatch(/\/f\/[^/]+$/);

  // A visitor: another browser context, so nothing of the author's session is there.
  const context = await browser.newContext({ baseURL: BASE_URL });
  const visitor = await context.newPage();
  await visitor.goto(link);
  await expect(visitor.getByLabel('Password')).toBeVisible();
  await expect(visitor.getByRole('textbox', { name: /Full name/ })).toHaveCount(0);

  await visitor.getByLabel('Password').fill('not-the-password-12');
  await visitor.getByRole('button', { name: 'Continue' }).click();
  await expect(visitor.getByRole('alert')).toContainText('That password is not right');
  await expect(visitor.getByRole('textbox', { name: /Full name/ })).toHaveCount(0);

  await visitor.getByLabel('Password').fill(FORM_PASSWORD);
  await visitor.getByRole('button', { name: 'Continue' }).click();
  const name = visitor.getByRole('textbox', { name: /Full name/ });
  await expect(name).toBeVisible();
  await name.fill('Ravi Kumar');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByText('Thanks for your response!')).toBeVisible();

  // The response is the author's to read: the grid of the form has it.
  const me = (await (await page.request.get('/v1/me')).json()) as { activeOrgId: string | null; orgs: Array<{ id: string }> };
  const org = me.activeOrgId ?? me.orgs[0]?.id ?? '';
  await expect
    .poll(async () => {
      const res = await page.request.get(`/v1/forms/${id}/submissions`, { headers: { 'x-fr-org': org } });
      return res.ok() ? ((await res.json()) as { items: unknown[] }).items.length : -1;
    })
    .toBe(1);

  // The password is the visitor's to know, not something the builder keeps: still nowhere in the author's browser.
  expect(await indexedDbDump(page)).not.toContain(FORM_PASSWORD);
  await context.close();
});
