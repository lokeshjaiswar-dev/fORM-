import { editionSummary, loadEditionConfig } from '@form/config';
import { expect, test } from './test.ts';

/*
 * The sign-in pages under the production CSP, with the API mocked (the full flow against the real API is
 * auth.stack.spec.ts). Google and Microsoft sign-in are SaaS only and hidden when the edition is air-gapped (WP-1.01).
 */

const offered = { password: true, emailLinks: true, oauth: ['google', 'microsoft'] };

test.describe('SaaS', () => {
  test('offers Google and Microsoft when the server does', async ({ page }) => {
    await page.route('**/v1/auth/methods', (route) => route.fulfill({ json: offered }));
    await page.goto('/auth/sign-in');
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/v1/auth/oauth/google/start');
    await expect(page.getByRole('link', { name: 'Continue with Microsoft' })).toBeVisible();
  });
});

test.describe('air-gapped', () => {
  test.use({ edition: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' })) });

  test('hides OAuth sign-in even if a server offered it', async ({ page }) => {
    await page.route('**/v1/auth/methods', (route) => route.fulfill({ json: offered }));
    await page.goto('/auth/sign-in');
    await expect(page.getByRole('note', { name: 'Edition' })).toHaveText('On-premises · air-gapped');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Continue with/ })).toHaveCount(0);
  });
});

test('the forms list offers sign-in to a signed-out visitor', async ({ page }) => {
  await page.goto('/forms');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('link', { name: 'Create one' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});

test('sends a verification link back to the second factor when the account has TOTP on', async ({ page }) => {
  await page.route('**/v1/auth/link', (route) => route.fulfill({ json: { email: 'asha@example.test', passwordRequired: false } }));
  await page.route('**/v1/auth/verify-email', (route) => route.fulfill({ json: { status: 'mfa_required', ticket: 't'.repeat(43), methods: ['totp', 'recovery'] } }));
  await page.goto(`/auth/verify#token=${'v'.repeat(43)}`);
  await page.getByRole('button', { name: 'Continue as asha@example.test' }).click();
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
});
