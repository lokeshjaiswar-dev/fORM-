import { expect, test, type Page } from './test.ts';
import { newEmail, PASSWORD, signUpAndVerify, totp } from './stack.ts';

/*
 * WP-1.01 acceptance, end to end in Chromium against the real API (playwright.stack.config.ts): sign-up → verify →
 * 2FA enrol → sign out → TOTP sign-in → recovery-code sign-in; cross-site and header-less POSTs are refused; Google
 * sign-in through a mock OpenID provider. Mail goes through Mailpit.
 */

test.use({ realApi: true });

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('sign-up → verify → 2FA enrol → sign out → TOTP sign-in → recovery-code sign-in', async ({ page }) => {
  const email = newEmail();
  await signUpAndVerify(page, email);

  // Enrol: the QR code and the key, a code from the "app", then the recovery codes, shown once.
  await page.getByRole('link', { name: 'Security' }).click();
  await page.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = await page.getByLabel('Setup key').inputValue();
  await page.getByLabel('Code from the app').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const items = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(items).toHaveCount(10);
  const codes = await items.allTextContents();
  await page.getByRole('button', { name: 'I saved them' }).click();
  await expect(page.getByText('Two-factor sign-in is on.')).toBeVisible();

  // Sign out, then sign in with the password and a TOTP code (the next step: the enrolment used this one).
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/auth/sign-in');
  await signIn(page, email);
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
  await page.getByLabel('Authentication code').fill(totp(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByRole('navigation', { name: 'Account' })).toContainText(email);

  // Sign out from the forms list, then sign in with a recovery code.
  await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await signIn(page, email);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByText('9 recovery codes left')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account' })).toContainText(email);

  // The used recovery code is spent.
  await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('used already');
});

test('a cross-site form POST and a header-less fetch are both refused, and the session stays', async ({ page, baseURL }) => {
  const email = newEmail();
  await signUpAndVerify(page, email);

  // A page on another site submits a form to the API, as an attacker's page would. A cross-site top-level POST does
  // not carry the SameSite=Lax cookie, so this is the guard on cookie-less /v1/auth requests (login CSRF) refusing.
  const attacker = await page.context().newPage();
  await attacker.goto('about:blank');
  const refused = attacker.waitForResponse((r) => r.url().endsWith('/v1/auth/logout'));
  await attacker.evaluate((action) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    document.body.append(form);
    form.submit();
  }, `${baseURL}/v1/auth/logout`);
  const res = await refused;
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
  await attacker.close();

  // The cookie branch: a same-origin fetch that carries the session cookie but not the builder header.
  const status = await page.evaluate(async () => (await fetch('/v1/auth/logout', { method: 'POST', credentials: 'include' })).status);
  expect(status).toBe(403);

  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Account' })).toContainText(email);
});

test('Continue with Google signs in through the provider (SaaS)', async ({ page }) => {
  await page.goto('/auth/sign-in');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByRole('navigation', { name: 'Account' })).toContainText('ravi.google@example.test');
});
