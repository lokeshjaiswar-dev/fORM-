import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { parseDmsDate } from '@form/registry/profiles/dms-v1';
import { DmsApiError, DmsAuthError, createDmsClient } from '@/embed/dmsClient';
import { dismissReconnect, sessionSnapshot } from '@/embed/session/dmsSession';
import { installTestSession, resetTestSession, TEST_CREDENTIAL } from '@/embed/session/testing';
import masterFixtures from '@/embed/master/__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import { SECRET_MASK, type DmsRecordValues } from './contract';
import { DmsRecordRepository } from './DmsRecordRepository';

const API = fixtures.descriptor.add.apiBase;
const MASTER = fixtures.descriptor.add.masterId;
const RECORD = fixtures.descriptor.edit.recordId;

beforeEach(() => {
  installTestSession({ apiBase: API, context: { mode: 'dms-record', master_id: MASTER, record_id: RECORD } });
});
afterEach(() => resetTestSession());

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

/** The legacy path of a session path (`/dms/v1/formplus/s/master-records/x` is `/dms/master-records/x`): the fixtures are written in the legacy names. */
const legacyOf = (path: string): string => {
  const rest = path.replace('/dms/v1/formplus/s/', '');
  return rest.startsWith('master/form') ? `/dms/v1/${rest}` : `/dms/${rest}`;
};

/** An in-process fetch double answering from the fixture; records every call (`url` is the session URL the client really called). */
function dms(over: { master?: unknown; record?: unknown; patch?: Response; post?: Response; masterStatus?: number } = {}) {
  const calls: Call[] = [];
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchDouble = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    const path = legacyOf(url.slice(API.length));
    if (method === 'GET' && path === fixtures.loadMaster.request.path) return answer(over.masterStatus ?? 200, over.master ?? fixtures.loadMaster.response.body);
    if (method === 'GET' && path === fixtures.loadRecord.request.path) return answer(200, over.record ?? fixtures.loadRecord.response.body);
    if (method === 'POST' && path === fixtures.create.request.path) return over.post ?? answer(201, fixtures.create.response.body);
    if (method === 'PATCH' && path === fixtures.update.request.path) return over.patch ?? answer(200, fixtures.update.response.body);
    return answer(404, { message: `unexpected ${method} ${path}` });
  }) as typeof fetch;
  const client = createDmsClient({ apiBase: API, tenantId: 'tenant-1', workspaceId: 'ws-1', fetch: fetchDouble });
  return { calls, repo: new DmsRecordRepository({ apiBase: API, tenantId: 'tenant-1', workspaceId: 'ws-1' }, client) };
}

const seen = (calls: Call[]) => calls.map((c) => `${c.method} ${legacyOf(c.url.slice(API.length))}`);

const addValues: DmsRecordValues = { 'Vendor Name': 'Acme', Tier: 'Gold', Joined: '01-11-2026', Phone: '9876543210', Docs: 'must never be sent' };

describe('DmsRecordRepository.load', () => {
  it('add: reads the master only', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER);
    expect(seen(calls)).toEqual([`GET ${fixtures.loadMaster.request.path}`]);
    expect(loaded).toMatchObject({ masterId: MASTER, masterName: 'Vendor', source: 'formplus', recordId: null, values: {} });
    expect(loaded.elements).toHaveLength(5);
  });

  it('edit: reads the master then the record; values match expectedValuesById', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER, RECORD);
    expect(seen(calls)).toEqual([`GET ${fixtures.loadMaster.request.path}`, `GET ${fixtures.loadRecord.request.path}`]);
    const expected = fixtures.loadRecord.expectedValuesById as Record<string, string>;
    for (const el of loaded.elements) {
      const got = loaded.values[el.value as string]!;
      // Dates are stored DD-MM-YYYY and accepted either way (dmsToAnswer).
      expect(el.type === 'date' ? parseDmsDate(got) : got).toBe(el.type === 'date' ? parseDmsDate(expected[el.id]!) : expected[el.id]);
    }
  });

  it('a master that is not Forms+ has no elements and its record is never read', async () => {
    const body = structuredClone(fixtures.loadMaster.response.body);
    body.data.source = 'dms';
    const { repo, calls } = dms({ master: body });
    const loaded = await repo.load(MASTER, RECORD);
    expect(loaded).toMatchObject({ source: 'dms', elements: [], values: {} });
    expect(calls).toHaveLength(1);
  });

  it('a 401 parks the call for a reconnect; closing the prompt makes it an auth error, and with no session nothing is sent', async () => {
    const { repo } = dms({ masterStatus: 401, master: { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null } });
    const pending = repo.load(MASTER).catch((e: unknown) => e);
    await waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    dismissReconnect();
    expect(await pending).toBeInstanceOf(DmsAuthError);
    resetTestSession();
    const none = dms();
    await expect(none.repo.load(MASTER)).rejects.toBeInstanceOf(DmsAuthError);
    expect(none.calls).toHaveLength(0);
  });
});

describe('DmsRecordRepository.save', () => {
  it('add posts exactly the fixture create body, with the session credential and no tenant or workspace header', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER);
    const out = await repo.save(loaded, addValues);
    expect(out).toEqual({ recordId: fixtures.create.response.body.data.id });
    const post = calls[1]!;
    expect(post).toMatchObject({ method: 'POST', url: `${API}/dms/v1/formplus/s/master-records` });
    expect(post.body).toEqual(fixtures.create.request.body);
    expect(post.headers).toMatchObject({ Authorization: `Bearer ${TEST_CREDENTIAL}` });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).not.toContain('x-tenant-id');
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).not.toContain('x-workspace-id');
  });

  it('add sends every writable field as an empty string when blank, and no increment field', async () => {
    const master = structuredClone(fixtures.loadMaster.response.body);
    (master.data.form_builder_fields as unknown[]).push({ id: 'i1', type: 'numberinput', name: 'No', value: 'No', increment: true });
    const { repo, calls } = dms({ master });
    const loaded = await repo.load(MASTER);
    await repo.save(loaded, {});
    expect(calls[1]!.body).toEqual({ master_id: MASTER, json_data: { 'Vendor Name': '', Tier: '', Joined: '', Phone: '' } });
  });

  it('edit after changing Tier PATCHes exactly the fixture update body', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER, RECORD);
    const out = await repo.save(loaded, { ...loaded.values, Tier: 'Silver' });
    expect(out).toEqual({ recordId: RECORD });
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: `${API}/dms/v1/formplus/s/master-records/${RECORD}` });
    expect(calls[2]!.body).toEqual(fixtures.update.request.body);
  });

  it('an unchanged edit sends nothing and still answers with the record id', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER, RECORD);
    expect(await repo.save(loaded, { ...loaded.values })).toEqual({ recordId: RECORD });
    expect(calls).toHaveLength(2);
  });

  it.each([200, 422])('a validation error answered with HTTP %i is a DmsApiError carrying errors.json_data; nothing is retried', async (status) => {
    const { repo, calls } = dms({ patch: new Response(JSON.stringify(fixtures.validationError.response.body), { status }) });
    const loaded = await repo.load(MASTER, RECORD);
    const err = await repo.save(loaded, { ...loaded.values, Tier: 'Bronze' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DmsApiError);
    expect((err as DmsApiError).status).toBe(status);
    expect((err as DmsApiError).body).toEqual(fixtures.validationError.response.body);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('success:false on a 2xx is a refusal with the message', async () => {
    const { repo } = dms({ post: new Response(JSON.stringify({ success: false, message: 'Not allowed' }), { status: 200 }) });
    const loaded = await repo.load(MASTER);
    await expect(repo.save(loaded, addValues)).rejects.toThrow('Not allowed');
  });

  it('refuses to write a master that is not Forms+, before any request', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER);
    await expect(repo.save({ ...loaded, source: 'dms' }, addValues)).rejects.toThrow(/not been moved to Forms\+ yet/);
    expect(calls).toHaveLength(1);
  });

  it('every request stays on the apiBase', async () => {
    const { repo, calls } = dms();
    const a = await repo.load(MASTER);
    await repo.save(a, addValues);
    const b = await repo.load(MASTER, RECORD);
    await repo.save(b, { ...b.values, Tier: 'Silver' });
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) expect(c.url.startsWith(`${API}/`)).toBe(true);
  });
});

/* ── run dmsplus-int: secret and hidden fields (SEC-DESIGN 5.2, 5.3; fixture v2Cases) ───────────────────────────────────────────────── */

type V2 = { name: string; request: { method: string; path: string; body?: { json_data: Record<string, unknown> } }; response: { status: number; body: Record<string, unknown> } };
const recordCase = (name: string) => (fixtures.v2Cases.cases as unknown as V2[]).find((c) => c.name === name)!;
const masterCase = (name: string) => (masterFixtures.v2Cases.cases as unknown as V2[]).find((c) => c.name === name)!;
const VM = 'a1000000-0000-4000-8000-0000000000b1';
const VR = 'd3000000-0000-4000-8000-0000000000b1';

/** The Vendor Register of the additive fixture cases, read by a reader who can (`owner`) or cannot (`editor`) reveal hidden fields. */
function vendor(as: 'owner' | 'editor', over: { master?: unknown; patch?: Response; post?: Response } = {}) {
  installTestSession({ apiBase: API, context: { mode: 'dms-record', master_id: VM, record_id: VR, can: { reveal_fields: as === 'owner' } } });
  const calls: Call[] = [];
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const double = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    const path = legacyOf(url.slice(API.length));
    if (method === 'GET' && path === `/dms/v1/master/form/${VM}`) return answer(200, over.master ?? masterCase(as === 'owner' ? 'show-as-revealer' : 'show-as-non-revealer').response.body);
    if (method === 'GET' && path === `/dms/master-records/${VR}?master_id=${VM}`) return answer(200, recordCase(as === 'owner' ? 'load-masked-for-revealer' : 'load-masked-for-non-revealer').response.body);
    if (method === 'PATCH') return over.patch ?? answer(200, recordCase('update-partial-without-the-untouched-secret').response.body);
    if (method === 'POST') return over.post ?? answer(201, { success: true, data: { id: VR } });
    return answer(404, {});
  }) as typeof fetch;
  const client = createDmsClient({ apiBase: API, tenantId: 't', workspaceId: 'w', fetch: double });
  return { calls, repo: new DmsRecordRepository({ apiBase: API, tenantId: 't', workspaceId: 'w' }, client) };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

describe('DmsRecordRepository: reading masked and hidden cells', () => {
  it('a non-revealer: the secret cell reads as "has a value" (masked), never as the mask; the hidden field is not there', async () => {
    const { repo } = vendor('editor');
    const loaded = await repo.load(VM, VR);
    expect(loaded.masked).toEqual(['Tax Id']);
    expect(loaded.values['Tax Id']).toBe('');
    expect(loaded.values).not.toHaveProperty('Tax Id__masked');
    expect(loaded.values).not.toHaveProperty('Internal Note');
    expect(loaded.elements.map((e) => e.name)).not.toContain('Internal Note');
    expect(loaded.canReveal).toBe(false);
    expect(JSON.stringify(loaded)).not.toContain(SECRET_MASK);
  });

  it('a revealer also gets the hidden field and its value, but the secret stays masked for everyone', async () => {
    const { repo } = vendor('owner');
    const loaded = await repo.load(VM, VR);
    expect(loaded.values['Internal Note']).toBe('call back after the audit');
    expect(loaded.masked).toEqual(['Tax Id']);
    expect(loaded.values['Tax Id']).toBe('');
    expect(loaded.canReveal).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain(SECRET_MASK);
  });

  it('a hidden element the server sent anyway to a reader who cannot reveal is dropped (defence in depth), and never written', async () => {
    const owner = masterCase('show-as-revealer').response.body;
    const asNonRevealer = structuredClone(owner) as { data: { can: { reveal_fields: boolean } } };
    asNonRevealer.data.can.reveal_fields = false;
    const { repo, calls } = vendor('editor', { master: asNonRevealer });
    const loaded = await repo.load(VM, VR);
    expect(loaded.elements.map((e) => e.name)).not.toContain('Internal Note');
    await repo.save(loaded, { ...loaded.values, 'Vendor Code': '1043', 'Internal Note': 'x' });
    expect(JSON.stringify(writes(calls)[0]!.body)).not.toContain('Internal Note');
  });

  it('a stored mask with no __masked sibling (an older dms-api) still reads as a stored secret, never as a value', async () => {
    const { parseRecordCells } = await import('./contract');
    expect(parseRecordCells(JSON.stringify({ 'Vendor Name': 'Acme', 'Tax Id': SECRET_MASK }))).toEqual({ values: { 'Vendor Name': 'Acme', 'Tax Id': '' }, masked: ['Tax Id'] });
    expect(parseRecordCells({ 'Tax Id': 'x', 'Tax Id__masked': 'true' })).toEqual({ values: { 'Tax Id': '' }, masked: ['Tax Id'] });
    expect(parseRecordCells({ 'Tax Id': 'x', 'Tax Id__masked': false })).toEqual({ values: { 'Tax Id': 'x' }, masked: [] });
  });
});

describe('DmsRecordRepository: writing around secrets (T-DMSINT-60, record part)', () => {
  it('editing another field PATCHes exactly the fixture body: the untouched secret is absent', async () => {
    const { repo, calls } = vendor('owner');
    const loaded = await repo.load(VM, VR);
    await repo.save(loaded, { ...loaded.values, 'Vendor Code': '1043' });
    const patch = writes(calls);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body).toEqual(recordCase('update-partial-without-the-untouched-secret').request.body);
    expect(patch[0]!.url).toBe(`${API}/dms/v1/formplus/s/master-records/${VR}`);
  });

  it('a replaced secret is sent as the typed value, exactly the fixture body', async () => {
    const { repo, calls } = vendor('owner');
    const loaded = await repo.load(VM, VR);
    await repo.save(loaded, { ...loaded.values, 'Tax Id': '29ABCDE1234F1Z5' });
    expect(writes(calls)[0]!.body).toEqual(recordCase('update-replaces-a-secret').request.body);
  });

  it('the mask handed back as a value is never sent: with nothing else changed there is no request at all', async () => {
    const { repo, calls } = vendor('editor');
    const loaded = await repo.load(VM, VR);
    expect(await repo.save(loaded, { ...loaded.values, 'Tax Id': SECRET_MASK })).toEqual({ recordId: VR });
    expect(writes(calls)).toEqual([]);
  });

  it('the mask next to a real change is left out of the body; a blank secret is left out too', async () => {
    const { repo, calls } = vendor('owner');
    const loaded = await repo.load(VM, VR);
    await repo.save(loaded, { ...loaded.values, 'Vendor Code': '1043', 'Tax Id': SECRET_MASK });
    await repo.save(loaded, { ...loaded.values, 'Vendor Code': '1044', 'Tax Id': '' });
    for (const w of writes(calls)) expect(Object.keys((w.body as { json_data: object }).json_data)).toEqual(['Vendor Code']);
    expect(JSON.stringify(writes(calls))).not.toContain(SECRET_MASK);
  });

  it('a key ending in __masked is never sent, whoever passes it', async () => {
    const { repo, calls } = vendor('owner');
    const loaded = await repo.load(VM, VR);
    await repo.save(loaded, { ...loaded.values, 'Vendor Code': '1043', 'Tax Id__masked': 'true' });
    expect(JSON.stringify(writes(calls))).not.toContain('__masked');
  });

  it('create: a secret the person left blank or filled with the mask is sent as an empty string, never as the mask', async () => {
    const { repo, calls } = vendor('owner');
    const loaded = await repo.load(VM);
    await repo.save(loaded, { 'Vendor Name': 'Beta', 'Tax Id': SECRET_MASK });
    await repo.save(loaded, { 'Vendor Name': 'Gamma', 'Tax Id': '29ABCDE1234F1Z5' });
    const [first, second] = writes(calls).map((c) => (c.body as { json_data: Record<string, string> }).json_data);
    expect(first).toMatchObject({ 'Vendor Name': 'Beta', 'Tax Id': '' });
    expect(second).toMatchObject({ 'Vendor Name': 'Gamma', 'Tax Id': '29ABCDE1234F1Z5' });
    expect(JSON.stringify(writes(calls))).not.toContain(SECRET_MASK);
  });

  it.each([
    ['update-with-the-mask-as-value', 'SECRET_MASK_NOT_ALLOWED'],
    ['update-with-a-hidden-key-as-non-revealer', 'HIDDEN_FIELD_NOT_WRITABLE'],
  ])('dms-api answering %s reaches the page with its code (%s)', async (name, code) => {
    const c = recordCase(name);
    const { repo } = vendor('owner', { patch: new Response(JSON.stringify({ ...c.response.body, message: 'x', request_id: null }), { status: c.response.status }) });
    const loaded = await repo.load(VM, VR);
    await expect(repo.save(loaded, { ...loaded.values, 'Vendor Code': '1043' })).rejects.toMatchObject({ status: 422, code });
  });
});
