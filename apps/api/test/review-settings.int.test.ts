import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import type { FormDefinition } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-2.33 review settings: GET and PUT /v1/forms/:id/review. Revisions (If-Match), what a save may name (a unit of the
 * draft or the live version, a group of this org that is not archived), who may read and save, the audit record that
 * names keys and never values, and org isolation. The cross-org cases of both routes are also in the isolation suite.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
interface Unit {
  unitId: string;
  groupId: string;
  order: number;
  required: boolean;
  visibility: 'own_unit' | 'whole_submission';
}
interface View {
  rev: number;
  enabled: boolean;
  distinctCheckers: boolean;
  units: Unit[];
}

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let otherOrgId: string;
const user = {
  owner: randomUUID(),
  editor: randomUUID(),
  creator: randomUUID(),
  dataCollaborator: randomUUID(),
  viewer: randomUUID(),
  otherOwner: randomUUID(),
};
let groupA: string;
let groupB: string;
let archivedGroup: string;
let otherOrgGroup: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_review_settings');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'settings-a', otherOrgId, 'settings-b']);
  const members: Array<[string, string, string]> = [
    [user.owner, 'owner', orgId],
    [user.editor, 'editor', orgId],
    [user.creator, 'creator', orgId],
    [user.dataCollaborator, 'data_collaborator', orgId],
    [user.viewer, 'viewer', orgId],
    [user.otherOwner, 'owner', otherOrgId],
  ];
  for (const [id, role, org] of members) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${role}-${id.slice(0, 8)}@settings.test`]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
  }
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    AUTH_SECRET: Buffer.alloc(32, 9).toString('base64url'),
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false });
  groupA = await newGroup('Group A');
  groupB = await newGroup('Group B');
  archivedGroup = await newGroup('Archived group');
  expect((await call('PATCH', `/v1/org/review-groups/${archivedGroup}`, { body: { archived: true } })).statusCode).toBe(200);
  otherOrgGroup = await newGroup('Other org group', { as: user.otherOwner, org: otherOrgId });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

async function call(method: Method, url: string, o: { as?: string; org?: string; body?: unknown; ifMatch?: string } = {}) {
  return app.inject({
    method,
    url,
    headers: { 'x-fr-dev-user': o.as ?? user.owner, 'x-fr-org': o.org ?? orgId, ...BROWSER, ...(o.ifMatch === undefined ? {} : { 'if-match': o.ifMatch }) },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
  });
}

async function newGroup(name: string, o: { as?: string; org?: string } = {}): Promise<string> {
  const res = await call('POST', '/v1/org/review-groups', { ...o, body: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

/** The units a draft names: a page unit over the one page, `extra` more as section breaks are not needed for ids. */
function withUnits(def: FormDefinition, unitIds: string[]): FormDefinition {
  return {
    ...def,
    review: { units: unitIds.map((id) => ({ id, name: `Unit ${id}`, target: { kind: 'page', pageId: def.pages[0]!.id } })) },
  } as unknown as FormDefinition;
}

/** A form of org A with a saved draft that names `draftUnits`; when `liveUnits` is given the form is published with those units first. */
async function newForm(o: { draftUnits?: string[]; liveUnits?: string[]; org?: string; as?: string } = {}): Promise<string> {
  const ctx = { ...(o.as ? { as: o.as } : {}), ...(o.org ? { org: o.org } : {}) };
  const created = await call('POST', '/v1/forms', { ...ctx, body: { title: 'Reviewed form' } });
  expect(created.statusCode, created.body).toBe(200);
  const { id } = created.json<{ id: string }>();
  const base = draftWith(id, [fieldBlock('name', 'short_text')], 'Reviewed form');
  let rev = '0';
  if (o.liveUnits) {
    const saved = await call('PUT', `/v1/forms/${id}/draft`, { ...ctx, ifMatch: rev, body: { draft: withUnits(base, o.liveUnits) } });
    expect(saved.statusCode, saved.body).toBe(200);
    rev = String(saved.json<{ draftRev: number }>().draftRev);
    const live = await call('POST', `/v1/forms/${id}/publish`, { ...ctx, body: {} });
    expect(live.statusCode, live.body).toBe(200);
  }
  const draft = o.draftUnits ? withUnits(base, o.draftUnits) : base;
  const saved = await call('PUT', `/v1/forms/${id}/draft`, { ...ctx, ifMatch: rev, body: { draft } });
  expect(saved.statusCode, saved.body).toBe(200);
  return id;
}

const unit = (unitId: string, o: Partial<Unit> = {}): Unit => ({ unitId, groupId: groupA, order: 1, required: true, visibility: 'own_unit', ...o });
const settings = (units: Unit[], o: { enabled?: boolean; distinctCheckers?: boolean } = {}) => ({ enabled: o.enabled ?? true, distinctCheckers: o.distinctCheckers ?? false, units });
const put = (formId: string, body: unknown, ifMatch: string | undefined, o: { as?: string; org?: string } = {}) =>
  call('PUT', `/v1/forms/${formId}/review`, { ...o, body, ...(ifMatch === undefined ? {} : { ifMatch }) });

/** The audit events of an action in an org's pending log, oldest first (the chain worker does not run in these tests). */
async function auditEvents(orgKey: string, action: string, formId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = $2 and event->>'formId' = $3 order by id`, [
    orgKey,
    action,
    formId,
  ]);
  return rows.map((r) => r.event);
}

const rowOf = async (formId: string) =>
  (await owner.query<{ rev: number; enabled: boolean; settings: Record<string, unknown>; updated_by: string | null; org_id: string }>('select rev, enabled, settings, updated_by, org_id from form_review_settings where form_id = $1', [formId])).rows[0];

describe('GET review', () => {
  it('answers the defaults at revision 0 for a form nobody set up, to every member who can read forms', async () => {
    const id = await newForm();
    for (const who of ['owner', 'editor', 'creator', 'dataCollaborator', 'viewer'] as const) {
      const res = await call('GET', `/v1/forms/${id}/review`, { as: user[who] });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(200);
      expect(res.json(), who).toEqual({ rev: 0, enabled: false, distinctCheckers: false, units: [] });
      expect(res.headers['etag']).toBe('"0"');
    }
    expect(await rowOf(id)).toBeUndefined();
  });

  it('is a 404 for a form of another org or a form that does not exist, and a 400 for an id that is not a uuid', async () => {
    const id = await newForm();
    expect((await call('GET', `/v1/forms/${id}/review`, { as: user.otherOwner, org: otherOrgId })).statusCode).toBe(404);
    expect((await call('GET', `/v1/forms/${randomUUID()}/review`)).statusCode).toBe(404);
    expect((await call('GET', '/v1/forms/not-a-uuid/review')).statusCode).toBe(400);
  });
});

describe('PUT review', () => {
  it('saves at the current revision, bumps it, and writes one record that names the keys and never a value', async () => {
    const id = await newForm({ draftUnits: ['unit_a', 'unit_b'] });
    const first = await put(id, settings([unit('unit_a'), unit('unit_b', { groupId: groupB, order: 2, visibility: 'whole_submission', required: false })], { distinctCheckers: true }), '0');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      rev: 1,
      enabled: true,
      distinctCheckers: true,
      units: [unit('unit_a'), unit('unit_b', { groupId: groupB, order: 2, visibility: 'whole_submission', required: false })],
    });
    expect(first.headers['etag']).toBe('"1"');
    expect(await rowOf(id)).toMatchObject({ rev: 1, enabled: true, updated_by: user.owner, org_id: orgId, settings: { enabled: true, distinctCheckers: true } });
    expect(await auditEvents(orgId, 'review.settings_updated', id)).toEqual([
      expect.objectContaining({ actorKind: 'user', actorId: user.owner, resourceType: 'form', resourceId: id, outcome: 'success', metadata: { changedKeys: ['enabled', 'distinctCheckers', 'units'], rev: 1, units: 2 } }),
    ]);

    const second = await put(id, settings([unit('unit_a'), unit('unit_b', { groupId: groupB, order: 2, visibility: 'whole_submission', required: false })], { distinctCheckers: false }), '"1"');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ rev: 2, distinctCheckers: false });
    const events = await auditEvents(orgId, 'review.settings_updated', id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ metadata: { changedKeys: ['distinctCheckers'], rev: 2, units: 2 } });

    const read = await call('GET', `/v1/forms/${id}/review`);
    expect(read.json()).toMatchObject({ rev: 2, enabled: true, distinctCheckers: false });
    expect(read.json<View>().units).toHaveLength(2);
    expect(read.headers['etag']).toBe('"2"');
    expect(JSON.stringify(events)).not.toContain(groupA);
  });

  it('refuses a stale If-Match with 409 REVIEW_SETTINGS_CONFLICT, keeps the stored revision and settings, and writes no record', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    expect((await put(id, settings([unit('unit_a')]), '0')).statusCode).toBe(200);
    expect((await put(id, settings([unit('unit_a', { order: 2 })]), '1')).statusCode).toBe(200);

    const stale = await put(id, settings([unit('unit_a', { order: 9 })]), '1');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'REVIEW_SETTINGS_CONFLICT' });
    // The first save of a form that has a row is stale too, and so is a revision from the future.
    expect((await put(id, settings([unit('unit_a', { order: 9 })]), '0')).statusCode).toBe(409);
    expect((await put(id, settings([unit('unit_a', { order: 9 })]), '7')).statusCode).toBe(409);
    expect(await rowOf(id)).toMatchObject({ rev: 2, settings: { units: [expect.objectContaining({ order: 2 })] } });
    expect(await auditEvents(orgId, 'review.settings_updated', id)).toHaveLength(2);

    // The current revision still saves.
    expect((await put(id, settings([unit('unit_a', { order: 3 })]), '2')).json()).toMatchObject({ rev: 3 });
  });

  it('asks for If-Match with 428, and does not write when it is missing or not a revision', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    for (const header of [undefined, 'latest', '-1', '1.5']) {
      const res = await put(id, settings([unit('unit_a')]), header);
      expect(res.statusCode, String(header)).toBe(428);
      expect(res.json()).toMatchObject({ code: 'REVIEW_SETTINGS_REV_REQUIRED' });
    }
    expect(await rowOf(id)).toBeUndefined();
  });

  it('lets exactly one of two saves with the same revision through', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    expect((await put(id, settings([unit('unit_a')]), '0')).statusCode).toBe(200);
    const both = await Promise.all([put(id, settings([unit('unit_a', { order: 4 })]), '1'), put(id, settings([unit('unit_a', { order: 5 })]), '1')]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await rowOf(id))?.rev).toBe(2);
    expect(await auditEvents(orgId, 'review.settings_updated', id)).toHaveLength(2);
  });

  it('lets exactly one of two first saves through (no row yet)', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    const both = await Promise.all([put(id, settings([unit('unit_a', { order: 4 })]), '0'), put(id, settings([unit('unit_a', { order: 5 })]), '0')]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await rowOf(id))?.rev).toBe(1);
  });

  it('accepts a unit of the draft, a unit of the live version and one only the live version still has, and refuses an unknown one with 400', async () => {
    // One page, so only one unit can be published over it; the draft then drops that unit and names two others (which overlap: a draft may, publish refuses).
    const id = await newForm({ liveUnits: ['unit_live'], draftUnits: ['unit_draft', 'unit_draft_too'] });
    const ok = await put(id, settings([unit('unit_live'), unit('unit_draft', { order: 2 }), unit('unit_draft_too', { order: 3 })]), '0');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<View>().units.map((u) => u.unitId)).toEqual(['unit_live', 'unit_draft', 'unit_draft_too']);

    const bad = await put(id, settings([unit('unit_live'), unit('unit_ghost', { order: 2 })]), '1');
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/units/1/unitId', message: expect.stringContaining('no review unit') }] });
    expect(await rowOf(id)).toMatchObject({ rev: 1 });
    expect(await auditEvents(orgId, 'review.settings_updated', id)).toHaveLength(1);
  });

  it('refuses a unit when the form has no review units at all, but saves "off, no units"', async () => {
    const id = await newForm();
    expect((await put(id, settings([unit('anything')]), '0')).statusCode).toBe(400);
    const off = await put(id, settings([], { enabled: false }), '0');
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ rev: 1, enabled: false, distinctCheckers: false, units: [] });
  });

  it('refuses a unit assigned twice, a group of another org, a group id that is not a uuid and an archived group with 400, and writes nothing', async () => {
    const id = await newForm({ draftUnits: ['unit_a', 'unit_b'] });
    const twice = await put(id, settings([unit('unit_a'), unit('unit_a', { order: 2 })]), '0');
    expect(twice.statusCode).toBe(400);
    expect(twice.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/units/1/unitId', message: 'this unit is assigned more than once' }] });

    const foreign = await put(id, settings([unit('unit_a', { groupId: otherOrgGroup })]), '0');
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/units/0/groupId', message: 'no such review group in this org, or it is archived' }] });
    // The answer is the same as for a group that never existed: it does not say the group is another org's.
    const missing = await put(id, settings([unit('unit_a', { groupId: randomUUID() })]), '0');
    expect(missing.json()).toEqual({ ...foreign.json(), instance: expect.any(String), requestId: expect.any(String) });

    // A valid opaque id that is not a uuid never reaches the uuid column (22P02 would be a 500): the answer is the same 400, and a real group beside it is not blamed.
    for (const groupId of ['abc', 'grp_1', 'not-a-uuid', '0190a000-0000-7000-8000-00000000000']) {
      const notUuid = await put(id, settings([unit('unit_a', { groupId }), unit('unit_b', { groupId: groupA, order: 2 })]), '0');
      expect(notUuid.statusCode, `${groupId}: ${notUuid.body}`).toBe(400);
      expect(notUuid.json(), groupId).toEqual({ ...foreign.json(), instance: expect.any(String), requestId: expect.any(String) });
    }

    const archived = await put(id, settings([unit('unit_a', { groupId: archivedGroup }), unit('unit_b', { groupId: groupA, order: 2 })]), '0');
    expect(archived.statusCode).toBe(400);
    expect(archived.json()).toMatchObject({ errors: [{ path: 'body/units/0/groupId' }] });

    expect(await rowOf(id)).toBeUndefined();
    expect(await auditEvents(orgId, 'review.settings_updated', id)).toEqual([]);
  });

  it('refuses an order below 1, an unknown visibility, a stray key and a missing flag (400) before it looks anything up', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    const bodies: unknown[] = [
      settings([unit('unit_a', { order: 0 })]),
      settings([unit('unit_a', { order: 1.5 })]),
      settings([unit('unit_a', { visibility: 'everything' as never })]),
      { ...settings([unit('unit_a')]), orgId },
      { enabled: true, units: [] },
      { enabled: 'yes', distinctCheckers: false, units: [] },
      settings([{ ...unit('unit_a'), note: 'x' } as never]),
      settings(Array.from({ length: 201 }, (_, i) => unit(`unit_${i}`))),
      null,
    ];
    for (const body of bodies) expect((await put(id, body, '0')).statusCode, JSON.stringify(body)?.slice(0, 80)).toBe(400);
    expect(await rowOf(id)).toBeUndefined();
  });

  it('keeps the stored org and writes the caller as updated_by, whatever the body says', async () => {
    const id = await newForm({ draftUnits: ['unit_a'], as: user.editor });
    const res = await put(id, settings([unit('unit_a')]), '0', { as: user.editor });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rowOf(id)).toMatchObject({ org_id: orgId, updated_by: user.editor });
  });
});

describe('who may read and save', () => {
  it('refuses a viewer’s PUT with 403 and a request.authorize denied record, and stores nothing', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    const res = await put(id, settings([unit('unit_a')]), '0', { as: user.viewer });
    expect(res.statusCode, res.body).toBe(403);
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
    expect(rows.map((r) => r.event)).toEqual([
      expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user.viewer, reason: 'missing_permission:ops.manage', resourceId: 'PUT /v1/forms/:id/review' }),
    ]);
    expect(await rowOf(id)).toBeUndefined();
    expect(await auditEvents(orgId, 'review.settings_updated', id)).toEqual([]);
  });

  it('refuses a data collaborator, who may read forms but not manage their operations, and lets an editor save', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    expect((await put(id, settings([unit('unit_a')]), '0', { as: user.dataCollaborator })).statusCode).toBe(403);
    expect((await put(id, settings([unit('unit_a')]), '0', { as: user.editor })).statusCode).toBe(200);
    expect((await call('GET', `/v1/forms/${id}/review`, { as: user.viewer })).json()).toMatchObject({ rev: 1, enabled: true });
  });
});

describe('another org', () => {
  it('cannot read or change this org’s review settings: 404, and the stored row is as it was', async () => {
    const id = await newForm({ draftUnits: ['unit_a'] });
    expect((await put(id, settings([unit('unit_a')]), '0')).statusCode).toBe(200);
    const before = await rowOf(id);
    const as = { as: user.otherOwner, org: otherOrgId };
    expect((await call('GET', `/v1/forms/${id}/review`, as)).statusCode).toBe(404);
    expect((await put(id, settings([], { enabled: false }), '1', as)).statusCode).toBe(404);
    expect(await rowOf(id)).toEqual(before);
    expect(await auditEvents(otherOrgId, 'review.settings_updated', id)).toEqual([]);
  });

  it('cannot put this org’s group on its own form (400), and this org’s unit ids mean nothing to it', async () => {
    const mine = await newForm({ draftUnits: ['unit_a'], org: otherOrgId, as: user.otherOwner });
    const res = await put(mine, settings([unit('unit_a', { groupId: groupA })]), '0', { as: user.otherOwner, org: otherOrgId });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errors: [{ path: 'body/units/0/groupId' }] });
    expect(await rowOf(mine)).toBeUndefined();
    const ok = await put(mine, settings([unit('unit_a', { groupId: otherOrgGroup })]), '0', { as: user.otherOwner, org: otherOrgId });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
