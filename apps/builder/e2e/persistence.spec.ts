import { expect, test, type Page } from './test.ts';
import { openNewForm } from './helpers.ts';

async function startWithShortAnswer(page: Page) {
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  await page.getByPlaceholder('Type ‘/’ to insert blocks').fill('/short');
  await page.getByRole('option', { name: /Short answer/ }).click();
}

test('reload restores the form from IndexedDB, and the forms list shows it', async ({ page }) => {
  await openNewForm(page);
  await page.getByPlaceholder('Form title').fill('Saved form');
  await page.getByRole('button', { name: 'Press Enter to start building' }).click();
  const insert = page.getByPlaceholder('Type ‘/’ to insert blocks');
  await insert.fill('Persisted text');
  await insert.press('Enter');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByPlaceholder('Form title')).toHaveValue('Saved form');
  await expect(page.getByText('Persisted text', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Forms' }).click();
  await expect(page).toHaveURL(/\/forms$/);
  await expect(page.getByRole('link', { name: /Saved form/ })).toBeVisible();
});

test('the URL and the mode follow each other, Back and Forward included (B23)', async ({ page }) => {
  const id = await openNewForm(page);
  await startWithShortAnswer(page);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/builder/${id}/preview$`));
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/builder/${id}$`));
  await expect(page.getByPlaceholder('Type ‘/’ to insert blocks')).toBeVisible();

  await page.goForward();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a v1 import opens as a new form with its notes', async ({ page }) => {
  await page.goto('/forms');
  const v1 = {
    id: 'demo',
    title: 'Imported survey',
    description: '',
    blocks: [{ id: 'name', type: 'text', label: 'Your name', order: 0 }],
    settings: { redirectUrl: 'http://example.com/thanks' },
  };
  await page.getByLabel('v1 JSON file').setInputFiles({ name: 'survey.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v1)) });
  await page.waitForURL(/\/builder\/[^/]+$/);
  expect(page.url()).not.toContain('/builder/demo');
  await expect(page.getByPlaceholder('Form title')).toHaveValue('Imported survey');
  const notes = page.getByRole('region', { name: 'Form notes' });
  await notes.getByRole('button', { name: 'Show' }).click();
  await expect(notes).toContainText('the redirect URL is not https');
  await expect(notes).toContainText('a missing value took its default');

  /* The import was migrated once and stored as v2 (BL-143): a reload opens it as it is, with nothing left to note. */
  await page.reload();
  await expect(page.getByPlaceholder('Form title')).toHaveValue('Imported survey');
  await expect(page.getByRole('region', { name: 'Form notes' })).toBeHidden();
});

test('a second tab on the same form shows a warning', async ({ page, context }) => {
  await openNewForm(page);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByRole('alert')).toContainText('also open in another tab');
  await expect(page.getByRole('alert')).toContainText('also open in another tab');

  await other.getByPlaceholder('Form title').fill('Changed elsewhere');
  await expect(page.getByRole('alert')).toContainText('changed in another tab');
});
