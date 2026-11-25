import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RuntimeFormVersionSchema, type FormVersionId, type IsoInstant, type RuntimeFormVersion, type SafeUrl } from '@form/schema';
import { previewVersion } from '@/lib/preview';
import { PublicFillPage } from '@/pages/PublicFillPage';
import { block, formWith } from '@/test/fixtures';

const NOW = '2026-11-15T04:30:00.000Z' as IsoInstant;
const FORM_ID = '0198a2c0-0000-7000-8000-000000000001';
const V1 = '0198a2c0-0000-7000-8000-0000000000a1';
const UPSTREAM = 'https://hr.upstream-sentinel.example.com/secret/path';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function version(): RuntimeFormVersion {
  const city = block('single_choice', 'city', { label: 'City', key: 'city', apiOptions: { url: `${UPSTREAM}/cities` as SafeUrl, method: 'GET', parser: 'json', itemsPath: '', labelKey: 'name', valueKey: 'name' } });
  const emp = block('short_text', 'emp', { label: 'Employee', key: 'emp' });
  const dept = block('short_text', 'dept', { label: 'Department', key: 'dept' });
  const def = {
    ...formWith([city, emp, dept]),
    formId: FORM_ID as never,
    lookups: [
      {
        id: 'hr',
        name: 'HR',
        url: `${UPSTREAM}/people` as SafeUrl,
        method: 'GET',
        enabled: true,
        itemsPath: 'rows',
        searchParam: 'q',
        pickerKey: 'name',
        pickerFieldId: 'emp',
        mappings: [{ key: 'name', fieldId: 'emp' }, { key: 'dept', fieldId: 'dept' }],
      },
    ],
  } as never;
  const built = previewVersion(def, { state: 'open' }, NOW);
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  return RuntimeFormVersionSchema.parse({ ...built.version, versionId: V1 as FormVersionId, formId: FORM_ID }) as RuntimeFormVersion;
}

interface Call { path: string; method: string; headers: Record<string, string>; credentials: RequestCredentials | undefined; body: any }

function fakeApi() {
  const calls: Call[] = [];
  const v = version();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ path: String(url), method, headers: (init.headers ?? {}) as Record<string, string>, credentials: init.credentials, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (method === 'GET') return Promise.resolve(json(200, { slug: 'staff', formId: FORM_ID, status: v.status, version: v }));
      if (String(url).endsWith('/lookups/hr')) return Promise.resolve(json(200, { rows: [{ label: 'Asha Rao', cells: { name: 'Asha Rao', dept: 'Finance' } }], truncated: false }));
      if (String(url).endsWith('/fields/city/options')) return Promise.resolve(json(200, { options: [{ id: 'pune', label: 'Pune' }] }));
      return Promise.resolve(json(404, {}));
    }),
  );
  return { calls, version: v };
}

afterEach(() => vi.unstubAllGlobals());

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/f/staff']}>
      <Routes>
        <Route path="/f/:slug" element={<PublicFillPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('PublicFillPage passes the proxy source (T-LK-01, T-LK-12)', () => {
  it('the page JSON a respondent gets holds no URL, and no call from the page goes to the upstream host', async () => {
    const api = fakeApi();
    expect(JSON.stringify(api.version)).not.toContain('upstream-sentinel');
    renderPage();
    await screen.findByRole('combobox', { name: /Employee/ });
    expect(api.calls.every((c) => !c.path.includes('upstream-sentinel'))).toBe(true);
  });

  it('loads an API option list through the proxy with the version id, anonymously', async () => {
    const api = fakeApi();
    renderPage();
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/v1/p/staff/fields/city/options'))).toBe(true));
    const call = api.calls.find((c) => c.path.endsWith('/fields/city/options'))!;
    expect(call.method).toBe('POST');
    expect(call.credentials).toBe('omit');
    expect(call.body).toEqual({ formVersionId: V1 });
  });

  it('searches the lookup through the proxy and fills the mapped field from the picked row', async () => {
    const api = fakeApi();
    renderPage();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('combobox', { name: /Employee/ }), 'as');
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/lookups/hr'))).toBe(true), { timeout: 3000 });
    const call = api.calls.find((c) => c.path.endsWith('/lookups/hr'))!;
    expect(call.body).toEqual({ formVersionId: V1, q: 'as' });
    await user.click(await screen.findByRole('option', { name: /Asha Rao/ }));
    expect(await screen.findByDisplayValue('Finance')).toBeInTheDocument();
  });
});
