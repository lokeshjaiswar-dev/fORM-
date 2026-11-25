import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@dmacq/ui';
import fixtures from './__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import { AppRoutes } from '@/App';
import { currentLaunch, encodeDescriptor, resetLaunchMemo, type LaunchDescriptor } from '@/embed/launch';
import { DmsMasterPage } from '@/embed/master/DmsMasterPage';
import { describeDmsError } from '@/embed/master/describeDmsError';
import { DmsApiError } from '@/embed/dmsClient';
import { MemoryCustomFieldRepository, setCustomFieldRepository } from '@/fields/custom/repository';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { MemorySubmissions } from '@/test/fixtures';
import { currentDoc } from '@/state/documentStore';
import { act } from '@testing-library/react';

const ORIGIN = window.location.origin;
const MASTER = 'b9000000-0000-4000-8000-000000000001';
const SEVEN = ['Text Input', 'Number Input', 'Email', 'Phone Number', 'Multi-line Input', 'Dropdown', 'Date'];
const OTHERS = ['Short answer', 'Page break', 'Rating', 'Signature', 'Section break', 'Number', 'Long answer', 'Phone', 'File upload', 'Heading'];

const descriptor = (over: Partial<LaunchDescriptor> = {}): LaunchDescriptor => ({
  v: 1,
  mode: 'dms-master',
  profile: 'dms-v1',
  tenantId: 'acme',
  workspaceId: 'ws_1',
  master: { name: 'Vendor', doctypeIds: [], folderIds: [] },
  returnUrl: `${ORIGIN}/dms-v2/acme/metadata`,
  apiBase: `${ORIGIN}/api`,
  ...over,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const shown = (over: Record<string, unknown> = {}) => ({ success: true, message: 'ok', data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1', doctype_ids: [], folder_ids: [], form_builder_fields: fixtures.create.request.form_builder_fields, ...over } });

function open(d: LaunchDescriptor | null, navigate = vi.fn()) {
  window.history.replaceState(null, '', `/embed/dms-master${d ? `#fp=${encodeDescriptor(d)}` : ''}`);
  const view = render(
    <SubmissionsProvider repo={new MemorySubmissions()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/embed/dms-master']}>
          <DmsMasterPage navigate={navigate} />
        </MemoryRouter>
      </TooltipProvider>
    </SubmissionsProvider>,
  );
  return { navigate, ...view };
}

const READY = { timeout: 15_000 };
/** A reload keeps the tab's sessionStorage but not the page memory. */
const resetLaunchMemoOnly = () => {
  const keep = Object.fromEntries(Object.entries(sessionStorage));
  resetLaunchMemo();
  for (const [k, v] of Object.entries(keep)) sessionStorage.setItem(k, v);
};

beforeEach(() => {
  vi.stubEnv('VITE_FP_DMS_API_BASE', `${ORIGIN}/api`);
  resetLaunchMemo();
  setCustomFieldRepository(new MemoryCustomFieldRepository());
  localStorage.setItem('token', 'user-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe('/embed/dms-master', () => {
  it('shows exactly the seven DMS tiles, with DMS labels, and no page break, templates or library fields', async () => {
    vi.stubGlobal('fetch', vi.fn());
    open(descriptor());
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const palette = screen.getByRole('complementary', { name: '' }) ?? document.querySelector('aside');
    for (const label of SEVEN) expect(within(palette).getByRole('button', { name: label })).toBeInTheDocument();
    for (const label of OTHERS) expect(within(palette).queryByRole('button', { name: label })).toBeNull();
    const tiles = within(palette).getAllByRole('button').filter((b) => b.getAttribute('aria-roledescription') === 'draggable');
    expect(tiles.map((b) => b.textContent)).toEqual(SEVEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves a new master with POST to the descriptor apiBase and returns to DMS with fp_status=saved', async () => {
    const fetch = vi.fn().mockResolvedValue(json(201, shown()));
    vi.stubGlobal('fetch', fetch);
    const { navigate } = open(descriptor());
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    // The field was added with the tile's label; give it a name of its own and save.
    expect(Object.values(currentDoc().blocks)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/dms/v1/master/form`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer user-token', 'X-Tenant-Id': 'acme', 'X-Workspace-Id': 'ws_1' });
    const body = JSON.parse(String(init.body)) as { name: string; source: string; form_builder_fields: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ name: 'Vendor', source: 'formplus', classification: null, doctype_ids: [], folder_ids: [] });
    expect(body.form_builder_fields).toHaveLength(1);
    expect(body.form_builder_fields[0]).toMatchObject({ type: 'email', name: 'Email', value: 'Email', label: 'Email', required: false });
    expect(body.form_builder_fields[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/dms-v2/acme/metadata?fp_status=saved&fp_master_id=${MASTER}`));
  });

  it('lists what stops a save instead of sending it: a duplicate field name', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { navigate } = open(descriptor());
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Fix these before saving')).toBeInTheDocument();
    expect(screen.getByText(/Two fields are called "Email"/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens an existing Forms+ master from dms-api and Cancel returns with fp_status=cancelled', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, shown()));
    vi.stubGlobal('fetch', fetch);
    const { navigate } = open(descriptor({ masterId: MASTER, master: undefined }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    expect((fetch.mock.calls[0] as [string])[0]).toBe(`${ORIGIN}/api/dms/v1/master/form/${MASTER}`);
    expect(Object.values(currentDoc().blocks)).toHaveLength(7);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/dms-v2/acme/metadata?fp_status=cancelled`);
  });

  it('shows a "Sign in to DMS again" screen for a 401 on open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { message: 'Unauthenticated.' })));
    open(descriptor({ masterId: MASTER, master: undefined }));
    expect(await screen.findByRole('heading', { name: 'Sign in to DMS again' }, READY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', `${ORIGIN}/dms-v2/acme/metadata`);
  });

  it('refuses a master that is not a Forms+ master, and says why', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, shown({ source: 'dms' }))));
    open(descriptor({ masterId: MASTER, master: undefined }));
    expect(await screen.findByRole('heading', { name: 'This master cannot be edited here' }, READY)).toBeInTheDocument();
    expect(screen.getByText(/has not been converted to Forms\+/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByTestId('dms-master-builder')).toBeNull();
  });

  it('a master with no source is treated the same: notice, nothing editable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, shown({ source: null }))));
    open(descriptor({ masterId: MASTER, master: undefined }));
    expect(await screen.findByText(/has not been converted to Forms\+/, undefined, READY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });

  async function openAndEdit(fetch: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetch);
    open(descriptor({ masterId: MASTER, master: undefined, returnUrl: 'https://elsewhere.example.test/back' }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    return user;
  }

  it('shows MASTER_NOT_CONVERTED from a save as its own message and keeps the edit', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(200, shown())).mockResolvedValueOnce(json(422, { success: false, code: 'MASTER_NOT_CONVERTED', message: 'no', data: { master_id: MASTER, source: 'dms' } }));
    const user = await openAndEdit(fetch);
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText(/has not been converted to Forms\+, so it cannot be saved here/)).toBeInTheDocument();
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
  });

  it('SCHEMA_SYNC_FAILED saved:false: nothing saved, retry sends the same token', async () => {
    const fail = json(500, { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: MASTER, saved: false, updated_at: 'T1' } });
    const fetch = vi.fn().mockResolvedValueOnce(json(200, shown())).mockResolvedValueOnce(fail).mockResolvedValueOnce(json(200, shown({ updated_at: 'T2' })));
    const user = await openAndEdit(fetch);
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('The master was not saved')).toBeInTheDocument();
    expect(screen.getByText(/nothing was saved and the master is as it was/)).toBeInTheDocument();
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved to DMS');
    const sent = fetch.mock.calls.slice(1).map((c) => JSON.parse(String((c[1] as RequestInit).body)).updated_at);
    expect(sent).toEqual(['T1', 'T1']);
  });

  it('SCHEMA_SYNC_FAILED saved:true: the edit counts as saved, the new token is adopted, save again heals', async () => {
    const fail = json(500, { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: MASTER, saved: true, updated_at: 'T9' } });
    const fetch = vi.fn().mockResolvedValueOnce(json(200, shown())).mockResolvedValueOnce(fail).mockResolvedValueOnce(json(200, shown({ updated_at: 'T10' })));
    const user = await openAndEdit(fetch);
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Saved, but the data table needs another save')).toBeInTheDocument();
    expect(screen.getByText(/Your changes were saved/)).toBeInTheDocument();
    expect(screen.getByText('Saved in DMS')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved to DMS');
    const last = JSON.parse(String((fetch.mock.calls[2] as [string, RequestInit])[1].body));
    expect(last.updated_at).toBe('T9');
  });

  it('a create that fails with SCHEMA_SYNC_FAILED saved:true keeps the new masterId: save again PATCHes, never a second POST', async () => {
    const fail = json(500, { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: MASTER, saved: true, updated_at: 'T1' } });
    const fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(json(200, shown()));
    vi.stubGlobal('fetch', fetch);
    open(descriptor({ returnUrl: 'https://elsewhere.example.test/back' }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved, but the data table needs another save');
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved to DMS');
    expect(fetch.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['POST', 'PATCH']);
    expect(String(fetch.mock.calls[1]![0])).toContain(MASTER);
  });

  it('does not open without a launch descriptor, with a descriptor for another mode, or with an API base it does not trust', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const a = open(null);
    expect(await screen.findByRole('heading', { name: 'This page was not opened from DMS' })).toBeInTheDocument();
    a.unmount();
    resetLaunchMemo();
    const b = open(descriptor({ apiBase: 'https://evil.example.test/api' }));
    expect(await screen.findByText(/not set up to talk to/)).toBeInTheDocument();
    b.unmount();
    resetLaunchMemo();
    open(descriptor({ mode: 'dms-record' }));
    expect(await screen.findByText(/another DMS screen/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the cascading link for a dropdown in a DMS master, and the save carries linkedTo/optionParents', async () => {
    const U = (n: number) => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const el = (id: string, type: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type, name, value: name, label: name, required: false, placeholder: '', ...extra });
    const fields = [
      el(U(1), 'dropdown', 'Country', { options: [{ name: 'India', value: 'IN' }, { name: 'USA', value: 'US' }] }),
      el(U(2), 'dropdown', 'State', { options: [{ name: 'Goa', value: 'GA' }, { name: 'Texas', value: 'TX' }], linkedTo: U(1), optionParents: { GA: ['IN'], TX: ['US'] } }),
      el(U(3), 'email', 'Mail'),
    ];
    const fetch = vi.fn().mockResolvedValueOnce(json(200, shown({ form_builder_fields: fields }))).mockResolvedValueOnce(json(200, shown({ form_builder_fields: fields })));
    vi.stubGlobal('fetch', fetch);
    const { navigate } = open(descriptor({ masterId: MASTER, master: undefined }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    expect(screen.getAllByText('Linked to Country').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByText('State'));
    expect(await screen.findByRole('switch', { name: 'Link to an earlier question' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [, init] = fetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { form_builder_fields: Array<Record<string, unknown>> };
    const state = body.form_builder_fields.find((f) => f.name === 'State')!;
    expect(state.linkedTo).toBe(U(1));
    expect(state.optionParents).toEqual({ GA: ['IN'], TX: ['US'] });
    expect(body.form_builder_fields.find((f) => f.name === 'Country')).not.toHaveProperty('linkedTo');
  });

  it('hides the Logic and Privacy tabs of the block inspector (DMS forms have neither)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, shown())));
    open(descriptor({ masterId: MASTER, master: undefined }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const tabs = await screen.findAllByRole('tab', undefined, READY);
    const names = tabs.map((t) => t.textContent);
    expect(names).toContain('General');
    expect(names).not.toContain('Logic');
    expect(names).not.toContain('Privacy');
  });

  it('a create without an allowlisted returnUrl ends on Saved, and a reload then opens that master (GET) instead of POSTing again', async () => {
    const fetch = vi.fn().mockResolvedValue(json(201, shown()));
    vi.stubGlobal('fetch', fetch);
    const first = open(descriptor({ returnUrl: 'https://elsewhere.example.test/back' }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Saved to DMS')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    // A reload: no fragment in the address bar, a fresh page memory, the same tab storage.
    first.unmount();
    window.history.replaceState(null, '', '/embed/dms-master');
    const again = currentLaunch('dms-master', undefined, window.location);
    expect(again.ok && again.launch.masterId).toBe(MASTER);
    resetLaunchMemoOnly();
    const stored = currentLaunch('dms-master', undefined, window.location);
    expect(stored.ok && stored.launch.masterId).toBe(MASTER);
    fetch.mockResolvedValue(json(200, shown()));
    render(
      <SubmissionsProvider repo={new MemorySubmissions()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/embed/dms-master']}>
            <DmsMasterPage navigate={vi.fn()} />
          </MemoryRouter>
        </TooltipProvider>
      </SubmissionsProvider>,
    );
    await screen.findByTestId('dms-master-builder', undefined, READY);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1] as [string, RequestInit])[1].method).toBe('GET');
  });

  it('edits made while the save is in flight are not marked as saved, and the builder stays open', async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(json(200, shown())).mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    vi.stubGlobal('fetch', fetch);
    const { navigate } = open(descriptor({ masterId: MASTER, master: undefined }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    expect(screen.getByText('Saved in DMS')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Date' })); // in flight
    await act(async () => release(json(200, shown())));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save to DMS' })).toBeEnabled());
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clears the warnings and the "Save anyway" state when the doc changes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    open(descriptor({ returnUrl: 'https://elsewhere.example.test/back' }));
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Fix these before saving')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Date' }));
    await waitFor(() => expect(screen.queryByText('Fix these before saving')).toBeNull());
  });

  it('asks the browser to confirm leaving while there are changes not saved to DMS', async () => {
    vi.stubGlobal('fetch', vi.fn());
    open(descriptor());
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const leave = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(leave()).toBe(true));
  });

  it('does not ask "Changes you made may not be saved" when a save returns to DMS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(201, shown())));
    /* The browser fires beforeunload during the navigation itself, before React re-renders after the save. */
    const prompted: boolean[] = [];
    const navigate = vi.fn(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      prompted.push(e.defaultPrevented);
    });
    open(descriptor(), navigate);
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(prompted).toEqual([false]);
  });

  it('is routed at /embed/dms-master outside the fORM- session gate: no sign-in, no fORM- API call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    window.history.replaceState(null, '', `/embed/dms-master#fp=${encodeDescriptor(descriptor())}`);
    render(
      <SubmissionsProvider repo={new MemorySubmissions()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/embed/dms-master']}>
            <AppRoutes />
          </MemoryRouter>
        </TooltipProvider>
      </SubmissionsProvider>,
    );
    await screen.findByTestId('dms-master-builder', undefined, READY);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('describeDmsError', () => {
  it('explains the refusals dms-api documents', () => {
    expect(describeDmsError(new DmsApiError(409, 'x', 'MASTER_CHANGED', null))).toMatch(/Someone else changed this master/);
    expect(describeDmsError(new DmsApiError(409, 'Used by workflow W.', 2051, null))).toMatch(/running workflow uses this master/);
    expect(describeDmsError(new DmsApiError(404, 'x', 'ALREADY_EXISTS', null))).toMatch(/already exists/);
    expect(describeDmsError(new DmsApiError(503, 'x', 5031, null))).toMatch(/Workflows are not available/);
    expect(describeDmsError(new DmsApiError(403, 'x', null, null))).toMatch(/permission/);
    expect(describeDmsError(new DmsApiError(422, 'Bad.', 'DUPLICATE_FIELD_NAME', null))).toBe('Bad. (DUPLICATE_FIELD_NAME)');
    expect(describeDmsError(new DmsApiError(500, 'Boom.', null, null))).toBe('Boom.');
    expect(describeDmsError(new DmsApiError(422, 'x', 'MASTER_NOT_CONVERTED', null))).toMatch(/not been converted to Forms\+/);
    const sync = (saved: boolean) => new DmsApiError(500, 'x', 'SCHEMA_SYNC_FAILED', { data: { master_id: MASTER, saved, updated_at: 'T' } });
    expect(describeDmsError(sync(true))).toMatch(/changes were saved, but/);
    expect(describeDmsError(sync(false))).toMatch(/nothing was saved/);
    expect(describeDmsError(new Error('offline'))).toBe('offline');
    expect(describeDmsError('x')).toBe('The master could not be saved.');
  });
});
