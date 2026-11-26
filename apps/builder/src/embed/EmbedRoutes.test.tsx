import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { EmbedRoutes } from '@/embed/EmbedRoutes';
import { resetLaunchMemo } from '@/embed/launch';
import { resetTestSession } from '@/embed/session/testing';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/embed/*" element={<EmbedRoutes />} />
        <Route path="/forms" element={<p>forms list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => resetLaunchMemo());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetTestSession();
  window.history.replaceState(null, '', '/');
});

describe('EmbedRoutes unknown paths', () => {
  it('top level: an unknown /embed path goes to the forms list as before', () => {
    renderAt('/embed/nothing-here');
    expect(screen.getByText('forms list')).toBeTruthy();
  });

  it('framed: an unknown /embed path shows a notice and never the builder', () => {
    vi.stubGlobal('parent', {});
    renderAt('/embed/nothing-here');
    expect(screen.getByRole('alert').textContent).toMatch(/not available here/);
    expect(screen.queryByText('forms list')).toBeNull();
  });
});

describe('dms-upload is not a route of this app (nginx serves its own entry)', () => {
  it('framed: a hit on /embed/dms-upload is NotAvailableHere, and no upload page is rendered', () => {
    vi.stubGlobal('parent', {});
    renderAt('/embed/dms-upload');
    expect(screen.getByRole('alert').textContent).toMatch(/not available here/);
  });

  it('top level: it goes to the forms list like any unknown embed path', () => {
    renderAt('/embed/dms-upload');
    expect(screen.getByText('forms list')).toBeTruthy();
  });
});

describe('dms-master and dms-record run inside the session gate', () => {
  it.each(['dms-master', 'dms-record'])('/embed/%s with no launch asks to start from DMS and never goes to the forms list', async (mode) => {
    window.history.replaceState(null, '', `/embed/${mode}`);
    renderAt(`/embed/${mode}`);
    expect(await screen.findByText(/Open this page from DMS/)).toBeTruthy();
    expect(screen.queryByText('forms list')).toBeNull();
  });

  it('/embed/dms-record with a ticket exchanges it first and only then renders the record page', async () => {
    const { ticket, verifier } = ticketFx.samples;
    vi.stubEnv('VITE_FP_DMS_API_BASE', 'https://dms.example.test/api');
    vi.stubEnv('VITE_FP_RETURN_ORIGINS', 'https://dms.example.test');
    sessionStorage.setItem('fp.lv', verifier);
    window.history.replaceState(null, '', `/embed/dms-record#fpt=${ticket}`);
    const record = ticketFx.exchangeResponse.find((c) => c.name === 'record-edit-30-min')!.input;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => (String(url).endsWith('/launch-tickets/exchange') ? new Response(JSON.stringify(record), { status: 200 }) : new Response('{}', { status: 404 })));
    vi.stubGlobal('fetch', fetch);
    renderAt('/embed/dms-record');
    // The page's own load goes to the SESSION route with the credential, after the exchange.
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1));
    const [first, second] = fetch.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit & { headers: Record<string, string> } }));
    expect(first!.url).toBe('https://dms.example.test/api/dms/v1/formplus/launch-tickets/exchange');
    expect(second!.url).toContain('/api/dms/v1/formplus/s/');
    expect(second!.init.headers.Authorization).toBe(`Bearer ${record.credential}`);
    expect(screen.queryByTestId('fp-launch-failed')).toBeNull();
  });
});
