import { describe, expect, it, vi } from 'vitest';
import { definitionToElements, elementsToDefinition, type DmsElement } from '@form/registry/profiles/dms-v1';
import type { BlockId, FieldBlock } from '@form/schema';
import fixtures from './__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import { DmsApiError, DmsAuthError, createDmsClient, type DmsClient } from '@/embed/dmsClient';
import type { ResolvedLaunch } from '@/embed/launch';
import { DmsCommitRefused, DmsMasterRepository, NotAFormPlusMaster, warningKeyOf } from '@/embed/master/DmsMasterRepository';
import { blankDefinition, inlineDoc } from '@/lib/definition';

const MASTER = 'b9000000-0000-4000-8000-000000000001';
const launch = (over: Partial<ResolvedLaunch> = {}): ResolvedLaunch => ({
  v: 1,
  mode: 'dms-master',
  profile: 'dms-v1',
  tenantId: 'acme',
  workspaceId: 'ws_1',
  master: { name: 'Vendor', doctypeIds: [], folderIds: [] },
  returnUrl: 'https://dms.example.test/back',
  apiBase: 'https://dms.example.test/api',
  ...over,
});

const create = fixtures.create.request.form_builder_fields as DmsElement[];
const update = fixtures.update.request.form_builder_fields as DmsElement[];

const show = (over: Record<string, unknown> = {}) => ({
  success: true,
  message: 'ok',
  data: { id: MASTER, name: 'Vendor', primary_key: 'Vendor Name', source: 'formplus', workspace_id: 'ws_1', updated_at: '2026-11-24T10:00:00.000000Z', doctype_ids: [], folder_ids: [], form_builder_fields: create, form_builder_slug: 'vendor', ...over },
});

/** An in-process double of `fetch`: DEC-01 allows doubles of fORM- ports, and this is the HTTP port to DMS, so its answers are the fixture's. */
function fakeDms(handler: (method: string, path: string, body: unknown) => Response | Promise<Response>) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://dms.example.test/api', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: String(init.method), path, body, headers: init.headers as Record<string, string> });
    return handler(String(init.method), path, body);
  });
  const client: DmsClient = createDmsClient({ apiBase: 'https://dms.example.test/api', tenantId: 'acme', workspaceId: 'ws_1', fetch: fetch as unknown as typeof globalThis.fetch, token: () => 'user-token' });
  return { calls, client };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** The document the builder would hold for a set of DMS elements. */
const docFor = (elements: DmsElement[], title = 'Vendor') => elementsToDefinition(elements, { formId: 'new', title, locale: 'en-IN', base: blankDefinition('new') });

describe('DmsMasterRepository: opening', () => {
  it('opens a new master from the descriptor: empty form titled with the chosen name, no request', async () => {
    const dms = fakeDms(() => json(500, {}));
    const repo = new DmsMasterRepository(launch(), dms.client);
    expect(repo.formId).toBe('new');
    const stored = await repo.load('new');
    expect(stored).toMatchObject({ id: 'new', format: 'v2' });
    expect((stored!.doc as { title: string; blocks: object }).title).toBe('Vendor');
    expect(Object.keys((stored!.doc as { blocks: object }).blocks)).toEqual([]);
    expect(dms.calls).toEqual([]);
  });

  it('loads an existing master with the user token: GET, tenant and workspace headers, fields as blocks in order', async () => {
    const dms = fakeDms(() => json(200, show()));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER, master: undefined }), dms.client);
    const stored = await repo.load(MASTER);
    expect(dms.calls).toHaveLength(1);
    expect(dms.calls[0]).toMatchObject({ method: 'GET', path: `/dms/v1/master/form/${MASTER}`, headers: { Authorization: 'Bearer user-token', 'X-Tenant-Id': 'acme', 'X-Workspace-Id': 'ws_1' } });
    const doc = stored!.doc as ReturnType<typeof docFor>;
    expect(doc.title).toBe('Vendor');
    expect(doc.pages[0]!.children).toEqual(create.map((e) => e.id));
    expect(definitionToElements(doc)).toEqual(create);
    expect(repo.current).toMatchObject({ id: MASTER, updatedAt: '2026-11-24T10:00:00.000000Z' });
  });

  it('accepts form_builder_fields as a JSON string and as null', async () => {
    const asString = fakeDms(() => json(200, show({ form_builder_fields: JSON.stringify(create) })));
    const doc = (await new DmsMasterRepository(launch({ masterId: MASTER }), asString.client).load(MASTER))!.doc as ReturnType<typeof docFor>;
    expect(doc.pages[0]!.children).toHaveLength(7);
    const empty = fakeDms(() => json(200, show({ form_builder_fields: null })));
    const doc2 = (await new DmsMasterRepository(launch({ masterId: MASTER }), empty.client).load(MASTER))!.doc as ReturnType<typeof docFor>;
    expect(doc2.pages[0]!.children).toEqual([]);
  });

  it('refuses a master that Forms+ did not make (OpenForm or classic): saving would drop fields it cannot read', async () => {
    const dms = fakeDms(() => json(200, show({ source: 'dms' })));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await expect(repo.load(MASTER)).rejects.toBeInstanceOf(NotAFormPlusMaster);
    expect(repo.lastLoadError).toBeInstanceOf(NotAFormPlusMaster);
  });

  it('keeps the error of a failed load for the page, and an answer it cannot read is an error too', async () => {
    const down = fakeDms(() => json(401, { message: 'Unauthenticated.' }));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), down.client);
    await expect(repo.load(MASTER)).rejects.toBeInstanceOf(DmsAuthError);
    expect(repo.lastLoadError).toBeInstanceOf(DmsAuthError);
    const junk = fakeDms(() => json(200, { nothing: true }));
    await expect(new DmsMasterRepository(launch({ masterId: MASTER }), junk.client).load(MASTER)).rejects.toThrow(/cannot read/);
    const notAList = fakeDms(() => json(200, show({ form_builder_fields: '{"a":1}' })));
    await expect(new DmsMasterRepository(launch({ masterId: MASTER }), notAList.client).load(MASTER)).rejects.toThrow(/cannot read/);
    const badJson = fakeDms(() => json(200, show({ form_builder_fields: 'not json' })));
    await expect(new DmsMasterRepository(launch({ masterId: MASTER }), badJson.client).load(MASTER)).rejects.toThrow(/cannot read/);
  });

  it('autosave stays local: save() keeps the form in memory, makes no request, and load() returns it', async () => {
    const dms = fakeDms(() => json(200, show()));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    const first = (await repo.load(MASTER))!;
    dms.calls.length = 0;
    await repo.save({ ...first, rev: 3 });
    expect(await repo.load(MASTER)).toMatchObject({ rev: 3 });
    expect(await repo.list()).toEqual([]);
    expect(dms.calls).toEqual([]);
    await repo.remove(MASTER);
    expect(dms.calls).toEqual([]);
  });
});

describe('DmsMasterRepository: Save to DMS', () => {
  it('POSTs exactly the fixture create request for a new master (name, source, classification, ids, fields in canvas order)', async () => {
    const dms = fakeDms(() => json(201, show()));
    const repo = new DmsMasterRepository(launch(), dms.client);
    const result = await repo.commit(docFor(create));
    expect(dms.calls).toHaveLength(1);
    expect(dms.calls[0]).toMatchObject({ method: 'POST', path: '/dms/v1/master/form', headers: { Authorization: 'Bearer user-token' } });
    expect(dms.calls[0]!.body).toEqual(fixtures.create.request);
    expect(result).toMatchObject({ masterId: MASTER, updatedAt: '2026-11-24T10:00:00.000000Z', warnings: [] });
  });

  it('carries the doctype and folder ids the descriptor chose', async () => {
    const dms = fakeDms(() => json(201, show()));
    const ids = { doctypeIds: ['d1000000-0000-4000-8000-000000000001'], folderIds: ['f1000000-0000-4000-8000-000000000001'], name: 'Vendor' };
    await new DmsMasterRepository(launch({ master: ids }), dms.client).commit(docFor(create));
    expect(dms.calls[0]!.body).toMatchObject({ doctype_ids: ids.doctypeIds, folder_ids: ids.folderIds, classification: null });
  });

  it('after a create, the next save is a PATCH of the same master with the updated_at the server gave', async () => {
    const dms = fakeDms((method) => json(method === 'POST' ? 201 : 200, show({ updated_at: method === 'POST' ? 'T1' : 'T2' })));
    const repo = new DmsMasterRepository(launch(), dms.client);
    await repo.commit(docFor(create));
    await repo.commit(docFor(create));
    expect(dms.calls[1]).toMatchObject({ method: 'PATCH', path: `/dms/v1/master/form/${MASTER}`, body: { name: 'Vendor', source: 'formplus', updated_at: 'T1' } });
    expect(repo.current?.updatedAt).toBe('T2');
  });

  it('PATCHes the fixture update request for an existing master: loaded updated_at, no doctype or folder ids', async () => {
    const dms = fakeDms((method) => json(200, show(method === 'GET' ? {} : { updated_at: 'T9' })));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await repo.load(MASTER);
    await repo.commit(docFor(update));
    const sent = dms.calls[1]!;
    expect(sent).toMatchObject({ method: 'PATCH', path: `/dms/v1/master/form/${MASTER}` });
    expect(sent.body).toEqual({ ...fixtures.update.request, updated_at: '2026-11-24T10:00:00.000000Z' });
    expect(repo.current?.updatedAt).toBe('T9');
  });

  it('omits updated_at when the server never sent one (a dms-api without G10)', async () => {
    const dms = fakeDms((method) => json(200, show({ updated_at: null, ...(method === 'GET' ? {} : {}) })));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await repo.load(MASTER);
    await repo.commit(docFor(create));
    expect(dms.calls[1]!.body).not.toHaveProperty('updated_at');
  });

  it('refuses before any request when the guard finds an error, and when the name is empty or too long', async () => {
    const dms = fakeDms(() => json(201, show()));
    const repo = new DmsMasterRepository(launch(), dms.client);
    const bad = await repo.commit(docFor([...create, { ...create[0]!, id: 'b1000000-0000-4000-8000-0000000000aa' }])).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(DmsCommitRefused);
    expect((bad as DmsCommitRefused).issues.map((i) => i.code)).toContain('label_duplicate');
    const unnamed = await repo.commit(docFor(create, '  ')).catch((e: unknown) => e);
    expect((unnamed as DmsCommitRefused).issues[0]!.code).toBe('master_name_empty');
    const long = await repo.commit(docFor(create, 'x'.repeat(256))).catch((e: unknown) => e);
    expect((long as DmsCommitRefused).issues[0]!.code).toBe('master_name_too_long');
    const blocks = docFor(create);
    const withSignature = { ...blocks, blocks: { ...blocks.blocks, sig: { id: 'sig' as BlockId, type: 'signature', key: 'sig', label: inlineDoc('Sign'), required: false, compliance: {}, config: {} } as never } };
    const sig = await repo.commit(withSignature).catch((e: unknown) => e);
    expect((sig as DmsCommitRefused).issues.map((i) => i.code)).toContain('unsupported_block_type');
    expect(dms.calls).toEqual([]);
  });

  it('asks once about settings DMS cannot keep, and sends only after those exact warnings are accepted', async () => {
    const dms = fakeDms(() => json(201, show()));
    const repo = new DmsMasterRepository(launch(), dms.client);
    const doc = docFor(create);
    const first = doc.pages[0]!.children[2]!;
    const withWarning = { ...doc, blocks: { ...doc.blocks, [first]: { ...(doc.blocks[first] as FieldBlock), config: { confirm: true } } as never } };
    const refused = (await repo.commit(withWarning).catch((e: unknown) => e)) as DmsCommitRefused;
    expect(refused).toBeInstanceOf(DmsCommitRefused);
    expect(refused.needsConfirmation).toBe(true);
    expect(dms.calls).toEqual([]);
    const stale = await repo.commit(withWarning, { confirmedWarnings: 'something else' }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(DmsCommitRefused);
    const done = await repo.commit(withWarning, { confirmedWarnings: refused.warningKey });
    expect(done.warnings).toHaveLength(1);
    expect(dms.calls).toHaveLength(1);
    expect(refused.warningKey).toBe(warningKeyOf(refused.issues));
  });

  it('passes dms-api refusals on with their status and code, and never sends a second request for one click', async () => {
    const dms = fakeDms(() => json(409, { success: false, message: 'Changed.', code: 'MASTER_CHANGED' }));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    const [a, b] = await Promise.allSettled([repo.commit(docFor(create)), repo.commit(docFor(create))]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(dms.calls).toHaveLength(1);
    expect((a as PromiseRejectedResult).reason).toBeInstanceOf(DmsApiError);
    expect((a as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'MASTER_CHANGED' });
    // The failure leaves the repository usable.
    await expect(repo.commit(docFor(create))).rejects.toBeInstanceOf(DmsApiError);
    expect(dms.calls).toHaveLength(2);
  });

  it('makes no request without a token', async () => {
    const fetch = vi.fn();
    const client = createDmsClient({ apiBase: 'https://dms.example.test/api', tenantId: 'acme', workspaceId: 'ws_1', fetch: fetch as unknown as typeof globalThis.fetch, token: () => null });
    await expect(new DmsMasterRepository(launch(), client).commit(docFor(create))).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('copes with a save answer that has no body (the id is the one it already knew)', async () => {
    const dms = fakeDms(() => json(200, { success: true }));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await expect(repo.commit(docFor(create))).resolves.toMatchObject({ masterId: MASTER });
    const createNoBody = new DmsMasterRepository(launch(), fakeDms(() => json(201, { success: true })).client);
    await expect(createNoBody.commit(docFor(create))).rejects.toThrow(/did not say which one/);
  });
});
