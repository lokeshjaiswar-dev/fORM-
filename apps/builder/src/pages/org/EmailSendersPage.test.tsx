import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useSessionStore, type Me } from '@/auth/client';
import { EmailSendersPage } from '@/pages/org/EmailSendersPage';
import { OrgSettingsPage } from '@/pages/org/OrgSettingsPage';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const NOW = '2026-11-02T09:30:00.000Z';
const PASSWORD = 'violet-anchor-teapot-91';
const SMTP_URL = `smtps://apikey:${PASSWORD}@smtp.acme.test:465`;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, detail = '') => json(status, { type: 'about:blank', title: code, status, code, detail });

interface Row {
  id: string;
  name: string;
  fromAddress: string;
  fromName: string | null;
  verifiedAt: string | null;
  smtp: { host: string; port: number; secure: boolean; username: string | null } | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}
const row = (id: string, name: string, over: Partial<Row> = {}): Row => ({
  id,
  name,
  fromAddress: `${id}@acme.test`,
  fromName: null,
  verifiedAt: null,
  smtp: { host: 'smtp.acme.test', port: 465, secure: true, username: 'apikey' },
  lastTestError: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

/**
 * The API behind the page: the org's senders (what comes back never holds the SMTP URL, as the real one never returns it),
 * what the member's role grants, and the test message. `testResult` is what a test answers.
 */
function fakeApi(o: { rows?: Row[]; permissions?: string[]; testResult?: { ok: boolean; verifiedAt: string | null; error: string | null } | Response; deleteRefused?: boolean } = {}) {
  const calls: Call[] = [];
  const rows = [...(o.rows ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = (typeof init.body === 'string' ? JSON.parse(init.body) : undefined) as Record<string, unknown> | undefined;
      calls.push({ method, path: url, body });
      if (url === '/v1/org') return Promise.resolve(json(200, { org: { id: 'o1' }, role: 'owner', permissions: o.permissions ?? ['org.settings', 'forms.read'] }));
      if (url === '/v1/email-senders' && method === 'GET') return Promise.resolve(json(200, { items: rows }));
      if (url === '/v1/email-senders' && method === 'POST') {
        const made = row(`s${rows.length + 1}`, String(body?.name), { fromAddress: String(body?.fromAddress), fromName: (body?.fromName as string | undefined) ?? null });
        rows.push(made);
        return Promise.resolve(json(201, made));
      }
      const one = /^\/v1\/email-senders\/([^/]+)(\/test)?$/.exec(url);
      const found = rows.find((r) => r.id === one?.[1]);
      if (one && !found) return Promise.resolve(problem(404, 'NOT_FOUND', 'That email sender is not in this organisation.'));
      if (found && one?.[2] && method === 'POST') {
        const result = o.testResult ?? { ok: true, verifiedAt: NOW, error: null };
        if (result instanceof Response) return Promise.resolve(result);
        found.verifiedAt = result.verifiedAt;
        found.lastTestError = result.error;
        return Promise.resolve(json(200, result));
      }
      if (found && method === 'PATCH') {
        Object.assign(found, body ?? {}, { updatedAt: NOW });
        if (body && ('smtpUrl' in body || 'fromAddress' in body)) found.verifiedAt = null;
        delete (found as unknown as Record<string, unknown>)['smtpUrl'];
        return Promise.resolve(json(200, found));
      }
      if (found && method === 'DELETE') {
        if (o.deleteRefused) return Promise.resolve(problem(409, 'EMAIL_SENDER_IN_USE', 'A notification still sends from this sender. Choose another sender for it first.'));
        rows.splice(rows.indexOf(found), 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <EmailSendersPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('EmailSendersPage', () => {
  it('lists the senders with what each points at (host, port, user name) and whether it has been tested', async () => {
    fakeApi({ rows: [row('s1', 'Acme mail', { verifiedAt: NOW, fromName: 'Acme Forms' }), row('s2', 'Billing', { lastTestError: 'Connection refused' })] });
    renderPage();
    const first = (await screen.findByText('Acme mail')).closest('li')!;
    expect(first).toHaveTextContent('Acme Forms <s1@acme.test>');
    expect(first).toHaveTextContent('Sends through smtp.acme.test:465 (encrypted), signed in as apikey');
    expect(first).toHaveTextContent('Test message delivered');
    const second = screen.getByText('Billing').closest('li')!;
    expect(second).toHaveTextContent('Not tested yet');
    expect(second).toHaveTextContent('Last test failed: Connection refused');
    expect(screen.getByRole('link', { name: 'Back to organisation settings' })).toHaveAttribute('href', '/org/settings');
  });

  it('adds a sender, sends the SMTP URL once, and never shows it again: the box is empty and the page never holds it', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    const { container } = renderPage();
    expect(await screen.findByText(/No senders yet/)).toBeInTheDocument();

    const url = screen.getByLabelText('SMTP URL');
    // A password box: the URL is not drawn on screen.
    expect(url).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Add sender' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Acme mail');
    await user.type(screen.getByLabelText('From address'), 'forms@acme.test');
    await user.type(screen.getByLabelText('From name (optional)'), 'Acme Forms');
    await user.type(url, SMTP_URL);
    await user.click(screen.getByRole('button', { name: 'Add sender' }));

    expect(await screen.findByText(/Sender saved/)).toBeInTheDocument();
    const [post] = api.called('POST', '/v1/email-senders');
    expect(post?.body).toEqual({ name: 'Acme mail', fromAddress: 'forms@acme.test', fromName: 'Acme Forms', smtpUrl: SMTP_URL });
    // The sender is listed, and the SMTP URL is nowhere: not in the box, not in the page.
    expect(screen.getAllByText('Acme mail').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('SMTP URL')).toHaveValue('');
    expect(container.outerHTML).not.toContain(PASSWORD);
    expect(container.textContent).not.toContain(SMTP_URL);
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('does not prefill the SMTP URL when changing a sender, keeps the relay when it is left empty, and replaces it when one is typed', async () => {
    const api = fakeApi({ rows: [row('s1', 'Acme mail', { verifiedAt: NOW })] });
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme mail' }));

    const form = screen.getByRole('form', { name: 'Change Acme mail' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Acme mail');
    expect(within(form).getByLabelText('New SMTP URL')).toHaveValue('');
    expect(within(form).getByText(/Leave this empty to keep the mail server/)).toBeInTheDocument();

    // Only what changed is sent: renaming leaves the relay alone.
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Acme transactional');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Acme transactional')).toBeInTheDocument();
    expect(api.called('PATCH', '/v1/email-senders/s1')[0]?.body).toEqual({ name: 'Acme transactional' });

    // A new URL replaces the relay; after the save the box is empty again and the page holds no password.
    await user.click(screen.getByRole('button', { name: 'Edit Acme transactional' }));
    const again = screen.getByRole('form', { name: 'Change Acme transactional' });
    await user.type(within(again).getByLabelText('New SMTP URL'), SMTP_URL);
    await user.click(within(again).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.called('PATCH', '/v1/email-senders/s1')).toHaveLength(2));
    expect(api.called('PATCH', '/v1/email-senders/s1')[1]?.body).toEqual({ smtpUrl: SMTP_URL });
    expect(await screen.findByRole('form', { name: 'Add a sender' })).toBeInTheDocument();
    expect(screen.getByLabelText('SMTP URL')).toHaveValue('');
    expect(container.outerHTML).not.toContain(PASSWORD);
    // A new relay has delivered nothing yet.
    expect(screen.getByText('Not tested yet')).toBeInTheDocument();
  });

  it('shows the success of a test, and marks the sender as tested', async () => {
    const api = fakeApi({ rows: [row('s1', 'Acme mail')] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Send a test message through Acme mail' }));
    expect(await screen.findByText('The test message was delivered to your own address.')).toBeInTheDocument();
    expect(api.called('POST', '/v1/email-senders/s1/test')).toHaveLength(1);
    expect(screen.getByText(/Test message delivered/)).toBeInTheDocument();
  });

  it('shows the mail server’s error when a test fails (a 200 with ok false), and the API’s own error when the call fails', async () => {
    fakeApi({ rows: [row('s1', 'Acme mail')], testResult: { ok: false, verifiedAt: null, error: 'Authentication failed for [address]' } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Send a test message through Acme mail' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The test message was not delivered: Authentication failed for [address]');
    expect(screen.getByText('Not tested yet')).toBeInTheDocument();
    vi.unstubAllGlobals();

    fakeApi({ rows: [row('s1', 'Acme mail')], testResult: problem(503, 'SERVICE_UNAVAILABLE', 'Test messages need the org mailer, which is not configured.') });
    await user.click(screen.getByRole('button', { name: 'Send a test message through Acme mail' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Test messages need the org mailer, which is not configured.'));
  });

  it('deletes a sender after asking, and shows the API’s reason when one is still in use', async () => {
    const api = fakeApi({ rows: [row('s1', 'Acme mail'), row('s2', 'Billing')], deleteRefused: true });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete Acme mail' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Acme mail”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete sender' }));
    expect(await screen.findByText('A notification still sends from this sender. Choose another sender for it first.')).toBeInTheDocument();
    expect(api.called('DELETE', '/v1/email-senders/s1')).toHaveLength(1);
    expect(screen.getByText('Acme mail')).toBeInTheDocument();
  });

  it('removes a sender from the list once it is deleted', async () => {
    fakeApi({ rows: [row('s1', 'Acme mail'), row('s2', 'Billing')] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete Acme mail' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete sender' }));
    expect(await screen.findByText('Sender deleted.')).toBeInTheDocument();
    expect(screen.queryByText('Acme mail')).not.toBeInTheDocument();
    expect(screen.getByText('Billing')).toBeInTheDocument();
  });

  it('shows the list without the controls to a member who may not manage senders', async () => {
    fakeApi({ rows: [row('s1', 'Acme mail', { smtp: null })], permissions: ['forms.read'] });
    renderPage();
    expect(await screen.findByText('Acme mail')).toBeInTheDocument();
    expect(screen.getByText('Only owners and admins can add, change, test or delete senders.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send a test message/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('SMTP URL')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sends through/)).not.toBeInTheDocument();
  });

  it('is linked from the organisation settings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/v1/org') {
          return Promise.resolve(json(200, { org: { id: 'o1', slug: 'acme', name: 'Acme', locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' }, role: 'owner', permissions: ['org.settings'] }));
        }
        if (url === '/v1/org/settings') return Promise.resolve(json(200, { editorsApproveNotice: false, inviteDays: 7, reviewCheckersMfa: true }));
        return Promise.resolve(problem(404, 'NOT_FOUND'));
      }),
    );
    render(
      <MemoryRouter>
        <OrgSettingsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'Email senders' })).toHaveAttribute('href', '/org/email-senders');
  });
});
