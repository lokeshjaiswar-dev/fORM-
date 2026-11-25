import { describe, expect, it } from 'vitest';
import { DmsApiError, DmsAuthError, createDmsClient } from '@/embed/dmsClient';
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import type { DmsRecordValues } from './contract';
import { DmsRecordRepository } from './DmsRecordRepository';

const API = fixtures.descriptor.add.apiBase;
const MASTER = fixtures.descriptor.add.masterId;
const RECORD = fixtures.descriptor.edit.recordId;

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

/** An in-process fetch double answering from the fixture; records every call. */
function dms(over: { master?: unknown; patch?: Response; post?: Response; token?: string | null; masterStatus?: number } = {}) {
  const calls: Call[] = [];
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchDouble = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    const path = url.slice(API.length);
    if (method === 'GET' && path === fixtures.loadMaster.request.path) return answer(over.masterStatus ?? 200, over.master ?? fixtures.loadMaster.response.body);
    if (method === 'GET' && path === fixtures.loadRecord.request.path) return answer(200, fixtures.loadRecord.response.body);
    if (method === 'POST' && path === fixtures.create.request.path) return over.post ?? answer(201, fixtures.create.response.body);
    if (method === 'PATCH' && path === fixtures.update.request.path) return over.patch ?? answer(200, fixtures.update.response.body);
    return answer(404, { message: `unexpected ${method} ${path}` });
  }) as typeof fetch;
  const client = createDmsClient({ apiBase: API, tenantId: 'tenant-1', workspaceId: 'ws-1', fetch: fetchDouble, token: () => (over.token === undefined ? 'tok' : over.token) });
  return { calls, repo: new DmsRecordRepository({ apiBase: API, tenantId: 'tenant-1', workspaceId: 'ws-1' }, client) };
}

const addValues: DmsRecordValues = { 'Vendor Name': 'Acme', Tier: 'Gold', Joined: '01-11-2026', Phone: '9876543210', Docs: 'must never be sent' };

describe('DmsRecordRepository.load', () => {
  it('add: reads the master only', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER);
    expect(calls.map((c) => `${c.method} ${c.url.slice(API.length)}`)).toEqual([`GET ${fixtures.loadMaster.request.path}`]);
    expect(loaded).toMatchObject({ masterId: MASTER, masterName: 'Vendor', source: 'formplus', recordId: null, values: {} });
    expect(loaded.elements).toHaveLength(5);
  });

  it('edit: reads the master then the record; values match expectedValuesById', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER, RECORD);
    expect(calls.map((c) => `${c.method} ${c.url.slice(API.length)}`)).toEqual([`GET ${fixtures.loadMaster.request.path}`, `GET ${fixtures.loadRecord.request.path}`]);
    for (const el of loaded.elements) expect(loaded.values[el.value as string]).toBe((fixtures.loadRecord.expectedValuesById as Record<string, string>)[el.id]);
  });

  it('a master that is not Forms+ has no elements and its record is never read', async () => {
    const body = structuredClone(fixtures.loadMaster.response.body);
    body.data.source = 'dms';
    const { repo, calls } = dms({ master: body });
    const loaded = await repo.load(MASTER, RECORD);
    expect(loaded).toMatchObject({ source: 'dms', elements: [], values: {} });
    expect(calls).toHaveLength(1);
  });

  it('401 and no token are auth errors', async () => {
    await expect(dms({ masterStatus: 401, master: {} }).repo.load(MASTER)).rejects.toBeInstanceOf(DmsAuthError);
    const none = dms({ token: null });
    await expect(none.repo.load(MASTER)).rejects.toBeInstanceOf(DmsAuthError);
    expect(none.calls).toHaveLength(0);
  });
});

describe('DmsRecordRepository.save', () => {
  it('add posts exactly the fixture create body, with the bearer and tenant headers', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER);
    const out = await repo.save(loaded, addValues);
    expect(out).toEqual({ recordId: fixtures.create.response.body.data.id });
    const post = calls[1]!;
    expect(post).toMatchObject({ method: 'POST', url: `${API}${fixtures.create.request.path}` });
    expect(post.body).toEqual(fixtures.create.request.body);
    expect(post.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Tenant-Id': 'tenant-1', 'X-Workspace-Id': 'ws-1' });
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
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: `${API}${fixtures.update.request.path}` });
    expect(calls[2]!.body).toEqual(fixtures.update.request.body);
  });

  it('an unchanged edit sends nothing and still answers with the record id', async () => {
    const { repo, calls } = dms();
    const loaded = await repo.load(MASTER, RECORD);
    expect(await repo.save(loaded, { ...loaded.values })).toEqual({ recordId: RECORD });
    expect(calls).toHaveLength(2);
  });

  it('422 surfaces as a DmsApiError carrying errors.json_data; nothing is retried', async () => {
    const { repo, calls } = dms({ patch: new Response(JSON.stringify(fixtures.validationError.response.body), { status: 422 }) });
    const loaded = await repo.load(MASTER, RECORD);
    const err = await repo.save(loaded, { ...loaded.values, Tier: 'Bronze' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DmsApiError);
    expect((err as DmsApiError).status).toBe(422);
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
    await expect(repo.save({ ...loaded, source: 'dms' }, addValues)).rejects.toThrow(/not been converted/);
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
