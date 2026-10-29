import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useSessionStore } from '@/auth/client';
import { AccountMenu } from '@/auth/AccountMenu';
import { pendingInvite } from '@/org/pendingInvite';
import { CreateOrgPage } from './CreateOrgPage';
import { InvitePage } from './InvitePage';
import { MembersPage } from './MembersPage';
import { OrgSettingsPage } from './OrgSettingsPage';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };
const ORGS = [
  { id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' },
  { id: 'o2', slug: 'globex', name: 'Globex', role: 'viewer' },
];
const me = (activeOrgId: string | null, orgs = ORGS) => ({ user: USER, session: { id: 's1', mfaLevel: 'pwd', expiresAt: '2026-11-02T00:00:00Z' }, orgs, activeOrgId });
const ORG = (role: string, permissions: string[]) => ({
  org: { id: 'o1', slug: 'acme', name: 'Acme', locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' },
  role,
  permissions,
});
const OWNER_PERMS = ['forms.read', 'forms.edit', 'members.manage', 'org.settings'];
const MEMBERS = {
  items: [
    { userId: 'u1', email: 'asha@example.test', name: 'Asha', role: 'owner', status: 'active', joinedAt: '2026-10-01T00:00:00Z' },
    { userId: 'u2', email: 'ravi@example.test', name: null, role: 'editor', status: 'active', joinedAt: '2026-10-02T00:00:00Z' },
  ],
  accessLinks: false,
};

let calls: Call[];
let answers: Record<string, (body: unknown) => { status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  answers = { 'GET /v1/me': () => ({ status: 200, body: me('o1') }) };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body });
    const answer = answers[`${method} ${url}`]?.(body) ?? { status: 404, body: { code: 'NOT_FOUND', detail: 'no route' } };
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': answer.status < 400 ? 'application/json' : 'application/problem+json' },
    });
  });
  useSessionStore.setState({ status: 'unknown' }, true);
  localStorage.clear();
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
        <Route path="/forms" element={<AccountMenu />} />
        <Route path="/orgs/new" element={<CreateOrgPage />} />
        <Route path="/org/members" element={<MembersPage />} />
        <Route path="/org/settings" element={<OrgSettingsPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="/auth/sign-in" element={<p>sign in</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const path = () => screen.getByLabelText('path').textContent;
const sent = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);

describe('org switcher', () => {
  it('lists the user’s orgs, starts on the session’s choice and switches through the API', async () => {
    answers['PUT /v1/me/active-org'] = () => ({ status: 204, body: null });
    at('/forms');
    const select = await screen.findByLabelText('Organisation');
    expect((select as HTMLSelectElement).value).toBe('o1');
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Acme', 'Globex']);
    answers['GET /v1/me'] = () => ({ status: 200, body: me('o2') });
    fireEvent.change(select, { target: { value: 'o2' } });
    await waitFor(() => expect((screen.getByLabelText('Organisation') as HTMLSelectElement).value).toBe('o2'));
    expect(sent('PUT', '/v1/me/active-org')).toEqual([expect.objectContaining({ body: { orgId: 'o2' }, headers: expect.objectContaining({ 'x-fr-client': 'builder' }) })]);
  });

  it('offers to create an org to a user without one', async () => {
    answers['GET /v1/me'] = () => ({ status: 200, body: me(null, []) });
    at('/forms');
    expect(await screen.findByRole('link', { name: /Create an organisation/ })).toHaveAttribute('href', '/orgs/new');
  });
});

describe('create org', () => {
  it('starts from the en-IN, Asia/Kolkata and DD-MM-YYYY defaults', async () => {
    answers['POST /v1/orgs'] = () => ({ status: 201, body: { org: { id: 'o3' } } });
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('owner', OWNER_PERMS) });
    answers['GET /v1/org/members'] = () => ({ status: 200, body: MEMBERS });
    answers['GET /v1/org/invites'] = () => ({ status: 200, body: { items: [] } });
    at('/orgs/new');
    expect(await screen.findByLabelText('Language')).toHaveValue('en-IN');
    expect(screen.getByLabelText('Time zone')).toHaveValue('Asia/Kolkata');
    expect(screen.getByLabelText('Date format')).toHaveValue('DD-MM-YYYY');
    fireEvent.change(screen.getByLabelText('Organisation name'), { target: { value: 'Initech' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create organisation' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));
    await waitFor(() => expect(path()).toBe('/org/members'));
    expect(sent('POST', '/v1/orgs')[0]?.body).toEqual({ name: 'Initech', locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' });
  });
});

describe('members', () => {
  beforeEach(() => {
    answers['GET /v1/org/members'] = () => ({ status: 200, body: MEMBERS });
    answers['GET /v1/org/invites'] = () => ({
      status: 200,
      body: { items: [{ id: 'i1', email: 'old@example.test', role: 'viewer', createdAt: '2026-10-10T00:00:00Z', expiresAt: '2026-10-17T00:00:00Z', state: 'expired' }] },
    });
  });

  it('lets an owner invite, change roles and withdraw invites, all in the active org', async () => {
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('owner', OWNER_PERMS) });
    answers['POST /v1/org/invites'] = () => ({
      status: 201,
      body: {
        invite: { id: 'i2', email: 'new@example.test', role: 'admin', createdAt: '2026-10-19T00:00:00Z', expiresAt: '2026-10-26T00:00:00Z', state: 'open' },
        link: 'https://app.form.test/invite#token=abc',
        emailed: false,
      },
    });
    answers['PATCH /v1/org/members/u2'] = () => ({ status: 200, body: {} });
    answers['DELETE /v1/org/invites/i1'] = () => ({ status: 204, body: null });
    at('/org/members');
    expect(await screen.findByText('Members of Acme')).toBeInTheDocument();
    expect(sent('GET', '/v1/org/members')[0]?.headers['x-fr-org']).toBe('o1');
    expect(screen.queryByLabelText('Role of asha@example.test')).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Role of ravi@example.test'), { target: { value: 'viewer' } });
    await waitFor(() => expect(sent('PATCH', '/v1/org/members/u2')).toHaveLength(1));
    expect(sent('PATCH', '/v1/org/members/u2')[0]).toMatchObject({ body: { role: 'viewer' }, headers: { 'x-fr-org': 'o1', 'x-fr-client': 'builder' } });

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/This server sends no email: give new@example.test this link yourself./)).toBeInTheDocument();
    expect(screen.getByText('https://app.form.test/invite#token=abc')).toBeInTheDocument();
    expect(sent('POST', '/v1/org/invites')[0]?.body).toEqual({ email: 'new@example.test', role: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(sent('DELETE', '/v1/org/invites/i1')).toHaveLength(1));
  });

  it('shows a viewer the members only', async () => {
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('viewer', ['forms.read', 'submissions.read']) });
    at('/org/members');
    expect(await screen.findByText('Members of Acme')).toBeInTheDocument();
    expect(screen.getAllByText('ravi@example.test').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Role of ravi@example.test')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Organisation settings/ })).toBeNull();
    expect(sent('GET', '/v1/org/invites')).toEqual([]);
  });

  it('keeps an admin away from the owner and the owner role', async () => {
    answers['GET /v1/me'] = () => ({ status: 200, body: { ...me('o1'), user: { ...USER, id: 'u3', email: 'admin@example.test' } } });
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('admin', OWNER_PERMS) });
    at('/org/members');
    const ravi = await screen.findByLabelText('Role of ravi@example.test');
    expect([...(ravi as HTMLSelectElement).options].map((o) => o.value)).toEqual(['editor', 'admin', 'viewer']);
    expect(screen.queryByLabelText('Role of asha@example.test')).toBeNull();
    expect([...(screen.getByLabelText('Role') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['admin', 'editor', 'viewer']);
  });
});

describe('org settings', () => {
  it('saves only what changed', async () => {
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('owner', OWNER_PERMS) });
    answers['GET /v1/org/settings'] = () => ({ status: 200, body: { editorsApproveNotice: false, inviteDays: 7 } });
    answers['PATCH /v1/org'] = () => ({ status: 200, body: {} });
    answers['PATCH /v1/org/settings'] = () => ({ status: 200, body: {} });
    at('/org/settings');
    fireEvent.change(await screen.findByLabelText('Time zone'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Editors may approve privacy notices' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(sent('PATCH', '/v1/org')[0]?.body).toEqual({ timeZone: 'UTC' });
    expect(sent('PATCH', '/v1/org/settings')[0]?.body).toEqual({ editorsApproveNotice: true });
  });

  it('tells members without org.settings so', async () => {
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('editor', ['forms.read']) });
    at('/org/settings');
    expect(await screen.findByText('Only owners and admins can change these settings.')).toBeInTheDocument();
  });
});

describe('invite', () => {
  const INFO = { orgName: 'Acme', email: 'asha@example.test', role: 'editor', inviterName: 'Ravi', state: 'open', expiresAt: '2026-10-26T00:00:00Z' };

  it('accepts as the invited, signed-in user and opens the members', async () => {
    answers['POST /v1/invites/lookup'] = () => ({ status: 200, body: INFO });
    answers['POST /v1/invites/accept'] = () => ({ status: 200, body: { org: ORGS[0], outcome: 'accepted' } });
    answers['GET /v1/org'] = () => ({ status: 200, body: ORG('editor', ['forms.read']) });
    answers['GET /v1/org/members'] = () => ({ status: 200, body: MEMBERS });
    at(`/invite#token=${'t'.repeat(43)}`);
    expect(await screen.findByText('Ravi invited asha@example.test to Acme as Editor.')).toBeInTheDocument();
    expect(path()).toBe('/invite');
    fireEvent.click(await screen.findByRole('button', { name: 'Join Acme' }));
    await waitFor(() => expect(path()).toBe('/org/members'));
    expect(sent('POST', '/v1/invites/accept')[0]?.body).toEqual({ token: 't'.repeat(43) });
  });

  it('keeps the link through sign-in when signed out', async () => {
    answers['GET /v1/me'] = () => ({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    answers['POST /v1/invites/lookup'] = () => ({ status: 200, body: INFO });
    at(`/invite#token=${'k'.repeat(43)}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in as asha@example.test to accept' }));
    expect(path()).toBe('/auth/sign-in');
    expect(pendingInvite()).toBe('k'.repeat(43));
  });

  it('says when an invite expired or is for someone else', async () => {
    answers['POST /v1/invites/lookup'] = () => ({ status: 200, body: { ...INFO, state: 'expired' } });
    const view = at(`/invite#token=${'e'.repeat(43)}`);
    expect(await screen.findByText('This invitation has expired. Ask for a new one.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Acme' })).toBeNull();
    view.unmount();
    answers['POST /v1/invites/lookup'] = () => ({ status: 200, body: { ...INFO, email: 'other@example.test' } });
    at(`/invite#token=${'o'.repeat(43)}`);
    expect(await screen.findByText(/The invitation is for other@example.test/)).toBeInTheDocument();
  });
});
