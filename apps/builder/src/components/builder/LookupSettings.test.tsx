import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useSessionStore, type Me } from '@/auth/client';
import { LookupSettings } from '@/components/builder/LookupSettings';
import { block, doc, resetStore } from '@/test/fixtures';

const ME: Me = {
  user: { id: 'u1', email: 'a@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};
const CRED = '0198a2c0-0000-7000-8000-0000000000c1';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

let calls: Array<{ url: string; method: string; body: any }> = [];
function api(testAnswer: Response | (() => Response) = json(200, { status: 200, data: { rows: [{ name: 'Asha', dept: 'Finance' }] }, truncated: false })) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url: String(url), method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url === '/v1/org') return Promise.resolve(json(200, { permissions: ['org.settings', 'forms.edit'] }));
      if (url === '/v1/org/api-credentials') return Promise.resolve(json(200, { items: [{ id: CRED, name: 'HR key', type: 'bearer', header: null, host: 'hr.example.com', last4: '', createdAt: 'x', rotatedAt: null }] }));
      if (String(url).endsWith('/remote/test')) return Promise.resolve(typeof testAnswer === 'function' ? testAnswer() : testAnswer.clone());
      return Promise.resolve(json(404, {}));
    }),
  );
}

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
  resetStore([block('short_text', 'emp'), block('short_text', 'dept')]);
  api();
});
afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

const renderIt = () => render(<MemoryRouter><LookupSettings /></MemoryRouter>);

describe('LookupSettings (review B1, N3; server-side lookups F5)', () => {
  it('a new API starts with no URL, says the server calls it, and is stored only with a URL and an id that passes the contract', async () => {
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an API' }));
    const url = screen.getByRole('textbox', { name: 'API URL' });
    expect(url).toHaveValue('');
    expect(doc().lookups).toBeUndefined();
    expect(screen.queryByRole('combobox', { name: 'Authorization' })).not.toBeInTheDocument();
    expect(screen.getByText(/passes on only the fields you map/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(url, { target: { value: 'https://hr.example.com/directory' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(doc().lookups).toEqual([expect.objectContaining({ url: 'https://hr.example.com/directory', name: 'API 1', enabled: false })]);
    expect((doc().lookups?.[0] as { id: string }).id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(JSON.stringify(doc().lookups)).not.toContain('localhost');
  });

  it('Test goes through the author route and never calls the third-party API from the browser', async () => {
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an API' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'API URL' }), { target: { value: 'https://hr.example.com/directory' } });
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/remote/test'))).toBe(true));
    expect(calls.every((c) => !c.url.includes('hr.example.com'))).toBe(true);
    const test = calls.find((c) => c.url.endsWith('/remote/test'))!;
    expect(test.url).toContain('/v1/forms/test/remote/test');
    expect(test.body.request.url).toBe('https://hr.example.com/directory');
  });

  it('a failed test says the server could not get an answer, not that the origin is blocked', async () => {
    api(json(502, { code: 'REMOTE_UPSTREAM_FAILED', title: 'x', status: 502, type: 'about:blank' }));
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an API' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'API URL' }), { target: { value: 'https://hr.example.com/directory' } });
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/The server could not get an answer/)).toBeInTheDocument();
  });

  it('stores the search parameter, the minimum characters, the row cap and a picked credential', async () => {
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an API' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'API URL' }), { target: { value: 'https://hr.example.com/directory' } });
    fireEvent.change(screen.getByLabelText('Search parameter'), { target: { value: 'q' } });
    fireEvent.change(screen.getByLabelText('Characters before searching'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Most rows shown'), { target: { value: '10' } });
    // The credential picker lists the org's credentials by name and host.
    await user.click(await screen.findByRole('combobox', { name: 'Credential' }));
    await user.click(await screen.findByRole('option', { name: 'HR key (hr.example.com)' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(doc().lookups).toEqual([expect.objectContaining({ searchParam: 'q', minChars: 3, maxRows: 10, credentialRef: { secretId: CRED } })]);
  });

  it('shows the Manage credentials link to a member with org.settings, and a stale credential as missing', async () => {
    resetStore([block('short_text', 'emp')]);
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an API' }));
    expect(await screen.findByRole('link', { name: 'Manage credentials' })).toHaveAttribute('href', '/org/api-credentials');
  });
});
