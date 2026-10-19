import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useSessionStore } from '@/auth/client';
import { NoticePage } from './NoticePage';
import { PrivacyPage } from './PrivacyPage';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Answer = { status: number; body: unknown; headers?: Record<string, string> };

const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };
const me = (current: boolean) => ({
  user: USER,
  session: { id: 's1', mfaLevel: 'pwd', expiresAt: '2026-11-02T00:00:00Z' },
  orgs: [],
  notice: { version: '2026-10-19', acknowledgedVersion: current ? '2026-10-19' : null, current },
});
const NOTICE = {
  version: '2026-10-19',
  locale: 'en-IN',
  title: 'Privacy notice for fORM- accounts',
  fiduciary: 'fORM-',
  contact: { name: 'the Grievance Officer', email: 'privacy@form.test' },
  sections: [
    { id: 'who', heading: 'Who is responsible', paragraphs: ['fORM- runs this service.'], items: [] },
    { id: 'rights', heading: 'Your choices and rights', paragraphs: [], items: ['Delete your account.'] },
  ],
  hash: 'b'.repeat(64),
};
const GRIEVANCE = {
  reference: 'GRV-ABCDEFGH',
  category: 'correction',
  message: 'Fix my name.',
  status: 'open',
  createdAt: '2026-10-19T10:00:00.000Z',
  dueAt: '2027-01-17T10:00:00.000Z',
  closedAt: null,
};
const org = (blocker: string | null) => ({ orgId: 'o1', slug: 'acme', name: 'Acme', role: 'owner', formsOwned: 2, formsTo: blocker ? null : 'u2', blocker });

let calls: Call[];
let answers: Record<string, (body: unknown) => Answer>;

beforeEach(() => {
  calls = [];
  answers = {
    'GET /v1/me': () => ({ status: 200, body: me(true) }),
    'GET /v1/privacy/notice': () => ({ status: 200, body: NOTICE }),
    'GET /v1/me/grievances': () => ({ status: 200, body: { items: [] } }),
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body });
    const answer = answers[`${method} ${url}`]?.(body) ?? { status: 404, body: { code: 'NOT_FOUND', detail: 'no route' } };
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': answer.status < 400 ? 'application/json' : 'application/problem+json', ...answer.headers },
    });
  });
  useSessionStore.setState({ status: 'unknown' }, true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/account/privacy" element={<PrivacyPage />} />
        <Route path="/privacy" element={<NoticePage />} />
        <Route path="/auth/sign-in" element={<p>sign-in page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const section = (name: string) => screen.getByRole('region', { name });

describe('/privacy', () => {
  it('shows the notice to anyone', async () => {
    at('/privacy');
    expect(await screen.findByRole('heading', { name: 'Privacy notice for fORM- accounts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Who is responsible' })).toBeInTheDocument();
    expect(screen.getByText('Delete your account.')).toBeInTheDocument();
    expect(screen.getByText('Version 2026-10-19')).toBeInTheDocument();
  });
});

describe('/account/privacy', () => {
  it('sends a signed-out visitor to sign-in', async () => {
    answers['GET /v1/me'] = () => ({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    at('/account/privacy');
    expect(await screen.findByText('sign-in page')).toBeInTheDocument();
  });

  it('asks for the new notice and records that it was read', async () => {
    answers['GET /v1/me'] = () => ({ status: 200, body: me(false) });
    answers['POST /v1/me/notice'] = () => ({ status: 200, body: { version: '2026-10-19', acknowledged: true } });
    at('/account/privacy');
    expect(await screen.findByText('We updated our privacy notice. Read the new version below, then confirm.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Who is responsible' })).toBeVisible();
    answers['GET /v1/me'] = () => ({ status: 200, body: me(true) });
    fireEvent.click(screen.getByRole('button', { name: 'I have read the privacy notice' }));
    expect(await screen.findByText('Thank you: we recorded that you read version 2026-10-19.')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/v1/me/notice')).toMatchObject({ method: 'POST', headers: { 'x-fr-client': 'builder' }, body: { version: '2026-10-19', hash: 'b'.repeat(64) } });
  });

  it('corrects the name', async () => {
    answers['PATCH /v1/me'] = () => ({ status: 200, body: { user: { ...USER, name: 'Asha Rao' } } });
    at('/account/privacy');
    const field = await screen.findByLabelText('Your name');
    expect(field).toHaveValue('Asha');
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Asha Rao ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/v1/me', headers: { 'x-fr-client': 'builder' }, body: { name: 'Asha Rao' } });
  });

  it('downloads the account export as a file', async () => {
    answers['POST /v1/me/export'] = () => ({ status: 200, body: { format: 'fr.account-export@1' }, headers: { 'content-disposition': 'attachment; filename="form-account-2026-10-19.json"' } });
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.download} ${this.getAttribute('href')}`);
    });
    at('/account/privacy');
    fireEvent.click(await screen.findByRole('button', { name: 'Download my data' }));
    await waitFor(() => expect(clicked).toEqual(['form-account-2026-10-19.json blob:export']));
    expect(calls.find((c) => c.url === '/v1/me/export')).toMatchObject({ method: 'POST', headers: { 'x-fr-client': 'builder' } });
  });

  it('sends a privacy request and lists it with its due date', async () => {
    answers['POST /v1/me/grievances'] = () => ({ status: 201, body: GRIEVANCE });
    at('/account/privacy');
    const requests = await screen.findByRole('region', { name: 'Questions, corrections and complaints' });
    expect(await within(requests).findByText('Write to the Grievance Officer at privacy@form.test, or send a request here. We answer within 90 days.')).toBeInTheDocument();
    fireEvent.change(within(requests).getByLabelText('Kind of request'), { target: { value: 'correction' } });
    fireEvent.change(within(requests).getByLabelText('Your request'), { target: { value: 'Fix my name.' } });
    answers['GET /v1/me/grievances'] = () => ({ status: 200, body: { items: [GRIEVANCE] } });
    fireEvent.click(within(requests).getByRole('button', { name: 'Send request' }));
    expect(await within(requests).findByRole('status')).toHaveTextContent('Sent. Your reference is GRV-ABCDEFGH; we answer by 17 Jan 2027.');
    expect(await within(requests).findByRole('list', { name: 'Your requests' })).toHaveTextContent('GRV-ABCDEFGH · Correct my data · open · answer by 17 Jan 2027');
    expect(calls.find((c) => c.url === '/v1/me/grievances' && c.method === 'POST')?.body).toEqual({ category: 'correction', message: 'Fix my name.' });
  });

  it('says what stops the deletion of an org’s only owner', async () => {
    answers['GET /v1/me/deletion'] = () => ({ status: 200, body: { status: 'blocked', orgs: [org('sole_owner')], recentSignIn: true, signInWithinMinutes: 15 } });
    at('/account/privacy');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    const alert = await within(section('Delete your account')).findByRole('alert');
    expect(alert).toHaveTextContent('You are the only owner of Acme. Make someone else an owner first, or delete the organisation.');
    expect(screen.queryByRole('button', { name: 'Delete my account' })).not.toBeInTheDocument();
  });

  it('asks for a fresh sign-in before deleting', async () => {
    answers['GET /v1/me/deletion'] = () => ({ status: 200, body: { status: 'ready', orgs: [], recentSignIn: false, signInWithinMinutes: 15 } });
    answers['POST /v1/auth/logout'] = () => ({ status: 204, body: null });
    at('/account/privacy');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    expect(await screen.findByText('For your safety, deleting needs a sign-in from the last 15 minutes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out and sign in again' }));
    expect(await screen.findByText('sign-in page')).toBeInTheDocument();
  });

  it('deletes the account once the address is typed, and signs out here', async () => {
    answers['GET /v1/me/deletion'] = () => ({ status: 200, body: { status: 'ready', orgs: [org(null)], recentSignIn: true, signInWithinMinutes: 15 } });
    answers['POST /v1/me/delete'] = () => ({ status: 200, body: { status: 'deleted', orgsLeft: 1, formsReassigned: 2, backupsExpireBy: '2026-11-23T10:00:00.000Z' } });
    at('/account/privacy');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    expect(await screen.findByText('You leave 1 organisation; the 2 forms you own pass to another owner.')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Delete my account' });
    expect(remove).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type your email address to confirm'), { target: { value: 'Asha@Example.test' } });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(await screen.findByRole('heading', { name: 'Your account was deleted' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copies in our backups expire by 23 Nov 2026.');
    expect(calls.find((c) => c.url === '/v1/me/delete')?.body).toEqual({ confirmEmail: 'Asha@Example.test' });
    expect(useSessionStore.getState()).toEqual({ status: 'signed_out' });
  });
});
