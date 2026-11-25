import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { FieldBlock, SafeUrl } from '@form/schema';
import { useSessionStore, type Me } from '@/auth/client';
import { ApiOptionsSection } from '@/components/builder/inspector/ApiOptionsSection';
import { ApiValidationSection } from '@/components/builder/inspector/ApiValidationSection';
import { block, resetStore } from '@/test/fixtures';

/* The inspector's Test buttons go through the author route: the browser never calls the third-party API (server-side lookups, F5). */

const ME: Me = {
  user: { id: 'u1', email: 'a@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const UPSTREAM = 'https://api.upstream.example.com/x' as SafeUrl;
let calls: Array<{ url: string; body: any }> = [];

function api(data: unknown) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith('/remote/test')) return Promise.resolve(json(200, { status: 200, data, truncated: false }));
      if (url === '/v1/org') return Promise.resolve(json(200, { permissions: ['org.settings'] }));
      return Promise.resolve(json(200, { items: [] }));
    }),
  );
}

beforeEach(() => useSessionStore.setState({ status: 'signed_in', me: ME }, true));
afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('ApiOptionsSection', () => {
  it('Test calls the author route with the request and reads the tree it returns', async () => {
    api([{ name: 'Pune' }, { name: 'Delhi' }]);
    const choice = block('single_choice', 'city', { apiOptions: { url: UPSTREAM, method: 'GET', parser: 'json' } });
    resetStore([choice]);
    render(<MemoryRouter><ApiOptionsSection block={choice} /></MemoryRouter>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/remote/test'))).toBe(true));
    expect(calls.every((c) => !c.url.includes('upstream.example.com'))).toBe(true);
    expect(calls.find((c) => c.url.endsWith('/remote/test'))!.body).toEqual({ request: { url: UPSTREAM, method: 'GET', parser: 'json' } });
    expect(await screen.findByText(/Option text/)).toBeInTheDocument();
  });

  it('a failure says the server could not get an answer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(502, { type: 'about:blank', title: 'x', status: 502, code: 'REMOTE_UPSTREAM_FAILED' }))));
    const choice = block('single_choice', 'city', { apiOptions: { url: UPSTREAM, method: 'GET', parser: 'json' } });
    resetStore([choice]);
    render(<MemoryRouter><ApiOptionsSection block={choice} /></MemoryRouter>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/The server could not get an answer/)).toBeInTheDocument();
  });
});

describe('ApiValidationSection', () => {
  it('Test sends the field key and the sample value to the author route, not to the API', async () => {
    api({ valid: true });
    const field = block('short_text', 'tin', { apiValidation: { url: UPSTREAM, method: 'GET', parser: 'json' } }) as unknown as FieldBlock;
    resetStore([field]);
    render(<MemoryRouter><ApiValidationSection block={field} /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Sample answer/ }), 'ABC123');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/remote/test'))).toBe(true));
    expect(calls.every((c) => !c.url.includes('upstream.example.com'))).toBe(true);
    expect(calls.find((c) => c.url.endsWith('/remote/test'))!.body).toEqual({ request: { url: UPSTREAM, method: 'GET', parser: 'json' }, fieldKey: 'tin', value: 'ABC123' });
  });
});
