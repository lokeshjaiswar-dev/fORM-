import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { definitionToElements, elementsToDefinition, xWithVisibility, type DmsElement } from '@form/registry/profiles/dms-v1';
import type { BlockId, FieldBlock, FormDefinition } from '@form/schema';
import fixtures from './__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import usageFixtures from '@/embed/contract/__fixtures__/field-usage.fixtures.json' with { type: 'json' };
import { DmsApiError, DmsAuthError, createDmsClient, type DmsClient } from '@/embed/dmsClient';
import type { ResolvedLaunch } from '@/embed/launch';
import {
  DmsCommitRefused, DmsMasterRepository, NotAFormPlusMaster, RemovalCancelled, RemovalRequired, warningKeyOf, type AskRemoval, type RemovalConsent, type RemovalNeed,
} from '@/embed/master/DmsMasterRepository';
import { waitFor } from '@testing-library/react';
import { dismissReconnect, sessionSnapshot } from '@/embed/session/dmsSession';
import { installTestSession, resetTestSession, TEST_API_BASE, TEST_CREDENTIAL } from '@/embed/session/testing';
import { blankDefinition, inlineDoc } from '@/lib/definition';

const MASTER = 'b9000000-0000-4000-8000-000000000001';
beforeEach(() => {
  installTestSession({ apiBase: TEST_API_BASE });
});
afterEach(() => resetTestSession());

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

/** The legacy path of a session URL (`/dms/v1/formplus/s/master/form/x` is `/dms/v1/master/form/x`): the fixtures are written in the legacy names. */
const legacyOf = (path: string): string => {
  const rest = path.replace('/dms/v1/formplus/s/', '');
  return rest.startsWith('master/form') ? `/dms/v1/${rest}` : `/dms/${rest}`;
};

/**
 * An in-process double of `fetch`: DEC-01 allows doubles of fORM- ports, and this is the HTTP port to DMS, so its answers are the fixture's.
 * The session client maps every legacy path to the session group (DESIGN 3.3); `path` here is the legacy name again.
 */
function fakeDms(handler: (method: string, path: string, body: unknown) => Response | Promise<Response>) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string>; url: string }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = legacyOf(url.replace(TEST_API_BASE, ''));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: String(init.method), path, body, headers: init.headers as Record<string, string>, url });
    return handler(String(init.method), path, body);
  });
  const client: DmsClient = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 'acme', workspaceId: 'ws_1', fetch: fetch as unknown as typeof globalThis.fetch });
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

  it('loads an existing master with the session credential: GET on the session route, no tenant or workspace header, fields as blocks in order', async () => {
    const dms = fakeDms(() => json(200, show()));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER, master: undefined }), dms.client);
    const stored = await repo.load(MASTER);
    expect(dms.calls).toHaveLength(1);
    expect(dms.calls[0]).toMatchObject({ method: 'GET', path: `/dms/v1/master/form/${MASTER}`, url: `${TEST_API_BASE}/dms/v1/formplus/s/master/form/${MASTER}`, headers: { Authorization: `Bearer ${TEST_CREDENTIAL}` } });
    expect(Object.keys(dms.calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain('x-tenant-id');
    expect(Object.keys(dms.calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain('x-workspace-id');
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
    // A 401 parks the call for a reconnect (the page shows the prompt); closing the prompt makes it an auth error.
    const down = fakeDms(() => json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), down.client);
    const pending = repo.load(MASTER).catch((e: unknown) => e);
    await waitFor(() => expect(sessionSnapshot().phase).toBe('invalid'));
    dismissReconnect();
    expect(await pending).toBeInstanceOf(DmsAuthError);
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
    expect(dms.calls[0]).toMatchObject({ method: 'POST', path: '/dms/v1/master/form', headers: { Authorization: `Bearer ${TEST_CREDENTIAL}` } });
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
    const dms = fakeDms((method) => (method === 'GET' ? json(200, show()) : json(409, { success: false, message: 'Changed.', code: 'MASTER_CHANGED' })));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await repo.load(MASTER);
    dms.calls.length = 0;
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

  it('makes no request when there is no session (never launched, or it ended)', async () => {
    resetTestSession();
    const fetch = vi.fn();
    const client = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 'acme', workspaceId: 'ws_1', fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(new DmsMasterRepository(launch(), client).commit(docFor(create))).rejects.toBeInstanceOf(DmsAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('copes with a save answer that has no body (the id is the one it already knew)', async () => {
    const dms = fakeDms((method) => (method === 'GET' ? json(200, show()) : json(200, { success: true })));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await repo.load(MASTER);
    await expect(repo.commit(docFor(create))).resolves.toMatchObject({ masterId: MASTER });
    const createNoBody = new DmsMasterRepository(launch(), fakeDms(() => json(201, { success: true })).client);
    await expect(createNoBody.commit(docFor(create))).rejects.toThrow(/did not say which one/);
  });
});

/* ── run dmsplus-int: classification seed, hidden/secret, removal consent (SD-09, SD-11; SEC-DESIGN 5.2, 7.3) ──────────────────────────── */

type V2Case = { name: string; as?: string; request: { method: string; path: string; body?: Record<string, unknown> }; response: { status: number; body: Record<string, unknown> } };
const v2 = (name: string): V2Case => {
  const found = (fixtures.v2Cases.cases as unknown as V2Case[]).find((c) => c.name === name);
  if (!found) throw new Error(`fixture case ${name} is missing`);
  return found;
};
const dataOf = (c: V2Case) => c.response.body.data as { form_builder_fields: DmsElement[]; updated_at: string; hidden_field_count: number; can: { reveal_fields: boolean } };
const idsOf = (elements: ReadonlyArray<{ id: unknown }>) => elements.map((e) => String(e.id));
const REV_MASTER = 'a1000000-0000-4000-8000-0000000000b1';
const CODE = 'b1000000-0000-4000-8000-000000000002';
const NOTE = 'b1000000-0000-4000-8000-000000000009';
const usageOf = (counts: Record<string, number>, names: Record<string, string> = {}) => ({
  success: true,
  message: 'Field usage retrieved successfully',
  data: {
    updated_at: '2026-11-26T09:30:00.000000Z',
    total_records: 12,
    fields: Object.entries(counts).map(([id, records_with_value]) => ({ id, name: names[id] ?? 'Vendor Code', records_with_value })),
  },
});
const USAGE_PATH = `/dms/v1/master/form/${REV_MASTER}/field-usage`;

/** Drops the block of `id` from a document, as deleting it on the canvas does. */
function without(doc: FormDefinition, id: string): FormDefinition {
  const { [id as BlockId]: _gone, ...blocks } = doc.blocks;
  return { ...doc, blocks, pages: doc.pages.map((p) => ({ ...p, children: p.children.filter((c) => c !== id) })) };
}

/** Every PATCH names every stored field it does not keep (the lane's invariant: no request omits a DMS field without a matching remove[] entry). */
function expectNoSilentOmission(calls: Array<{ method: string; body: unknown }>, stored: readonly string[]): void {
  for (const c of calls.filter((x) => x.method === 'PATCH')) {
    const body = c.body as { form_builder_fields?: Array<{ id: string }>; remove?: Array<{ field_id: string }> };
    const named = new Set([...(body.form_builder_fields ?? []).map((f) => f.id), ...(body.remove ?? []).map((r) => r.field_id)]);
    for (const id of stored) expect(named.has(id), `stored field ${id} is neither kept nor removed`).toBe(true);
  }
}

describe('DmsMasterRepository: create seed classification (DESIGN 5.2, SD-09)', () => {
  it.each(['public', 'confidential', 'restricted'] as const)('POSTs classification %s from the launch master seed', async (classification) => {
    const dms = fakeDms(() => json(201, show()));
    await new DmsMasterRepository(launch({ master: { name: 'Vendor', doctypeIds: ['d1000000-0000-4000-8000-000000000001'], folderIds: ['f1000000-0000-4000-8000-000000000001'], classification } }), dms.client).commit(docFor(create));
    expect(dms.calls[0]!.body).toMatchObject({ classification, doctype_ids: ['d1000000-0000-4000-8000-000000000001'], folder_ids: ['f1000000-0000-4000-8000-000000000001'] });
  });

  it('a seed with no classification (null, or none given) POSTs null, never a made-up value', async () => {
    for (const master of [{ name: 'Vendor', doctypeIds: [], folderIds: [], classification: null }, { name: 'Vendor', doctypeIds: [], folderIds: [] }]) {
      const dms = fakeDms(() => json(201, show()));
      await new DmsMasterRepository(launch({ master }), dms.client).commit(docFor(create));
      expect((dms.calls[0]!.body as { classification: unknown }).classification).toBeNull();
    }
  });

  it('an edit PATCH carries no classification, doctype or folder keys (G1 is solved on the DMS side, BD-01)', async () => {
    const dms = fakeDms((method) => json(200, show(method === 'GET' ? {} : { updated_at: 'T2' })));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER, master: { name: 'Vendor', doctypeIds: ['x'], folderIds: ['y'], classification: 'restricted' } }), dms.client);
    await repo.load(MASTER);
    await repo.commit(docFor(create));
    const body = dms.calls[1]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['form_builder_fields', 'name', 'source', 'updated_at']);
  });
});

describe('DmsMasterRepository: hidden and secret fields (SEC-DESIGN 5.2, 5.3; fixture v2Cases)', () => {
  it('a revealer loads every field with its flags, the flags round-trip into the elements, and can.reveal_fields is read', async () => {
    const c = v2('show-as-revealer');
    const dms = fakeDms(() => json(200, c.response.body));
    const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
    const doc = (await repo.load(REV_MASTER))!.doc as FormDefinition;
    expect(definitionToElements(doc)).toEqual(dataOf(c).form_builder_fields.map((e) => expect.objectContaining(e)));
    expect(repo.current).toMatchObject({ canReveal: true, hiddenFieldCount: 0 });
    expect([...repo.current!.fields.keys()]).toEqual(idsOf(dataOf(c).form_builder_fields));
  });

  it('a non-revealer sees the hidden count; saving what it was given echoes the same flags and names no remove[] (the hidden field is kept by DMS)', async () => {
    const shown = v2('show-as-non-revealer');
    const echo = v2('patch-non-revealer-echoes-what-it-got');
    const dms = fakeDms((method) => json(200, method === 'GET' ? shown.response.body : echo.response.body));
    const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
    const doc = (await repo.load(REV_MASTER))!.doc as FormDefinition;
    expect(repo.current).toMatchObject({ canReveal: false, hiddenFieldCount: 1 });
    expect(repo.current!.fields.has(NOTE)).toBe(false);
    await repo.commit(doc);
    const patch = dms.calls.find((x) => x.method === 'PATCH')!;
    // The profile writes its dialect keys (numeric/specialChars of a text input) next to what the fixture lists: the fixture is kept, key for key.
    expect((patch.body as { form_builder_fields: unknown[] }).form_builder_fields).toEqual((echo.request.body!.form_builder_fields as unknown[]).map((e) => expect.objectContaining(e as object)));
    expect(patch.body).not.toHaveProperty('remove');
    expectNoSilentOmission(dms.calls, [...repo.current!.fields.keys()]);
  });

  it('an inspector toggle (secret on) writes exactly the fixture PATCH fields and keeps every other key', async () => {
    const shown = v2('show-as-revealer');
    const setFlag = v2('patch-sets-secret-flag-roundtrip');
    const dms = fakeDms((method) => json(200, method === 'GET' ? shown.response.body : setFlag.response.body));
    const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
    const doc = (await repo.load(REV_MASTER))!.doc as FormDefinition;
    const block = doc.blocks[CODE as BlockId] as FieldBlock;
    const toggled = { ...doc, blocks: { ...doc.blocks, [CODE]: { ...block, x: xWithVisibility(block, { secret: true }) } } } as FormDefinition;
    await repo.commit(toggled);
    const patch = dms.calls.find((x) => x.method === 'PATCH')!.body as { form_builder_fields: DmsElement[]; name: string; updated_at: string; remove?: unknown };
    expect(patch.form_builder_fields).toEqual((setFlag.request.body!.form_builder_fields as unknown[]).map((e) => expect.objectContaining(e as object)));
    expect(patch).toMatchObject({ name: 'Vendor Register', updated_at: '2026-11-26T09:30:00.000000Z' });
    expect(patch.remove).toBeUndefined();
  });

  it('a hidden or secret primary field is refused by the guard before any request (server twin PRIMARY_CANNOT_BE_HIDDEN)', async () => {
    const shown = v2('show-as-revealer');
    const dms = fakeDms(() => json(200, shown.response.body));
    const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
    const doc = (await repo.load(REV_MASTER))!.doc as FormDefinition;
    const primaryId = dataOf(shown).form_builder_fields.find((e) => e.primary === true)!.id;
    const block = doc.blocks[primaryId as BlockId] as FieldBlock;
    const bad = { ...doc, blocks: { ...doc.blocks, [primaryId]: { ...block, x: xWithVisibility(block, { hidden: true }) } } } as FormDefinition;
    dms.calls.length = 0;
    const refused = (await repo.commit(bad).catch((e: unknown) => e)) as DmsCommitRefused;
    expect(refused).toBeInstanceOf(DmsCommitRefused);
    expect(refused.issues.map((i) => i.code)).toContain('primary_cannot_be_hidden');
    expect(dms.calls).toEqual([]);
  });

  it('dms-api answers for the flag rules reach the page with their code (FIELD_VISIBILITY_FORBIDDEN, PRIMARY_CANNOT_BE_HIDDEN)', async () => {
    for (const name of ['patch-visibility-change-by-non-revealer', 'patch-primary-field-hidden']) {
      const c = v2(name);
      const dms = fakeDms((method) => (method === 'GET' ? json(200, v2('show-as-revealer').response.body) : json(c.response.status, c.response.body)));
      const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
      const doc = (await repo.load(REV_MASTER))!.doc as FormDefinition;
      await expect(repo.commit(doc)).rejects.toMatchObject({ status: c.response.status, code: c.response.body.code });
    }
  });
});

describe('DmsMasterRepository: removal consent (SEC-DESIGN 7.3, T-DMSINT-56)', () => {
  /** A revealer's master with Vendor Code deleted on the canvas, and a DMS that counts 3 records in it. */
  async function openAndDelete(extra: (method: string, path: string, body: unknown) => Response | undefined = () => undefined) {
    const shown = v2('show-as-revealer');
    const ok = v2('patch-remove-confirmed');
    const dms = fakeDms((method, path, body) => {
      const custom = extra(method, path, body);
      if (custom) return custom;
      if (method === 'GET' && path === USAGE_PATH) return json(200, usageOf({ [CODE]: 3 }));
      return json(200, method === 'GET' ? shown.response.body : ok.response.body);
    });
    const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
    const doc = without((await repo.load(REV_MASTER))!.doc as FormDefinition, CODE);
    return { dms, repo, doc, stored: [...repo.current!.fields.keys()] };
  }
  const typing = (name: string): AskRemoval => vi.fn(async (need: RemovalNeed) => (need.name === name ? name : null));

  it('asks the counts, then once per removed field, and PATCHes remove[] with the typed name and the count it was shown, every kept field listed', async () => {
    const { dms, repo, doc, stored } = await openAndDelete();
    const ask = typing('Vendor Code');
    await repo.commit(doc, { askRemoval: ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({ fieldId: CODE, name: 'Vendor Code', count: 3, recount: false });
    expect(dms.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /dms/v1/master/form/${REV_MASTER}`, `GET ${USAGE_PATH}`, `PATCH /dms/v1/master/form/${REV_MASTER}`]);
    expect(dms.calls[1]!.url).toBe(`${TEST_API_BASE}/dms/v1/formplus/s/master/form/${REV_MASTER}/field-usage`);
    const ok = v2('patch-remove-confirmed');
    const body = dms.calls[2]!.body as { form_builder_fields: Array<{ id: string }>; remove: unknown };
    expect(body.remove).toEqual(ok.request.body!.remove);
    expect(idsOf(body.form_builder_fields)).toEqual(idsOf(ok.request.body!.form_builder_fields as Array<{ id: string }>));
    expectNoSilentOmission(dms.calls, stored);
    expect(repo.current!.fields.has(CODE)).toBe(false);
  });

  it('a field no record holds a value in still needs the typed name (count 0)', async () => {
    const { repo, doc } = await openAndDelete((method, path) => (method === 'GET' && path === USAGE_PATH ? json(200, usageOf({ [CODE]: 0 })) : undefined));
    const ask = typing('Vendor Code');
    await repo.commit(doc, { askRemoval: ask });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ count: 0 }));
  });

  it('cancel sends nothing: RemovalCancelled carries the field so the page can put the block back', async () => {
    const { dms, repo, doc } = await openAndDelete();
    const ask: AskRemoval = vi.fn(async () => null);
    const err = await repo.commit(doc, { askRemoval: ask }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemovalCancelled);
    expect((err as RemovalCancelled).fieldId).toBe(CODE);
    expect(dms.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(repo.current!.fields.has(CODE)).toBe(true);
  });

  it('a name that is not the field name exactly (case, spaces) sends nothing, whoever asked', async () => {
    for (const typed of ['vendor code', 'Vendor Code ', 'Vendor']) {
      const { dms, repo, doc } = await openAndDelete();
      await expect(repo.commit(doc, { askRemoval: async () => typed })).rejects.toThrow(/does not match/);
      expect(dms.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    }
  });

  it('with nobody to ask, a document that omits a stored field is refused before any request (never omission removal)', async () => {
    const { dms, repo, doc } = await openAndDelete();
    dms.calls.length = 0;
    const err = await repo.commit(doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemovalRequired);
    expect((err as RemovalRequired).fieldIds).toEqual([CODE]);
    expect(dms.calls).toEqual([]);
  });

  it('409 REMOVAL_COUNT_CHANGED asks again with the new count and repeats the save with that count', async () => {
    const grew = v2('patch-remove-count-grew');
    let patches = 0;
    const { dms, repo, doc } = await openAndDelete((method) => {
      if (method !== 'PATCH') return undefined;
      patches += 1;
      return patches === 1 ? json(grew.response.status, { ...grew.response.body, details: { field_id: CODE, actual: 5 }, request_id: null }) : undefined;
    });
    const ask = vi.fn(async (need: RemovalNeed) => need.name);
    await repo.commit(doc, { askRemoval: ask });
    expect(ask.mock.calls.map(([n]) => [n.count, n.recount])).toEqual([[3, false], [5, true]]);
    const sent = dms.calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { remove: Array<{ confirmed_count: number }> }).remove[0]!.confirmed_count);
    expect(sent).toEqual([3, 5]);
  });

  it('409 REMOVAL_COUNT_CHANGED naming the field in another case still re-asks that field (ids compare without case)', async () => {
    let patches = 0;
    const { dms, repo, doc } = await openAndDelete((method) => {
      if (method !== 'PATCH') return undefined;
      patches += 1;
      return patches === 1 ? json(409, { success: false, code: 'REMOVAL_COUNT_CHANGED', message: 'x', details: { field_id: CODE.toUpperCase(), actual: 7 }, request_id: null }) : undefined;
    });
    const ask = vi.fn(async (need: RemovalNeed) => need.name);
    await repo.commit(doc, { askRemoval: ask });
    expect(ask.mock.calls.map(([n]) => [n.fieldId, n.count, n.recount])).toEqual([[CODE, 3, false], [CODE, 7, true]]);
    const sent = dms.calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { remove: RemovalConsent[] }).remove);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([{ field_id: CODE, confirmed_name: sent[0]![0]!.confirmed_name, confirmed_count: 7 }]);
  });

  it('a 409 that cannot be resolved (no field named, nothing grew) is passed on, not looped on', async () => {
    const { dms, repo, doc } = await openAndDelete((method) => (method === 'PATCH' ? json(409, { success: false, code: 'REMOVAL_COUNT_CHANGED', message: 'x', request_id: null }) : undefined));
    const err = await repo.commit(doc, { askRemoval: async (n) => n.name }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DmsApiError);
    expect(dms.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('dms-api refusals of a removal reach the page with their code: REMOVAL_NOT_CONFIRMED, UNKNOWN_FIELD, FIELD_OMITTED, REMOVAL_INCOMPLETE', async () => {
    const answers: Array<[string, number]> = [['REMOVAL_NOT_CONFIRMED', 422], ['UNKNOWN_FIELD', 422], ['FIELD_OMITTED', 422], ['REMOVAL_INCOMPLETE', 500]];
    for (const [code, status] of answers) {
      const { repo, doc } = await openAndDelete((method) => (method === 'PATCH' ? json(status, { success: false, code, message: 'x', request_id: null }) : undefined));
      await expect(repo.commit(doc, { askRemoval: async (n) => n.name })).rejects.toMatchObject({ status, code });
    }
  });

  it('a field added in this session and deleted before the save is not stored in DMS: no question, no remove[]', async () => {
    const shown = v2('show-as-revealer');
    const dms = fakeDms(() => json(200, shown.response.body));
    const repo = new DmsMasterRepository(launch({ masterId: REV_MASTER }), dms.client);
    const doc = (await repo.load(REV_MASTER))!.doc as FormDefinition;
    const extra = elementsToDefinition([{ id: 'b1000000-0000-4000-8000-0000000000ff', type: 'email', name: 'Spare', value: 'Spare', label: 'Spare', required: false, placeholder: '' }], { formId: 'x', title: 't', locale: 'en-IN' });
    const added = { ...doc, blocks: { ...doc.blocks, ...extra.blocks }, pages: [{ ...doc.pages[0]!, children: [...doc.pages[0]!.children, ...extra.pages[0]!.children] }] } as FormDefinition;
    const ask = vi.fn();
    await repo.commit(without(added, 'b1000000-0000-4000-8000-0000000000ff'), { askRemoval: ask });
    expect(ask).not.toHaveBeenCalled();
    expect(dms.calls.some((c) => c.path.endsWith('/field-usage'))).toBe(false);
    expect(dms.calls.find((c) => c.method === 'PATCH')!.body).not.toHaveProperty('remove');
  });

  it('a field-usage answer this builder cannot read stops the save before anything is sent (fail closed)', async () => {
    const { dms, repo, doc } = await openAndDelete((method, path) => (method === 'GET' && path === USAGE_PATH ? json(200, { success: true, data: { fields: 'many' } }) : undefined));
    await expect(repo.commit(doc, { askRemoval: async (n) => n.name })).rejects.toThrow(/cannot read/);
    expect(dms.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the usage the contract fixture shows parses as field-usage (revealer lists hidden fields, non-revealer does not)', async () => {
    const cases = usageFixtures.cases as Array<{ name: string; input: { body: unknown } }>;
    for (const name of ['revealer-sees-hidden-fields', 'non-revealer-hidden-fields-omitted']) {
      const dms = fakeDms(() => json(200, cases.find((c) => c.name === name)!.input.body));
      const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
      const usage = await repo.fieldUsage();
      expect(usage.fields.length).toBeGreaterThan(0);
      expect(usage.fields.every((f) => f.records_with_value >= 0)).toBe(true);
    }
  });

  it('an edit that was never loaded is not sent: the repository cannot tell what a PATCH would drop', async () => {
    const dms = fakeDms(() => json(200, show()));
    const repo = new DmsMasterRepository(launch({ masterId: MASTER }), dms.client);
    await expect(repo.commit(docFor(create))).rejects.toThrow(/was not loaded/);
    expect(dms.calls).toEqual([]);
  });

  it('SCHEMA_SYNC_FAILED saved:true after a removal makes the sent fields the stored ones (the removed field is gone)', async () => {
    const fail = { success: false, code: 'SCHEMA_SYNC_FAILED', message: 'x', data: { master_id: REV_MASTER, saved: true, updated_at: 'T9' } };
    const { repo, doc } = await openAndDelete((method) => (method === 'PATCH' ? json(500, fail) : undefined));
    await expect(repo.commit(doc, { askRemoval: async (n) => n.name })).rejects.toBeInstanceOf(DmsApiError);
    expect(repo.current).toMatchObject({ updatedAt: 'T9' });
    expect(repo.current!.fields.has(CODE)).toBe(false);
  });
});
