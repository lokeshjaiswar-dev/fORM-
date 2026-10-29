import { expect, test, type Page } from './test.ts';
import { mailLink } from './stack.ts';

/*
 * WP-1.02 end to end against the real API: create an org with the en-IN defaults, invite by email, accept the invite
 * through sign-up (the link waits through the verification email), see the member, change their role.
 */

test.use({ realApi: true });

const PASSWORD = 'violet-anchor-teapot-91';
const newEmail = (who: string) => `e2e-${who}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

async function signUp(page: Page, email: string, name: string): Promise<void> {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText(`We sent a link to ${email}`);
  await page.goto(await mailLink(email, '/auth/verify'));
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
}

test('create an org → invite → accept through sign-up → change the role', async ({ page, browser }) => {
  const ownerEmail = newEmail('owner');
  await signUp(page, ownerEmail, 'Asha');
  await page.waitForURL('**/forms');

  await page.getByRole('link', { name: 'Create an organisation' }).click();
  await expect(page.getByLabel('Language')).toHaveValue('en-IN');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Kolkata');
  await expect(page.getByLabel('Date format')).toHaveValue('DD-MM-YYYY');
  await page.getByLabel('Organisation name').fill('Acme E2E');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL('**/org/members');
  await expect(page.getByRole('heading', { name: 'Members of Acme E2E' })).toBeVisible();
  await expect(page.getByLabel('Organisation', { exact: true })).toHaveValue(/.+/);

  const inviteeEmail = newEmail('invitee');
  await page.getByLabel('Email address').fill(inviteeEmail);
  await page.getByLabel('Role', { exact: true }).selectOption('viewer');
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText(`Invitation emailed to ${inviteeEmail}`)).toBeVisible();

  // The invitee, in their own browser, follows the emailed link before they have an account.
  const other = await browser.newContext();
  const invitee = await other.newPage();
  await invitee.goto(await mailLink(inviteeEmail, '/invite'));
  await expect(invitee.getByText(`Asha invited ${inviteeEmail} to Acme E2E as Viewer.`)).toBeVisible();
  await invitee.getByRole('button', { name: `No account yet? Create one with ${inviteeEmail}` }).click();
  await signUp(invitee, inviteeEmail, 'Ravi');
  await invitee.waitForURL('**/invite');
  await invitee.getByRole('button', { name: 'Join Acme E2E' }).click();
  await invitee.waitForURL('**/org/members');
  await expect(invitee.getByRole('heading', { name: 'Members of Acme E2E' })).toBeVisible();
  await expect(invitee.getByRole('button', { name: 'Invite' })).toHaveCount(0);

  await page.reload();
  const role = page.getByLabel(`Role of ${inviteeEmail}`);
  await expect(role).toHaveValue('viewer');
  await role.selectOption('editor');
  await expect(page.getByLabel(`Role of ${inviteeEmail}`)).toHaveValue('editor');
  await other.close();
});
