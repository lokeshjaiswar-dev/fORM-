import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useSessionStore, type Me } from '@/auth/client';
import { ApiCredentialsPage } from '@/pages/org/ApiCredentialsPage';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};
const SECRET = 'violet-anchor-teapot-91-sentinel';
const NOW = '2026-11-02T09:30:00.000Z';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

interface Row { id: string; name: string; type: 'bearer' | 'api_key' | 'basic'; header: string | null; host: string; last4: string; createdAt: string; rotatedAt: string | null }
const row = (id: string, name: string, over: Partial<Row> = {}): Row => ({ id, name, type: 'bearer', header: null, host: 'hr.example.com', last4: '', createdAt: NOW, rotatedAt: null, ...over });

function fakeApi(o: { rows?: Row[]; permissions?: string[] } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const rows = [...(o.rows ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url, body });
      if (url === '/v1/org') return Promise.resolve(json(200, { permissions: o.permissions ?? ['org.settings', 'forms.read'] }));
      if (url === '/v1/org/api-credentials' && method === 'GET') return Promise.resolve(json(200, { items: rows }));
      if (url === '/v1/org/api-credentials' && method === 'POST') {
        const made = row(`c${rows.length + 1}`, body.name, { host: body.host, type: body.auth.type, last4: 'cret' });
        rows.push(made);
        return Promise.resolve(json(201, made));
      }
      const one = /^\/v1\/org\/api-credentials\/([^/]+)$/.exec(url);
      const found = rows.find((r) => r.id === one?.[1]);
      if (found && method === 'PUT') {
        Object.assign(found, { name: body.name ?? found.name, rotatedAt: NOW });
        return Promise.resolve(json(200, found));
      }
      if (found && method === 'DELETE') {
        rows.splice(rows.indexOf(found), 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json(404, { type: 'about:blank', title: 'NOT_FOUND', status: 404, code: 'NOT_FOUND' }));
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

const renderPage = () => render(<MemoryRouter><ApiCredentialsPage /></MemoryRouter>);

beforeEach(() => useSessionStore.setState({ status: 'signed_in', me: ME }, true));
afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('ApiCredentialsPage', () => {
  it('lists name, type and host only, and offers no write to a member without org.settings', async () => {
    fakeApi({ rows: [row('c1', 'HR directory', { last4: '1234' })], permissions: ['forms.edit'] });
    renderPage();
    expect(await screen.findByText('HR directory')).toBeInTheDocument();
    expect(screen.getByText(/Bearer token for hr.example.com/)).toBeInTheDocument();
    expect(screen.getByText('ends with 1234')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add credential' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only owners and admins/)).toBeInTheDocument();
  });

  it('adds a credential: the secret goes out once and is on the page nowhere afterwards (inputs emptied, list holds no secret)', async () => {
    const api = fakeApi();
    renderPage();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'HR directory');
    await user.type(screen.getByLabelText(/^Host/), 'hr.example.com');
    const token = screen.getByLabelText(/^Token/);
    expect(token).toHaveAttribute('type', 'password');
    await user.type(token, SECRET);
    await user.click(screen.getByRole('button', { name: 'Add credential' }));
    await waitFor(() => expect(api.called('POST', '/v1/org/api-credentials')).toHaveLength(1));
    expect(api.called('POST', '/v1/org/api-credentials')[0]?.body).toEqual({ name: 'HR directory', host: 'hr.example.com', auth: { type: 'bearer', token: SECRET } });
    expect(await screen.findByText('Credential saved.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Token/)).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(SECRET);
    // Nothing that came back from the server held it either.
    expect(JSON.stringify(api.calls.filter((c) => c.method === 'GET'))).not.toContain(SECRET);
  });

  it('rotating with an empty secret changes only the name; deleting asks first', async () => {
    const api = fakeApi({ rows: [row('c1', 'HR directory')] });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rotate HR directory' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'HR v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.called('PUT', '/v1/org/api-credentials/c1')).toHaveLength(1));
    expect(api.called('PUT', '/v1/org/api-credentials/c1')[0]?.body).toEqual({ name: 'HR v2' });
    await user.click(await screen.findByRole('button', { name: /Delete HR v2/ }));
    expect(api.called('DELETE', '/v1/org/api-credentials/c1')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete credential' }));
    await waitFor(() => expect(api.called('DELETE', '/v1/org/api-credentials/c1')).toHaveLength(1));
  });

  it('a new host needs the secret again: Save stays off until it is typed, then both go out together (review should-fix)', async () => {
    const api = fakeApi({ rows: [row('c1', 'HR directory')] });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rotate HR directory' }));
    const host = screen.getByLabelText('Host');
    await user.clear(host);
    await user.type(host, 'evil.example.com');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByText('To send this credential to a new host, enter the secret again.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Token'), SECRET);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.called('PUT', '/v1/org/api-credentials/c1')).toHaveLength(1));
    expect(api.called('PUT', '/v1/org/api-credentials/c1')[0]?.body).toEqual({ host: 'evil.example.com', auth: { type: 'bearer', token: SECRET } });
  });
});
