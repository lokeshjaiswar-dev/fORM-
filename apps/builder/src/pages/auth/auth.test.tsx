import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { editionSummary, loadEditionConfig } from '@form/config';
import { useSessionStore } from '@/auth/client';
import { useEditionStore } from '@/edition/edition';
import { MagicLinkPage, VerifyEmailPage } from './LinkPages';
import { MfaPage } from './MfaPage';
import { ResetPasswordPage } from './PasswordPages';
import { SecurityPage } from './SecurityPage';
import { SignInPage } from './SignInPage';
import { SignUpPage } from './SignUpPage';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };
const ME = { user: USER, session: { id: 's1', mfaLevel: 'pwd', expiresAt: '2026-11-02T00:00:00Z' }, orgs: [] };

let calls: Call[];
let answers: Record<string, (body: unknown) => { status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  answers = {
    'GET /v1/auth/methods': () => ({ status: 200, body: { password: true, emailLinks: true, oauth: ['google', 'microsoft'] } }),
    'GET /v1/me': () => ({ status: 200, body: ME }),
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, credentials: init.credentials, body });
    const answer = answers[`${method} ${url}`]?.(body) ?? { status: 404, body: { code: 'NOT_FOUND', detail: 'no route' } };
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': answer.status < 400 ? 'application/json' : 'application/problem+json' },
    });
  });
  useSessionStore.setState({ status: 'unknown' }, true);
  useEditionStore.setState({ summary: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' })), source: 'server' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  const l = useLocation();
  return <span aria-label="path">{`${l.pathname}${l.hash}`}</span>;
}

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth/sign-in" element={<SignInPage />} />
        <Route path="/auth/sign-up" element={<SignUpPage />} />
        <Route path="/auth/verify" element={<VerifyEmailPage />} />
        <Route path="/auth/magic" element={<MagicLinkPage />} />
        <Route path="/auth/mfa" element={<MfaPage />} />
        <Route path="/auth/reset" element={<ResetPasswordPage />} />
        <Route path="/account/security" element={<SecurityPage />} />
        <Route path="/forms" element={<p>forms list</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const path = () => screen.getByLabelText('path').textContent;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('sign-in', () => {
  it('signs in with credentials and the builder header, then opens the forms', async () => {
    answers['POST /v1/auth/login'] = () => ({ status: 200, body: { status: 'signed_in', user: USER } });
    at('/auth/sign-in');
    type('Email', 'asha@example.test');
    type('Password', 'violet-anchor-teapot-91');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('forms list');
    const login = calls.find((c) => c.url === '/v1/auth/login')!;
    expect(login).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'x-fr-client': 'builder' }, body: { email: 'asha@example.test', password: 'violet-anchor-teapot-91' } });
    expect(useSessionStore.getState()).toMatchObject({ status: 'signed_in', me: { user: { email: 'asha@example.test' } } });
  });

  it('goes to the second factor with the ticket and shows the server’s refusal', async () => {
    answers['POST /v1/auth/login'] = () => ({ status: 200, body: { status: 'mfa_required', ticket: 't'.repeat(43), methods: ['totp', 'recovery'] } });
    answers['POST /v1/auth/mfa/totp'] = (b) =>
      (b as { code: string }).code === '123456' ? { status: 200, body: { status: 'signed_in', user: USER } } : { status: 401, body: { code: 'INVALID_CODE', detail: 'That code is not right.' } };
    at('/auth/sign-in');
    type('Email', 'asha@example.test');
    type('Password', 'pw');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Enter the 6-digit code from your authenticator app.');
    type('Authentication code', '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.');
    type('Authentication code', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByText('forms list');
    expect(calls.filter((c) => c.url === '/v1/auth/mfa/totp').map((c) => c.body)).toEqual([
      { ticket: 't'.repeat(43), code: '000000' },
      { ticket: 't'.repeat(43), code: '123456' },
    ]);
  });

  it('switches to a recovery code', async () => {
    answers['POST /v1/auth/mfa/recovery'] = () => ({ status: 200, body: { status: 'signed_in', user: USER, recoveryCodesLeft: 9 } });
    at('/auth/mfa#ticket=abc');
    fireEvent.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    type('Recovery code', 'ABCD-EFGH-JKMN-PQRS');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByText('forms list');
    expect(calls.find((c) => c.url === '/v1/auth/mfa/recovery')?.body).toEqual({ ticket: 'abc', code: 'ABCD-EFGH-JKMN-PQRS' });
  });

  it('offers Google and Microsoft on SaaS when the server does, and never when air-gapped', async () => {
    const { unmount } = at('/auth/sign-in');
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/v1/auth/oauth/google/start');
    expect(screen.getByRole('link', { name: 'Continue with Microsoft' })).toBeInTheDocument();
    unmount();
    useEditionStore.setState({ summary: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' })), source: 'server' });
    at('/auth/sign-in');
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/auth/methods')).toHaveLength(2));
    expect(screen.queryByRole('link', { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it('leaves out the emailed sign-in and reset links when the deployment cannot send mail', async () => {
    answers['GET /v1/auth/methods'] = () => ({ status: 200, body: { password: true, emailLinks: false, oauth: [] } });
    at('/auth/sign-in');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('explains an OAuth failure handed back in the fragment and clears it', async () => {
    at('/auth/sign-in#error=oauth_email_unverified');
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not confirm that email address/);
    await waitFor(() => expect(path()).toBe('/auth/sign-in'));
  });

  it('says a link is on its way when the account steps sign-in up to an emailed link', async () => {
    answers['POST /v1/auth/login'] = () => ({ status: 200, body: { status: 'link_sent' } });
    at('/auth/sign-in');
    type('Email', 'asha@example.test');
    type('Password', 'pw');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If the password was right, a sign-in link is on its way to asha@example.test.');
    expect(path()).toBe('/auth/sign-in');
  });

  it('emails a sign-in link without saying whether the address has an account', async () => {
    answers['POST /v1/auth/magic-link'] = () => ({ status: 202, body: { status: 'link_sent' } });
    at('/auth/sign-in');
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your email address first.');
    type('Email', 'asha@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If an account uses asha@example.test, a sign-in link is on its way.');
  });
});

describe('sign-up and email links', () => {
  it('creates the account and asks to check the email', async () => {
    answers['POST /v1/auth/signup'] = () => ({ status: 202, body: { status: 'verification_sent' } });
    at('/auth/sign-up');
    type('Your name', 'Asha');
    type('Work email', 'asha@example.test');
    type('Password', 'violet-anchor-teapot-91');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('status')).toHaveTextContent('We sent a link to asha@example.test.');
    expect(calls.find((c) => c.url === '/v1/auth/signup')?.body).toEqual({ email: 'asha@example.test', password: 'violet-anchor-teapot-91', name: 'Asha' });
  });

  it('shows a refused password', async () => {
    answers['POST /v1/auth/signup'] = () => ({ status: 422, body: { code: 'WEAK_PASSWORD', detail: 'This password is too common.' } });
    at('/auth/sign-up');
    type('Work email', 'asha@example.test');
    type('Password', 'password123');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This password is too common.');
  });

  it('names the account of the verification link, takes the token out of the address and redeems it only on the click', async () => {
    const token = 'v'.repeat(43);
    answers['POST /v1/auth/link'] = () => ({ status: 200, body: { email: 'asha@example.test', passwordRequired: false } });
    answers['POST /v1/auth/verify-email'] = () => ({ status: 200, body: { status: 'signed_in', user: USER } });
    at(`/auth/verify#token=${token}`);
    const confirm = await screen.findByRole('button', { name: 'Continue as asha@example.test' });
    await waitFor(() => expect(path()).toBe('/auth/verify'));
    expect(calls.find((c) => c.url === '/v1/auth/link')?.body).toEqual({ token, purpose: 'verify_email' });
    expect(calls.some((c) => c.url === '/v1/auth/verify-email')).toBe(false);
    fireEvent.click(confirm);
    await screen.findByText('forms list');
    expect(calls.filter((c) => c.url === '/v1/auth/verify-email').map((c) => c.body)).toEqual([{ token }]);
  });

  it('asks for the password when the link is opened outside the signing-up browser', async () => {
    const token = 'w'.repeat(43);
    answers['POST /v1/auth/link'] = () => ({ status: 200, body: { email: 'asha@example.test', passwordRequired: true } });
    answers['POST /v1/auth/verify-email'] = () => ({ status: 200, body: { status: 'signed_in', user: USER } });
    at(`/auth/verify#token=${token}`);
    await screen.findByText(/not in the browser you signed up in/);
    expect(screen.getByRole('link', { name: /Reset it/ })).toHaveAttribute('href', '/auth/forgot');
    type('Password', 'violet-anchor-teapot-91');
    fireEvent.click(screen.getByRole('button', { name: 'Continue as asha@example.test' }));
    await screen.findByText('forms list');
    expect(calls.find((c) => c.url === '/v1/auth/verify-email')?.body).toEqual({ token, password: 'violet-anchor-teapot-91' });
  });

  it('says so when a magic link has expired, and when the page has no token', async () => {
    answers['POST /v1/auth/link'] = () => ({ status: 400, body: { code: 'INVALID_TOKEN', detail: 'This sign-in link is invalid or has expired.' } });
    const { unmount } = at(`/auth/magic#token=${'m'.repeat(43)}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('This sign-in link is invalid or has expired.');
    unmount();
    at('/auth/magic');
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs the link from your email/);
  });

  it('resets a password with the token from the fragment', async () => {
    answers['POST /v1/auth/password/reset'] = () => ({ status: 200, body: { status: 'password_reset' } });
    at(`/auth/reset#token=${'r'.repeat(43)}`);
    type('New password', 'a-brand-new-passphrase');
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your password is changed.');
    expect(calls.find((c) => c.url === '/v1/auth/password/reset')?.body).toEqual({ token: 'r'.repeat(43), password: 'a-brand-new-passphrase' });
  });
});

describe('security page', () => {
  it('enrols TOTP: QR code and key, a code, then the recovery codes once', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-00${String(i).padStart(2, '0')}`);
    answers['POST /v1/auth/mfa/totp/setup'] = () => ({ status: 200, body: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/fORM-:asha?secret=JBSWY3DPEHPK3PXP' } });
    answers['POST /v1/auth/mfa/totp/verify'] = () => ({ status: 200, body: { recoveryCodes: codes } });
    at('/account/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-factor sign-in' }));
    expect(await screen.findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(screen.getByLabelText('Setup key')).toHaveValue('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    type('Code from the app', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(list.querySelectorAll('li')).toHaveLength(10);
    expect(calls.find((c) => c.url === '/v1/auth/mfa/totp/verify')?.body).toEqual({ code: '123456' });
  });

  it('sends a signed-out visitor to sign in', async () => {
    answers['GET /v1/me'] = () => ({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    at('/account/security');
    await waitFor(() => expect(path()).toBe('/auth/sign-in'));
  });
});
