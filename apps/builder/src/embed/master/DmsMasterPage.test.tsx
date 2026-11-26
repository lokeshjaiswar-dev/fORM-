import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@dmacq/ui';
import fixtures from './__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import { currentLaunch } from '@/embed/launch';
import { DmsMasterPage } from '@/embed/master/DmsMasterPage';
import { dismissReconnect, sessionSnapshot } from '@/embed/session/dmsSession';
import { MemoryCustomFieldRepository, setCustomFieldRepository } from '@/fields/custom/repository';
import { resetTestSession, TEST_CREDENTIAL } from '@/embed/session/testing';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { MemorySubmissions } from '@/test/fixtures';
import { currentDoc } from '@/state/documentStore';
import { BASE, ELSEWHERE, fakeFetch, installMaster, json, MASTER, READY, RETURN, renderMaster, seedOf, shown } from './pageHarness';

/*
 * /embed/dms-master under the ticket launch (run dmsplus-int): the page keeps calling `currentLaunch()` and `createDmsClient()`, which
 * return session-backed objects. The launch itself (fragment, exchange, reconnect) is `session/SessionGate`'s and is tested there; these tests
 * install the session a successful exchange leaves and exercise the page. Removal consent has its own file (DmsMasterPage.removal.test.tsx).
 */

const SEVEN = ['Text Input', 'Number Input', 'Email', 'Phone Number', 'Multi-line Input', 'Dropdown', 'Date'];
const OTHERS = ['Short answer', 'Page break', 'Rating', 'Signature', 'Section break', 'Number', 'Long answer', 'Phone', 'File upload', 'Heading'];
const FIELDS = fixtures.create.request.form_builder_fields;
const SESSION = `${BASE}/dms/v1/formplus/s`;

beforeEach(() => {
  setCustomFieldRepository(new MemoryCustomFieldRepository());
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetTestSession();
});

/** Answers GET with the master and any write with `write`. */
const dms = (write: () => Response = () => json(200, shown(FIELDS, { updated_at: 'T2' })), master: () => Response = () => json(200, shown(FIELDS))) =>
  fakeFetch((c) => (c.method === 'GET' ? master() : write()));

describe('/embed/dms-master', () => {
  it('shows exactly the seven DMS tiles, with DMS labels, and no page break, templates or library fields', async () => {
    const { fetch } = fakeFetch(() => json(500, {}));
    installMaster();
    renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const palette = screen.getByRole('complementary', { name: '' }) ?? document.querySelector('aside');
    for (const label of SEVEN) expect(within(palette).getByRole('button', { name: label })).toBeInTheDocument();
    for (const label of OTHERS) expect(within(palette).queryByRole('button', { name: label })).toBeNull();
    const tiles = within(palette).getAllByRole('button').filter((b) => b.getAttribute('aria-roledescription') === 'draggable');
    expect(tiles.map((b) => b.textContent)).toEqual(SEVEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves a new master with POST to the session route, the seed classification, and returns to DMS with fp_status=saved', async () => {
    const { seen } = fakeFetch(() => json(201, shown(FIELDS)));
    installMaster({ seed: seedOf({ classification: 'confidential' }) });
    const { navigate } = renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    expect(Object.values(currentDoc().blocks)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    const [post] = seen;
    expect(post!.url).toBe(`${SESSION}/master/form`);
    expect(post!.method).toBe('POST');
    expect(post!.headers).toMatchObject({ Authorization: `Bearer ${TEST_CREDENTIAL}` });
    expect(Object.keys(post!.headers).map((h) => h.toLowerCase())).not.toContain('x-tenant-id');
    const body = post!.body as { name: string; source: string; form_builder_fields: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ name: 'Vendor', source: 'formplus', classification: 'confidential', doctype_ids: [], folder_ids: [] });
    expect(body.form_builder_fields).toHaveLength(1);
    expect(body.form_builder_fields[0]).toMatchObject({ type: 'email', name: 'Email', value: 'Email', label: 'Email', required: false });
    expect(body.form_builder_fields[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${RETURN}?fp_status=saved&fp_master_id=${MASTER}`));
  });

  it('a create from a seed with no classification posts null', async () => {
    const { seen } = fakeFetch(() => json(201, shown(FIELDS)));
    installMaster({ seed: seedOf({ classification: null }) });
    renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect((seen[0]!.body as { classification: unknown }).classification).toBeNull();
  });

  it('lists what stops a save instead of sending it: a duplicate field name', async () => {
    const { fetch } = fakeFetch(() => json(500, {}));
    installMaster();
    const { navigate } = renderMaster();
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
    const { seen } = dms();
    installMaster({ masterId: MASTER });
    const { navigate } = renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    expect(seen[0]!.url).toBe(`${SESSION}/master/form/${MASTER}`);
    expect(Object.values(currentDoc().blocks)).toHaveLength(7);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigate).toHaveBeenCalledWith(`${RETURN}?fp_status=cancelled`);
  });

  it('shows a "Sign in to DMS again" screen when the session ended and the person dismissed the reconnect prompt', async () => {
    fakeFetch(() => json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }));
    installMaster({ masterId: MASTER });
    renderMaster();
    // The 401 parks the call and the prompt is offered; closing it fails the call with DmsAuthError.
    await waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    act(() => dismissReconnect());
    expect(await screen.findByRole('heading', { name: 'Sign in to DMS again' }, READY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', RETURN);
  });

  it('refuses a master that is not a Forms+ master, says why, and Back to DMS returns fp_status=error&fp_code=MASTER_NOT_CONVERTED', async () => {
    fakeFetch(() => json(200, shown(FIELDS, { source: 'dms' })));
    installMaster({ masterId: MASTER });
    renderMaster();
    expect(await screen.findByRole('heading', { name: 'This master cannot be edited here' }, READY)).toBeInTheDocument();
    expect(screen.getByText(/has not been moved to Forms\+ yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByTestId('dms-master-builder')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', `${RETURN}?fp_status=error&fp_master_id=${MASTER}&fp_code=MASTER_NOT_CONVERTED`);
  });

  it('a master with no source is treated the same: notice, nothing editable', async () => {
    fakeFetch(() => json(200, shown(FIELDS, { source: null })));
    installMaster({ masterId: MASTER });
    renderMaster();
    expect(await screen.findByText(/has not been moved to Forms\+ yet/, undefined, READY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });

  async function openAndEdit(answer: Parameters<typeof fakeFetch>[0], over: Parameters<typeof installMaster>[0] = {}) {
    const f = fakeFetch(answer);
    installMaster({ masterId: MASTER, returnUrl: ELSEWHERE, ...over });
    renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    return { user, ...f };
  }

  it('shows MASTER_NOT_CONVERTED from a save as its own message with its reference, and keeps the edit', async () => {
    const { user } = await openAndEdit((c) => (c.method === 'GET' ? json(200, shown(FIELDS)) : json(422, { success: false, code: 'MASTER_NOT_CONVERTED', message: 'no', request_id: '7e000000-0000-4000-8000-000000000001' })));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('This master has not been moved to Forms+ yet.')).toBeInTheDocument();
    expect(screen.getByText('Reference: 7e000000-0000-4000-8000-000000000001')).toBeInTheDocument();
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
  });

  it('SCHEMA_SYNC_FAILED saved:false: nothing saved, retry sends the same token', async () => {
    const fail = json(500, { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: MASTER, saved: false, updated_at: 'T1' } });
    let writes = 0;
    const { user, seen } = await openAndEdit((c) => {
      if (c.method === 'GET') return json(200, shown(FIELDS));
      writes += 1;
      return writes === 1 ? fail : json(200, shown(FIELDS, { updated_at: 'T2' }));
    });
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('The master was not saved')).toBeInTheDocument();
    expect(screen.getByText(/nothing was saved and the master is as it was/)).toBeInTheDocument();
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved to DMS');
    expect(seen.filter((c) => c.method === 'PATCH').map((c) => (c.body as { updated_at: string }).updated_at)).toEqual(['T1', 'T1']);
  });

  it('SCHEMA_SYNC_FAILED saved:true: the edit counts as saved, the new token is adopted, save again heals', async () => {
    const fail = json(500, { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: MASTER, saved: true, updated_at: 'T9' } });
    let writes = 0;
    const { user, seen } = await openAndEdit((c) => {
      if (c.method === 'GET') return json(200, shown(FIELDS));
      writes += 1;
      return writes === 1 ? fail : json(200, shown(FIELDS, { updated_at: 'T10' }));
    });
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Saved, but the data table needs another save')).toBeInTheDocument();
    expect(screen.getByText(/Your changes were saved/)).toBeInTheDocument();
    expect(screen.getByText('Saved in DMS')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved to DMS');
    const patches = seen.filter((c) => c.method === 'PATCH');
    expect((patches[1]!.body as { updated_at: string }).updated_at).toBe('T9');
  });

  it('a create that fails with SCHEMA_SYNC_FAILED saved:true keeps the new masterId: save again PATCHes, never a second POST', async () => {
    const fail = json(500, { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: MASTER, saved: true, updated_at: 'T1' } });
    let writes = 0;
    const { seen } = fakeFetch(() => {
      writes += 1;
      return writes === 1 ? fail : json(200, shown(FIELDS));
    });
    installMaster({ returnUrl: ELSEWHERE });
    renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved, but the data table needs another save');
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await screen.findByText('Saved to DMS');
    expect(seen.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(seen[1]!.url).toContain(MASTER);
  });

  it('does not open without a launch, or with a session for another screen', async () => {
    const { fetch } = fakeFetch(() => json(500, {}));
    const a = renderMaster();
    expect(await screen.findByRole('heading', { name: 'This page was not opened from DMS' })).toBeInTheDocument();
    a.unmount();
    resetTestSession();
    installMaster({ mode: 'dms-record', masterId: MASTER });
    renderMaster();
    expect(await screen.findByRole('heading', { name: 'This page was not opened from DMS' })).toBeInTheDocument();
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
    const { seen } = fakeFetch(() => json(200, shown(fields)));
    installMaster({ masterId: MASTER });
    renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    expect(screen.getAllByText('Linked to Country').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByText('State'));
    expect(await screen.findByRole('switch', { name: 'Link to an earlier question' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(seen).toHaveLength(2));
    const body = seen[1]!.body as { form_builder_fields: Array<Record<string, unknown>> };
    const state = body.form_builder_fields.find((f) => f.name === 'State')!;
    expect(state.linkedTo).toBe(U(1));
    expect(state.optionParents).toEqual({ GA: ['IN'], TX: ['US'] });
    expect(body.form_builder_fields.find((f) => f.name === 'Country')).not.toHaveProperty('linkedTo');
  });

  it('hides the Logic and Privacy tabs of the block inspector (DMS forms have neither)', async () => {
    dms();
    installMaster({ masterId: MASTER });
    renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const tabs = await screen.findAllByRole('tab', undefined, READY);
    const names = tabs.map((t) => t.textContent);
    expect(names).toContain('General');
    expect(names).not.toContain('Logic');
    expect(names).not.toContain('Privacy');
  });

  it('a create without an allowlisted returnUrl ends on Saved, and the page then knows the master: a fresh page opens it (GET) instead of POSTing again', async () => {
    const { seen } = fakeFetch(() => json(201, shown(FIELDS)));
    installMaster({ returnUrl: ELSEWHERE });
    const first = renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Saved to DMS')).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    // The launch of this page is now "edit this master": a remount reads the master instead of creating a second one.
    first.unmount();
    const again = currentLaunch('dms-master');
    expect(again.ok && again.launch.masterId).toBe(MASTER);
    seen.length = 0;
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
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
  });

  it('edits made while the save is in flight are not marked as saved, and the builder stays open', async () => {
    let release!: (r: Response) => void;
    const { seen } = fakeFetch((c) => (c.method === 'GET' ? json(200, shown(FIELDS)) : new Promise<Response>((r) => (release = r))));
    installMaster({ masterId: MASTER });
    const { navigate } = renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    expect(screen.getByText('Saved in DMS')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(seen).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Date' })); // in flight
    await act(async () => release(json(200, shown(FIELDS))));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save to DMS' })).toBeEnabled());
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clears the warnings and the "Save anyway" state when the doc changes', async () => {
    fakeFetch(() => json(500, {}));
    installMaster({ returnUrl: ELSEWHERE });
    renderMaster();
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
    fakeFetch(() => json(500, {}));
    installMaster();
    renderMaster();
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
    fakeFetch(() => json(201, shown(FIELDS)));
    installMaster();
    /* The browser fires beforeunload during the navigation itself, before React re-renders after the save. */
    const prompted: boolean[] = [];
    const navigate = vi.fn(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      prompted.push(e.defaultPrevented);
    });
    renderMaster(navigate);
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(prompted).toEqual([false]);
  });
});

describe('/embed/dms-master load errors (DESIGN 3.4, 3.5): a terminal code gives "Back to DMS" with fp_status=error', () => {
  const envelope = (status: number, code: string) => json(status, { success: false, code, message: 'server wording', request_id: '7e000000-0000-4000-8000-0000000000aa' });

  it.each([
    [404, 'NOT_FOUND', 'This master or record is not available.'],
    [403, 'FORBIDDEN_RIGHT', 'You do not have permission to do this.'],
    [403, 'FP_SCOPE_DENIED', 'This form cannot do that. Go back to DMS and open it again.'],
    [422, 'MASTER_NOT_CONVERTED', 'This master has not been moved to Forms+ yet.'],
  ] as const)('%i %s: the contract message, the reference, and a return link carrying the code', async (status, code, message) => {
    fakeFetch(() => envelope(status, code));
    installMaster({ masterId: MASTER });
    renderMaster();
    expect(await screen.findByRole('heading', { name: 'This master cannot be opened' }, READY)).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText('Reference: 7e000000-0000-4000-8000-0000000000aa')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', `${RETURN}?fp_status=error&fp_master_id=${MASTER}&fp_code=${code}`);
    expect(screen.queryByTestId('dms-master-builder')).toBeNull();
  });

  it('a load failure that is not terminal (the server is down) gets the plain return link, no error status', async () => {
    fakeFetch(() => envelope(503, 'LAUNCH_STORE_UNAVAILABLE'));
    installMaster({ masterId: MASTER });
    renderMaster();
    expect(await screen.findByText('Forms+ is temporarily unavailable. Try again in a moment.', undefined, READY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', RETURN);
  });

  it('a save failure stays in the page: the message, the reference, the edit kept, no navigation', async () => {
    fakeFetch((c) => (c.method === 'GET' ? json(200, shown(FIELDS)) : envelope(403, 'FIELD_VISIBILITY_FORBIDDEN')));
    installMaster({ masterId: MASTER });
    const { navigate } = renderMaster();
    await screen.findByTestId('dms-master-builder', undefined, READY);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText('Only the master creator, an owner or an administrator can change hidden or secret settings.')).toBeInTheDocument();
    expect(screen.getByText('Reference: 7e000000-0000-4000-8000-0000000000aa')).toBeInTheDocument();
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
