import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import { encodeDescriptor, resetLaunchMemo, type LaunchDescriptor } from '@/embed/launch';
import { DmsRecordPage } from './DmsRecordPage';

const API = fixtures.descriptor.add.apiBase;
const RETURN = fixtures.descriptor.add.returnUrl;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

interface Call { method: string; path: string; body: unknown }

/** An in-process DMS answering from the fixture. */
function dms(over: { master?: unknown; record?: unknown; patch?: Response; post?: Response; masterStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(`${API}/`)).toBe(true);
    const method = init?.method ?? 'GET';
    const path = url.slice(API.length);
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

function open(d: LaunchDescriptor | null, navigate = vi.fn()) {
  window.history.replaceState(null, '', `/embed/dms-record${d ? `#fp=${encodeDescriptor(d)}` : ''}`);
  render(<DmsRecordPage navigate={navigate} />);
  return navigate;
}
const add = () => fixtures.descriptor.add as LaunchDescriptor;
const edit = () => fixtures.descriptor.edit as LaunchDescriptor;
const READY = { timeout: 15_000 };

beforeEach(() => {
  vi.stubEnv('VITE_FP_DMS_API_BASE', API);
  vi.stubEnv('VITE_FP_RETURN_ORIGINS', 'https://dms.example');
  resetLaunchMemo();
  localStorage.setItem('token', 'user-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe('/embed/dms-record launch', () => {
  it('refuses a descriptor of another mode and sends nothing', async () => {
    const calls = dms();
    open({ ...add(), mode: 'dms-master' });
    expect(await screen.findByText(/for another DMS screen/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it('without a launch it asks to start from DMS', () => {
    const calls = dms();
    open(null);
    expect(screen.getByText(/Open this page from DMS/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it('a descriptor without a master id is refused', () => {
    const calls = dms();
    const { masterId: _m, ...rest } = add();
    open(rest as LaunchDescriptor);
    expect(screen.getByText(/missing or unexpected details/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it('an apiBase that is not allowlisted is refused', () => {
    const calls = dms();
    open({ ...add(), apiBase: 'https://evil.example/api' });
    expect(screen.getByText(/not set up to talk to/)).toBeInTheDocument();
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
      expect(shown).toBe('2026-11-26');
      expect(json.Joined).toBe('26-11-2026');
    });
    it('America/New_York at 22:00 on 25 Nov (03:00Z on 26 Nov) shows and posts 25-11-2026', async () => {
      viewerAt('2026-11-26T03:00:00Z', 'America/New_York');
      expect(todayDms()).toBe('25-11-2026');
      const { shown, json } = await addWithDefault();
      expect(shown).toBe('2026-11-25');
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
    expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveValue('+919876543210');
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

  it('401 on save shows "Sign in to DMS again" and keeps the form and input', async () => {
    dms({ patch: json(401, { message: 'Unauthenticated.' }) });
    const navigate = open(edit());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ }, READY);
    const user = userEvent.setup();
    await user.type(name, 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Sign in to DMS again')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acmex');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('401 on load shows the sign-in screen and no form', async () => {
    dms({ masterStatus: 401, master: {} });
    open(edit());
    expect(await screen.findByText('Sign in to DMS again')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('no DMS token: sign-in screen, no request', async () => {
    localStorage.clear();
    const calls = dms();
    open(edit());
    expect(await screen.findByText('Sign in to DMS again')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('/embed/dms-record non-Forms+ master', () => {
  it('shows the notice, no form, and reads no record', async () => {
    const body = structuredClone(fixtures.loadMaster.response.body);
    body.data.source = 'dms';
    const calls = dms({ master: body });
    open(edit());
    expect(await screen.findByText('This master has not been converted to Forms+')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
