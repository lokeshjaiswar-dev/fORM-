import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionContext } from '@/embed/contract';
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import { dismissReconnect, sessionSnapshot } from '@/embed/session/dmsSession';
import { installTestSession, resetTestSession } from '@/embed/session/testing';
import { DmsRecordPage } from './DmsRecordPage';

/*
 * /embed/dms-record under the ticket launch (run dmsplus-int): the session a successful exchange leaves is installed (`installRecord`), the
 * page keeps calling `currentLaunch()` and `createDmsClient()`, and the DMS double answers from the fixture on the session routes the client
 * maps to (DESIGN 3.3). The secret-field cases are in DmsRecordPage.secret.test.tsx.
 */

const API = fixtures.descriptor.add.apiBase;
/** A return URL on the origin the test build lists as a return origin (`session/testing.ts`). */
const RETURN = 'https://dms.example.test/dms/tenant-1/documents/master';
const MASTER_ID = fixtures.descriptor.add.masterId;
const RECORD_ID = fixtures.descriptor.edit.recordId;

/** The legacy path of a session path (`/dms/v1/formplus/s/master-records/x` is `/dms/master-records/x`): the fixtures are written in the legacy names. */
const legacyOf = (path: string): string => {
  const rest = path.replace('/dms/v1/formplus/s/', '');
  return rest.startsWith('master/form') ? `/dms/v1/${rest}` : `/dms/${rest}`;
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

interface Call { method: string; path: string; body: unknown }

/** An in-process DMS answering from the fixture. */
function dms(over: { master?: unknown; record?: unknown; patch?: Response; post?: Response; masterStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(`${API}/dms/v1/formplus/s/`)).toBe(true);
    const method = init?.method ?? 'GET';
    const path = legacyOf(url.slice(API.length));
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET' && path === fixtures.loadMaster.request.path) return json(over.masterStatus ?? 200, over.master ?? fixtures.loadMaster.response.body);
    if (method === 'GET' && path === fixtures.loadRecord.request.path) return json(200, over.record ?? fixtures.loadRecord.response.body);
    if (method === 'POST' && path === fixtures.create.request.path) return over.post ?? json(201, fixtures.create.response.body);
    if (method === 'PATCH' && path === fixtures.update.request.path) return over.patch ?? json(200, fixtures.update.response.body);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

/** The session of a record launch: `add` (no record id) or `edit`. */
function installRecord(kind: 'add' | 'edit', over: Partial<SessionContext> = {}) {
  installTestSession({
    apiBase: API,
    context: { mode: 'dms-record', master_id: MASTER_ID, record_id: kind === 'edit' ? RECORD_ID : null, master_seed: null, return_url: RETURN, ...over },
  });
}
function open(kind: 'add' | 'edit' | null, navigate = vi.fn(), over: Partial<SessionContext> = {}) {
  if (kind !== null) installRecord(kind, over);
  render(<DmsRecordPage navigate={navigate} />);
  return navigate;
}
const add = () => 'add' as const;
const edit = () => 'edit' as const;
const READY = { timeout: 15_000 };

afterEach(() => {
  vi.unstubAllGlobals();
  resetTestSession();
});

describe('/embed/dms-record launch', () => {
  it('a session for another screen (a master builder launch) is not this page\'s: it asks to start from DMS and sends nothing', async () => {
    const calls = dms();
    installTestSession({ apiBase: API, context: { mode: 'dms-master', master_id: MASTER_ID, record_id: null, master_seed: null, return_url: RETURN } });
    render(<DmsRecordPage navigate={vi.fn()} />);
    expect(await screen.findByText(/Open this page from DMS/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it('without a launch it asks to start from DMS', () => {
    const calls = dms();
    open(null);
    expect(screen.getByText(/Open this page from DMS/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it('a record launch without a master id is refused', () => {
    const calls = dms();
    open('add', vi.fn(), { master_id: null });
    expect(screen.getByText(/missing or unexpected details/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

/** The fixture master with the Joined date defaulting to today (what the converter writes for prefill_today). */
const withTodayDefault = () => {
  const m = structuredClone(fixtures.loadMaster.response.body);
  const joined = m.data.form_builder_fields.find((f) => f.name === 'Joined')!;
  (joined as { isDefaultToDate: boolean }).isDefaultToDate = true;
  return m;
};
/** Today in the viewer's own zone (not UTC), in the DMS format. */
const todayDms = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
  return `${d}-${mo}-${y}`;
};

/** Pins the clock (Date only, so timers and promises still run) and the viewer's zone as the browser reports it. */
function viewerAt(instant: string, timeZone: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(instant));
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}

async function addWithDefault() {
  const calls = dms({ master: withTodayDefault() });
  const navigate = open(add());
  const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
  const shown = (screen.getByLabelText(/Joined/) as HTMLInputElement).value;
  const user = userEvent.setup();
  await user.type(name, 'Acme');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  return { shown, json: (calls.find((c) => c.method === 'POST')!.body as { json_data: Record<string, string> }).json_data };
}

describe('/embed/dms-record date default (isDefaultToDate)', () => {
  it('edit: a record with no stored date shows none, and changing only Tier PATCHes {Tier}', async () => {
    const rec = structuredClone(fixtures.loadRecord.response.body);
    rec.data.json_data = JSON.stringify({ ...JSON.parse(rec.data.json_data), Joined: '' });
    const calls = dms({ master: withTodayDefault(), record: rec });
    const navigate = open(edit());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: /Tier/ }), 'Silver');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect((writes[0]!.body as { json_data: unknown }).json_data).toEqual({ Tier: 'Silver' });
  });
  it('edit: the same record saved unchanged sends nothing', async () => {
    const rec = structuredClone(fixtures.loadRecord.response.body);
    rec.data.json_data = JSON.stringify({ ...JSON.parse(rec.data.json_data), Joined: '' });
    const calls = dms({ master: withTodayDefault(), record: rec });
    const navigate = open(edit());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
  it('add: an untouched default date is posted as today in the DMS format', async () => {
    expect((await addWithDefault()).json.Joined).toBe(todayDms());
  });
  describe('today is the viewer\'s local date, not the UTC date', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    it('Asia/Kolkata at 01:30 IST on 26 Nov (20:00Z on 25 Nov) shows and posts 26-11-2026', async () => {
      viewerAt('2026-11-25T20:00:00Z', 'Asia/Kolkata');
      expect(todayDms()).toBe('26-11-2026');
      const { shown, json } = await addWithDefault();
      expect(shown).toBe('26-11-2026');
      expect(json.Joined).toBe('26-11-2026');
    });
    it('America/New_York at 22:00 on 25 Nov (03:00Z on 26 Nov) shows and posts 25-11-2026', async () => {
      viewerAt('2026-11-26T03:00:00Z', 'America/New_York');
      expect(todayDms()).toBe('25-11-2026');
      const { shown, json } = await addWithDefault();
      expect(shown).toBe('25-11-2026');
      expect(json.Joined).toBe('25-11-2026');
    });
  });
});

describe('/embed/dms-record add', () => {
  it('shows the master fields, posts the typed values and returns with the new record id', async () => {
    const calls = dms();
    const navigate = open(add());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, 'Acme');
    await user.type(screen.getByRole('textbox', { name: /Phone/ }), '9876543210');
    // The legacy field is shown, read-only.
    expect(screen.getByRole('textbox', { name: /Docs/ })).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ master_id: fixtures.create.request.body.master_id });
    const sent = (post.body as { json_data: Record<string, string> }).json_data;
    expect(sent).toMatchObject({ 'Vendor Name': 'Acme', Phone: '9876543210' });
    expect(Object.keys(sent)).not.toContain('Docs');
    expect(navigate).toHaveBeenCalledWith(`${RETURN}?${fixtures.return.saved}`);
  });

  it('does not ask "Changes you made may not be saved" when a save returns to DMS', async () => {
    dms();
    const prompted: boolean[] = [];
    const navigate = vi.fn(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      prompted.push(e.defaultPrevented);
    });
    open(add(), navigate);
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, 'Acme');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(prompted).toEqual([false]);
  });

  it('does not send when a required field is empty', async () => {
    const calls = dms();
    const navigate = open(add());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.querySelector('[aria-invalid="true"], [role="alert"]')).not.toBeNull());
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cancel returns with fp_status=cancelled and writes nothing', async () => {
    const calls = dms();
    const navigate = open(add());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigate).toHaveBeenCalledWith(`${RETURN}?${fixtures.return.cancelled}`);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});

describe('/embed/dms-record edit', () => {
  it('loads the stored values, keeps legacy read-only, and an unchanged save sends nothing but returns saved', async () => {
    const calls = dms();
    const navigate = open(edit());
    expect(await screen.findByRole('textbox', { name: /Vendor Name/ }, READY)).toHaveValue('Acme');
    expect(screen.getByRole('textbox', { name: /Docs/ })).toHaveValue('doc-1,doc-2');
    expect(screen.getByRole('textbox', { name: /Docs/ })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveValue('9876543210');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(navigate).toHaveBeenCalledWith(`${RETURN}?${fixtures.return.saved}`);
  });

  it('changing Tier PATCHes exactly the fixture update body', async () => {
    const calls = dms();
    const navigate = open(edit());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: /Tier/ }), 'Silver');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const patch = calls.filter((c) => c.method !== 'GET');
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({ method: 'PATCH', path: fixtures.update.request.path });
    expect(patch[0]!.body).toEqual(fixtures.update.request.body);
    expect(navigate).toHaveBeenCalledWith(`${RETURN}?${fixtures.return.saved}`);
  });

  it.each([200, 422])('a validation error (HTTP %i) shows the DMS lines and keeps what was typed', async (status) => {
    dms({ patch: json(status, fixtures.validationError.response.body) });
    const navigate = open(edit());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, ' Ltd');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(fixtures.validationError.response.body.errors.json_data[0]!)).toBeInTheDocument();
    expect(screen.getByText('The record was not saved')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme Ltd');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('success:false shows the message', async () => {
    dms({ patch: json(409, { success: false, message: 'Record is locked' }) });
    open(edit());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Record is locked')).toBeInTheDocument();
  });

  it('a session that ended mid-save parks the save; closing the reconnect prompt shows "Sign in to DMS again" and keeps the form and input', async () => {
    dms({ patch: json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }) });
    const navigate = open(edit());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    act(() => dismissReconnect());
    expect(await screen.findByText('Sign in to DMS again')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acmex');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a session that ended on load shows the sign-in screen and no form', async () => {
    dms({ masterStatus: 401, master: { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null } });
    open(edit());
    await waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    act(() => dismissReconnect());
    expect(await screen.findByText('Sign in to DMS again')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('/embed/dms-record load errors (DESIGN 3.4, 3.5): a terminal code gives "Back to DMS" with fp_status=error', () => {
  const envelope = (code: string) => ({ success: false, code, message: 'server wording', request_id: '7e000000-0000-4000-8000-0000000000dd' });

  it.each([
    [404, 'NOT_FOUND', 'This master or record is not available.'],
    [403, 'FORBIDDEN_RIGHT', 'You do not have permission to do this.'],
    [403, 'FP_SCOPE_DENIED', 'This form cannot do that. Go back to DMS and open it again.'],
    [422, 'MASTER_NOT_CONVERTED', 'This master has not been moved to Forms+ yet.'],
  ] as const)('%i %s: the contract message, the reference and a return link carrying the code', async (status, code, message) => {
    dms({ masterStatus: status, master: envelope(code) });
    open(edit());
    expect(await screen.findByText('This record cannot be opened', undefined, READY)).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText('Reference: 7e000000-0000-4000-8000-0000000000dd')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', `${RETURN}?fp_status=error&fp_master_id=${MASTER_ID}&fp_code=${code}`);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a load failure that is not terminal gets the plain return link', async () => {
    dms({ masterStatus: 503, master: envelope('LAUNCH_STORE_UNAVAILABLE') });
    open(edit());
    expect(await screen.findByText('Forms+ is temporarily unavailable. Try again in a moment.', undefined, READY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', RETURN);
  });

  it('a save failure stays in the page with its message and reference, and the typed value kept', async () => {
    dms({ patch: json(422, envelope('SECRET_MASK_NOT_ALLOWED')) });
    const navigate = open(edit());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A masked secret cannot be saved as a value. Enter the real value or leave the field empty.')).toBeInTheDocument();
    expect(screen.getByText('Reference: 7e000000-0000-4000-8000-0000000000dd')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme!');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('/embed/dms-record non-Forms+ master', () => {
  it('shows the notice, no form, and reads no record', async () => {
    const body = structuredClone(fixtures.loadMaster.response.body);
    body.data.source = 'dms';
    const calls = dms({ master: body });
    open(edit());
    expect(await screen.findByText('This master has not been moved to Forms+ yet', undefined, READY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', `${RETURN}?fp_status=error&fp_master_id=${MASTER_ID}&fp_code=MASTER_NOT_CONVERTED`);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('/embed/dms-record linked dropdowns (linkedTo / optionParents)', () => {
  const master = () => {
    const body = structuredClone(fixtures.loadMaster.response.body) as { data: { form_builder_fields: Array<Record<string, unknown>> } };
    const tier = body.data.form_builder_fields.find((f) => f.name === 'Tier')!;
    body.data.form_builder_fields.push({
      id: 'c2000000-0000-4000-8000-000000000106', type: 'dropdown', name: 'City', value: 'City', label: 'City', required: false, placeholder: '',
      options: [{ name: 'Mumbai', value: 'Mumbai' }, { name: 'Delhi', value: 'Delhi' }, { name: 'Other', value: 'Other' }],
      linkedTo: tier.id, optionParents: { Mumbai: ['Gold'], Delhi: ['Silver'] },
    });
    return body;
  };
  const record = (city: string) => {
    const body = structuredClone(fixtures.loadRecord.response.body) as { data: { json_data: string } };
    body.data.json_data = JSON.stringify({ ...JSON.parse(body.data.json_data), City: city });
    return body;
  };
  const optionsOf = (name: RegExp) => Array.from((screen.getByRole('combobox', { name }) as HTMLSelectElement).options).map((o) => o.textContent);

  it('offers only the options the stored parent allows, and an unchanged save sends nothing', async () => {
    const calls = dms({ master: master(), record: record('Mumbai') });
    const navigate = open(edit());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    await waitFor(() => expect(optionsOf(/City/)).toContain('Mumbai'));
    expect(optionsOf(/City/)).not.toContain('Delhi');
    expect(optionsOf(/City/)).toContain('Other');
    expect(screen.getByRole('combobox', { name: /City/ })).toHaveDisplayValue('Mumbai');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('changing the parent clears a child value it no longer allows, and the new child value is written', async () => {
    const calls = dms({ master: master(), record: record('Mumbai') });
    const navigate = open(edit());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: /Tier/ }), 'Silver');
    await waitFor(() => expect(optionsOf(/City/)).toContain('Delhi'));
    expect(optionsOf(/City/)).not.toContain('Mumbai');
    expect(screen.getByRole('combobox', { name: /City/ })).not.toHaveDisplayValue('Mumbai');
    await user.selectOptions(screen.getByRole('combobox', { name: /City/ }), 'Delhi');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const patch = calls.filter((c) => c.method !== 'GET');
    expect(patch).toHaveLength(1);
    expect(JSON.stringify(patch[0]!.body)).toContain('Delhi');
    expect(JSON.stringify(patch[0]!.body)).toContain('Silver');
  });

  it('a stored child value the parent never allowed is not shown, and an untouched save leaves what DMS stores', async () => {
    const calls = dms({ master: master(), record: record('Delhi') });
    const navigate = open(edit());
    await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /City/ })).not.toHaveDisplayValue('Delhi'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});
