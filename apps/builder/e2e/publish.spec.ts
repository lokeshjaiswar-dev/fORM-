import { expect, test } from './test.ts';
import { openNewForm } from './helpers.ts';
import { ME, USER, signInWithFormsApi } from './forms-api.ts';

/*
 * Publish is for signed-in members of an org, and so is the builder (BL-206): a visitor who is not signed in is sent to
 * sign in from /forms and /builder, and comes back to the page they asked for. The API is a stand-in here (the suites
 * without a stack see a signed-out visitor, e2e/forms-api.ts for the signed-in one); the real checks are the API's,
 * proved in apps/api/test/publish.int.test.ts, and the two-browser merge is drafts.stack.spec.ts.
 */

test('a signed-out visitor is sent to sign in from the forms list, and returns to it after signing in', async ({ page }) => {
  await page.goto('/forms');
  await expect(page).toHaveURL(/\/auth\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.route('**/v1/auth/login', (route) => route.fulfill({ json: { status: 'signed_in', user: USER } }));
  await signInWithFormsApi(page);
  await page.getByLabel('Email').fill(ME.user.email);
  await page.getByLabel('Password').fill('violet-anchor-teapot-91');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/forms$/);
  await expect(page.getByRole('button', { name: 'New form' })).toBeVisible();
});

test('the builder is behind sign-in too: a signed-out visitor never sees the form', async ({ page }) => {
  await page.goto('/builder/00000000-0000-4000-8000-000000000001');
  await expect(page).toHaveURL(/\/auth\/sign-in$/);
  await expect(page.getByPlaceholder('Form title')).toHaveCount(0);
});

test('a javascript: redirect blocks publish, and the issue is shown with nothing published', async ({ page }) => {
  const api = await signInWithFormsApi(page);
  const id = await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await page.getByPlaceholder('Type ‘/’ to insert blocks').fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  expect(api.forms.get(id)?.draft).toBeTruthy();

  // The builder will not type this in (its redirect field wants https), so it arrives the way an import or an API client sends it.
  api.editDraft(id, (draft) => ({
    ...draft,
    endings: [...(draft.endings as unknown[]), { id: 'end_redirect', kind: 'redirect', name: 'Go on', url: ['javascript:alert(1)'] }],
  }));
  await page.reload();
  await expect(page.getByPlaceholder('Form title')).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  const dialog = page.getByRole('dialog', { name: 'This form cannot be published yet' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('invalid_url_scheme');
  await expect(dialog).toContainText('the URL must start with https:// or http://');
  await expect(dialog.getByRole('button', { name: 'Publish anyway' })).toHaveCount(0);
  expect(api.called('POST', /\/publish$/)).toEqual([]);
  expect(api.called('POST', /\/validate$/)).toHaveLength(1);
  await expect(page.getByRole('dialog', { name: 'Share form' })).toHaveCount(0);
});

test('a form that passes the checks publishes with the draft revision and gets its share link', async ({ page }) => {
  const api = await signInWithFormsApi(page);
  await openNewForm(page);
  await page.getByRole('button', { name: 'Press Enter to start from scratch' }).click();
  await page.getByPlaceholder('Type ‘/’ to insert blocks').fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('dialog', { name: 'Share form' })).toBeVisible();
  const [publish] = api.called('POST', /\/publish$/);
  expect(publish?.body).toMatchObject({ expectedDraftRev: expect.any(Number), clientDefinitionHash: expect.stringMatching(/./) });
});
