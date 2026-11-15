import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore, type Me } from '@/auth/client';
import { AccessPanel } from '@/components/builder/access/AccessPanel';
import { forgetAccess, useAccessPreviewStore } from '@/components/builder/access/accessPreview';
import { resetStore } from '@/test/fixtures';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const FORM = 'test';
const PASSWORD = 'violet-anchor-teapot-91';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, detail = '') => json(status, { type: 'about:blank', title: code, status, code, detail });

/**
 * The API behind the panel, as far as the panel talks to it: the org, a form's access settings (a save needs the right
 * `If-Match`, as the real one does), its password and its address. `taken` lists the addresses other forms hold.
 */
function fakeApi(o: { rev?: number; hasPassword?: boolean; taken?: string[]; staleOnce?: boolean; missing?: boolean; timeZone?: string; weakPassword?: boolean } = {}) {
  const calls: Call[] = [];
  let rev = o.rev ?? 4;
  let hasPassword = o.hasPassword ?? false;
  let settings: Record<string, unknown> = { enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };
  let slug: string | null = 'feedback-ab12';
  let stale = o.staleOnce ?? false;
  const view = () => ({ rev, hasPassword, ...settings });

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url, headers: (init.headers ?? {}) as Record<string, string>, body });
      if (url === '/v1/org') return Promise.resolve(json(200, { org: { id: 'o1', timeZone: o.timeZone ?? 'Asia/Kolkata' }, role: 'owner', permissions: ['ops.manage'] }));
      if (o.missing) return Promise.resolve(problem(404, 'NOT_FOUND', 'That form is not in this organisation.'));
      if (url === `/v1/forms/${FORM}/access` && method === 'GET') return Promise.resolve(json(200, view()));
      if (url === `/v1/forms/${FORM}/access` && method === 'PUT') {
        const sent = (init.headers as Record<string, string>)['if-match'];
        if (stale) {
          // Someone else saved first: the stored settings moved on.
          stale = false;
          rev += 1;
          settings = { ...settings, submissionLimit: 7 };
          return Promise.resolve(problem(409, 'ACCESS_REV_CONFLICT'));
        }
        if (sent !== `"${rev}"`) return Promise.resolve(problem(409, 'ACCESS_REV_CONFLICT'));
        settings = body as Record<string, unknown>;
        rev += 1;
        return Promise.resolve(json(200, view()));
      }
      if (url === `/v1/forms/${FORM}/access/password` && method === 'PUT') {
        if (o.weakPassword) return Promise.resolve(problem(422, 'WEAK_PASSWORD', 'Choose a longer password.'));
        hasPassword = true;
        return Promise.resolve(json(200, { hasPassword }));
      }
      if (url === `/v1/forms/${FORM}/access/password` && method === 'DELETE') {
        hasPassword = false;
        return Promise.resolve(json(200, { hasPassword }));
      }
      if (url === `/v1/forms/${FORM}/slug` && method === 'GET') return Promise.resolve(json(200, { slug, previousSlugs: [] }));
      if (url === `/v1/forms/${FORM}/slug` && method === 'PUT') {
        const next = (body as { slug: string }).slug;
        if (o.taken?.includes(next)) return Promise.resolve(problem(409, 'FORM_SLUG_TAKEN', 'Another form already uses that address.'));
        const previous = slug;
        slug = next;
        return Promise.resolve(json(200, { slug, previousSlugs: previous ? [previous] : [] }));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

async function ready() {
  expect(await screen.findByRole('switch', { name: 'Close form' })).toBeInTheDocument();
}

beforeEach(() => {
  resetStore();
  forgetAccess();
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('AccessPanel', () => {
  it('loads the access settings, saves a limit and a close date (typed in Asia/Kolkata, sent as UTC instants) with If-Match', async () => {
    const api = fakeApi({ rev: 4 });
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    expect(api.called('GET', `/v1/forms/${FORM}/access`)).toHaveLength(1);
    expect(api.called('GET', `/v1/forms/${FORM}/access`)[0]?.headers).toMatchObject({ 'x-fr-org': 'o1' });
    expect(screen.getByText('Dates and times are in Asia/Kolkata.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save access settings' })).toBeDisabled();

    await user.type(screen.getByLabelText('Limit responses'), '100');
    fireEvent.change(screen.getByLabelText('Closes'), { target: { value: '2026-12-31T18:00' } });
    await user.click(screen.getByRole('button', { name: 'Save access settings' }));

    expect(await screen.findByText('Access settings saved.')).toBeInTheDocument();
    const [put] = api.called('PUT', `/v1/forms/${FORM}/access`);
    expect(put?.headers['if-match']).toBe('"4"');
    expect(put?.body).toEqual({
      enabled: true,
      closeAt: '2026-12-31T12:30:00.000Z',
      submissionLimit: 100,
      embedAllowlist: [],
      screens: {},
      acceptPreviousVersionsHours: 72,
    });
    // The saved settings are shown back in the zone they were typed in, and a second save would use the new revision.
    expect(screen.getByLabelText('Closes')).toHaveValue('2026-12-31T18:00');
    expect(screen.getByRole('button', { name: 'Save access settings' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Limit responses'));
    await user.type(screen.getByLabelText('Limit responses'), '200');
    await user.click(screen.getByRole('button', { name: 'Save access settings' }));
    await waitFor(() => expect(api.called('PUT', `/v1/forms/${FORM}/access`)).toHaveLength(2));
    expect(api.called('PUT', `/v1/forms/${FORM}/access`)[1]?.headers['if-match']).toBe('"5"');
  });

  it('shows "Password set" after the password is sent, never renders it, and the box is emptied', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    expect(screen.getByText('No password')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText('Password set')).toBeInTheDocument();
    expect(api.called('PUT', `/v1/forms/${FORM}/access/password`)[0]?.body).toEqual({ password: PASSWORD });
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    // The settings save does not carry the password, and the preview learns a password is set without learning it.
    expect(useAccessPreviewStore.getState().preview).toMatchObject({ hasPassword: true });
    expect(JSON.stringify(useAccessPreviewStore.getState())).not.toContain(PASSWORD);
    expect(api.called('PUT', `/v1/forms/${FORM}/access`)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Remove password' }));
    expect(await screen.findByText('No password')).toBeInTheDocument();
    expect(api.called('DELETE', `/v1/forms/${FORM}/access/password`)).toHaveLength(1);
  });

  it('a password the server refuses is shown with the server’s reason, and nothing says it was set', async () => {
    fakeApi({ weakPassword: true });
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    await user.type(screen.getByLabelText('Password'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Choose a longer password.')).toBeInTheDocument();
    expect(screen.getByText('No password')).toBeInTheDocument();
  });

  it('a slug another form holds is an inline error next to the address, and the address is not changed', async () => {
    const api = fakeApi({ taken: ['summer-fair'] });
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    const address = screen.getByLabelText('Public address');
    expect(address).toHaveValue('feedback-ab12');
    await user.clear(address);
    await user.type(address, 'summer-fair');
    await user.click(screen.getByRole('button', { name: 'Change address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is already used by another form');
    expect(api.called('PUT', `/v1/forms/${FORM}/slug`)).toHaveLength(1);
    expect(address).toHaveValue('summer-fair');
    expect(screen.queryByText(/Earlier addresses/)).not.toBeInTheDocument();
  });

  it('an address that does not have the right shape is refused without a call; a free one becomes the address and the old one is listed', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    const address = screen.getByLabelText('Public address');
    await user.clear(address);
    await user.type(address, 'Bad Slug!');
    await user.click(screen.getByRole('button', { name: 'Change address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use 3 to 100 lower-case letters');
    expect(api.called('PUT', `/v1/forms/${FORM}/slug`)).toHaveLength(0);

    await user.clear(address);
    await user.type(address, 'summer-fair');
    await user.click(screen.getByRole('button', { name: 'Change address' }));
    expect(await screen.findByText(/Earlier addresses that still work: feedback-ab12/)).toBeInTheDocument();
    expect(screen.getByLabelText('Public address')).toHaveValue('summer-fair');
  });

  it('a 409 on save reloads the settings the other save made and says so; nothing of the stale edit is kept', async () => {
    const api = fakeApi({ staleOnce: true });
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    await user.type(screen.getByLabelText('Limit responses'), '100');
    await user.click(screen.getByRole('button', { name: 'Save access settings' }));
    expect(await screen.findByText(/changed somewhere else, so they were reloaded/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Limit responses')).toHaveValue(7));
    expect(api.called('GET', `/v1/forms/${FORM}/access`)).toHaveLength(2);
  });

  it('turning the form off sends enabled: false with the closed message as the closed screen', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Close form' }));
    expect(screen.getByText(/Shown when the form is closed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save access settings' }));
    expect(await screen.findByText('Access settings saved.')).toBeInTheDocument();
    expect(api.called('PUT', `/v1/forms/${FORM}/access`)[0]?.body).toMatchObject({ enabled: false });
    expect(useAccessPreviewStore.getState().preview).toMatchObject({ enabled: false });
  });

  it('says what is wrong with a value before sending it', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    fireEvent.change(screen.getByLabelText('Opens'), { target: { value: '2026-12-31T18:00' } });
    fireEvent.change(screen.getByLabelText('Closes'), { target: { value: '2026-12-01T09:00' } });
    await user.click(screen.getByRole('button', { name: 'Save access settings' }));
    expect(await screen.findByText('The close time must be after the open time.')).toBeInTheDocument();
    expect(api.called('PUT', `/v1/forms/${FORM}/access`)).toHaveLength(0);
  });

  it('weekly hours are an editor of weekdays and a span, sent in the zone shown', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AccessPanel />);
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Only open at certain hours' }));
    expect(screen.getByText('Hours are in Asia/Kolkata.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fri' }));
    await user.click(screen.getByRole('button', { name: 'Save access settings' }));
    expect(await screen.findByText('Access settings saved.')).toBeInTheDocument();
    expect(api.called('PUT', `/v1/forms/${FORM}/access`)[0]?.body).toMatchObject({ availability: { timeZone: 'Asia/Kolkata', windows: [{ weekdays: [1, 2, 3, 4], from: '09:00', to: '17:00' }] } });
  });

  it('is not available to a visitor who is not signed in, and says so without calling the API', () => {
    const api = fakeApi();
    useSessionStore.setState({ status: 'signed_out' }, true);
    render(<AccessPanel />);
    expect(screen.getByText('Sign in to change who can open this form.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('a form that is not on the server yet says it saves by itself, and can be tried again', async () => {
    fakeApi({ missing: true });
    render(<AccessPanel />);
    expect(await screen.findByText(/This form is not on the server yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
