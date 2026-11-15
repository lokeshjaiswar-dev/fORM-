import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, provision, resolveFormSlug, type DbHandle } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig, type ApiConfig } from '../src/config.ts';
import { verifyAccessToken } from '../src/runtime/access-token.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { publishableDraft } from './publishable-draft.ts';

/*
 * WP-1.07 access API: settings with revisions, the password, the public address, and the respondent's unlock. The
 * unlock route is exercised here too, because one of the acceptance lines is about every response of every access and
 * unlock route (no hash, no argon2 string, errors included): `call` records each response and the last test scans them.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';
interface Seen {
  route: string;
  status: number;
  body: string;
}

let app: FastifyInstance;
let config: ApiConfig;
let owner: pg.Pool;
let appDb: DbHandle;
let orgId: string;
let otherOrgId: string;
let ownerId: string;
let viewerId: string;
let collaboratorId: string;
let otherOwnerId: string;
const seen: Seen[] = [];

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_access');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  appDb = createDb(urls.fr_app, { max: 2, applicationName: 'fr-api-access-test' });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  [ownerId, viewerId, collaboratorId, otherOwnerId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'access-a', otherOrgId, 'access-b']);
  for (const [id, role, org] of [
    [ownerId, 'owner', orgId],
    [viewerId, 'viewer', orgId],
    [collaboratorId, 'data_collaborator', orgId],
    [otherOwnerId, 'owner', otherOrgId],
  ] as const) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${role}-${id.slice(0, 8)}@access.test`]);
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
  config = parsed.config;
  app = await buildApp(config, { underPressure: false });
});

afterAll(async () => {
  await app?.close();
  await appDb?.close();
  await owner?.end();
});

/** A request as a member of an org, recorded (status and body) for the scan at the end of this file. */
async function call(method: Method, url: string, o: { user?: string; org?: string; body?: unknown; ifMatch?: string; ip?: string } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: { 'x-fr-dev-user': o.user ?? ownerId, 'x-fr-org': o.org ?? orgId, ...BROWSER, ...(o.ifMatch === undefined ? {} : { 'if-match': o.ifMatch }) },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
    ...(o.ip ? { remoteAddress: o.ip } : {}),
  });
  seen.push({ route: `${method} ${url.replace(UUID, ':id').replace(/^(\/v1\/p\/)[^/]+/, '$1:slug')}`, status: res.statusCode, body: res.body });
  return res;
}

/** The unlock route has no session: a respondent. */
async function unlock(slug: string, password: string, ip = '198.51.100.7') {
  const res = await app.inject({ method: 'POST', url: `/v1/p/${slug}/unlock`, remoteAddress: ip, payload: { password } });
  seen.push({ route: 'POST /v1/p/:slug/unlock', status: res.statusCode, body: res.body });
  return res;
}

/** A form row with a saved draft, published when asked, in org A unless said otherwise. */
async function newForm(o: { publish?: boolean; user?: string; org?: string } = {}): Promise<{ id: string; slug: string | null; versionId: string | null }> {
  const created = await call('POST', '/v1/forms', { ...(o.user ? { user: o.user } : {}), ...(o.org ? { org: o.org } : {}), body: { title: 'Access form' } });
  const { id } = created.json<{ id: string }>();
  const ctx = { ...(o.user ? { user: o.user } : {}), ...(o.org ? { org: o.org } : {}) };
  expect((await call('PUT', `/v1/forms/${id}/draft`, { ...ctx, body: { draft: publishableDraft(id) } })).statusCode).toBe(200);
  if (!o.publish) return { id, slug: null, versionId: null };
  const live = await call('POST', `/v1/forms/${id}/publish`, { ...ctx, body: {} });
  expect(live.statusCode).toBe(200);
  const { slug, versionId } = live.json<{ slug: string; versionId: string }>();
  return { id, slug, versionId };
}

/** The audit events of an action in an org's pending log, oldest first (the chain worker does not run in these tests). */
async function auditEvents(orgKey: string, action: string, formId?: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `select event from audit_pending where org_key = $1 and event->>'action' = $2 and ($3::text is null or event->>'formId' = $3) order by id`,
    [orgKey, action, formId ?? null],
  );
  return rows.map((r) => r.event);
}

const SETTINGS = { enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };
const putAccess = (id: string, body: unknown, ifMatch: string | undefined, o: { user?: string; org?: string } = {}) =>
  call('PUT', `/v1/forms/${id}/access`, { ...o, body, ...(ifMatch === undefined ? {} : { ifMatch }) });
const rowOf = async (id: string) =>
  (await owner.query<{ rev: number; enabled: boolean; submission_limit: number | null; embed_allowlist: string[]; password_hash: string | null }>(
    'select rev, enabled, submission_limit, embed_allowlist, password_hash from form_access where form_id = $1',
    [id],
  )).rows[0];

describe('GET access', () => {
  it('answers the defaults, at revision 0, for a form nobody configured', async () => {
    const { id } = await newForm();
    const res = await call('GET', `/v1/forms/${id}/access`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rev: 0, enabled: true, hasPassword: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 });
    expect(res.headers['etag']).toBe('"0"');
    expect(await rowOf(id)).toBeUndefined();
  });

  it('is a 404 for a form of another org, and needs a form that exists', async () => {
    const { id } = await newForm();
    expect((await call('GET', `/v1/forms/${id}/access`, { user: otherOwnerId, org: otherOrgId })).statusCode).toBe(404);
    expect((await call('GET', `/v1/forms/${randomUUID()}/access`)).statusCode).toBe(404);
    expect((await call('GET', '/v1/forms/not-a-uuid/access')).statusCode).toBe(400);
  });
});

describe('PUT access', () => {
  it('bumps the revision on each valid save and writes one audit record naming only the keys that changed', async () => {
    const { id } = await newForm();
    const first = await putAccess(id, { ...SETTINGS, enabled: false, closeAt: '2027-01-31T18:29:59Z', submissionLimit: 5, embedAllowlist: ['https://example.com'] }, '0');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ rev: 1, enabled: false, closeAt: '2027-01-31T18:29:59.000Z', submissionLimit: 5, embedAllowlist: ['https://example.com'], hasPassword: false });
    expect(first.headers['etag']).toBe('"1"');
    expect(await auditEvents(orgId, 'form.access_changed', id)).toEqual([
      expect.objectContaining({ actorKind: 'user', actorId: ownerId, resourceType: 'form', resourceId: id, outcome: 'success', metadata: { changedKeys: ['enabled', 'closeAt', 'submissionLimit', 'embedAllowlist'], rev: 1 } }),
    ]);

    const second = await putAccess(id, { ...SETTINGS, enabled: false, closeAt: '2027-01-31T18:29:59Z', submissionLimit: 8, embedAllowlist: ['https://example.com'] }, '"1"');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ rev: 2, submissionLimit: 8 });
    const events = await auditEvents(orgId, 'form.access_changed', id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ metadata: { changedKeys: ['submissionLimit'], rev: 2 } });

    const read = await call('GET', `/v1/forms/${id}/access`);
    expect(read.json()).toMatchObject({ rev: 2, enabled: false, submissionLimit: 8 });
    expect(await rowOf(id)).toMatchObject({ rev: 2, enabled: false, submission_limit: 8 });
  });

  it('refuses a save with a stale revision (409) and changes nothing, and asks for If-Match (428)', async () => {
    const { id } = await newForm();
    expect((await putAccess(id, { ...SETTINGS, submissionLimit: 3 }, '0')).statusCode).toBe(200);
    expect((await putAccess(id, { ...SETTINGS, submissionLimit: 4 }, '1')).statusCode).toBe(200);

    const stale = await putAccess(id, { ...SETTINGS, submissionLimit: 99 }, '1');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'ACCESS_REV_CONFLICT' });
    // The first save of a form that has a row is stale too.
    expect((await putAccess(id, { ...SETTINGS, submissionLimit: 99 }, '0')).statusCode).toBe(409);
    // A revision from the future is as wrong as one from the past.
    expect((await putAccess(id, { ...SETTINGS, submissionLimit: 99 }, '7')).statusCode).toBe(409);
    expect(await rowOf(id)).toMatchObject({ rev: 2, submission_limit: 4 });
    expect(await auditEvents(orgId, 'form.access_changed', id)).toHaveLength(2);

    const missing = await putAccess(id, { ...SETTINGS, submissionLimit: 99 }, undefined);
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: 'ACCESS_REV_REQUIRED' });
    expect((await putAccess(id, { ...SETTINGS }, 'latest')).statusCode).toBe(428);
    expect((await putAccess(id, { ...SETTINGS }, '-1')).statusCode).toBe(428);
    expect(await rowOf(id)).toMatchObject({ rev: 2, submission_limit: 4 });
  });

  it('lets exactly one of two saves with the same revision through', async () => {
    const { id } = await newForm();
    expect((await putAccess(id, { ...SETTINGS }, '0')).statusCode).toBe(200);
    const both = await Promise.all([putAccess(id, { ...SETTINGS, submissionLimit: 10 }, '1'), putAccess(id, { ...SETTINGS, submissionLimit: 20 }, '1')]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await rowOf(id))?.rev).toBe(2);
    expect(await auditEvents(orgId, 'form.access_changed', id)).toHaveLength(2);
    // The same race on the very first save of a form that has no row.
    const fresh = await newForm();
    const first = await Promise.all([putAccess(fresh.id, { ...SETTINGS, submissionLimit: 10 }, '0'), putAccess(fresh.id, { ...SETTINGS, submissionLimit: 20 }, '0')]);
    expect(first.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await rowOf(fresh.id))?.rev).toBe(1);
  });

  it('answers 400 with the paths for a time zone that is not IANA, a close before the open, and an embed origin that is not https', async () => {
    const { id } = await newForm();
    const zone = await putAccess(id, { ...SETTINGS, availability: { timeZone: 'Mars/Olympus_Mons', windows: [{ weekdays: [1], from: '09:00', to: '17:00' }] } }, '0');
    expect(zone.statusCode).toBe(400);
    expect(zone.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/availability/timeZone' }] });

    const range = await putAccess(id, { ...SETTINGS, openAt: '2027-02-01T00:00:00Z', closeAt: '2027-01-01T00:00:00Z' }, '0');
    expect(range.statusCode).toBe(400);
    expect(range.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/closeAt' }] });

    const origin = await putAccess(id, { ...SETTINGS, embedAllowlist: ['https://ok.example.com', 'http://insecure.example.com'] }, '0');
    expect(origin.statusCode).toBe(400);
    expect(origin.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/embedAllowlist/1' }] });

    for (const [name, patch, path] of [
      ['a limit of zero', { submissionLimit: 0 }, 'body/submissionLimit'],
      ['a redirect entry with a scheme', { redirectAllowlist: ['https://example.com'] }, 'body/redirectAllowlist/0'],
      ['a window of 721 hours', { acceptPreviousVersionsHours: 721 }, 'body/acceptPreviousVersionsHours'],
      // A key the twin does not have is an issue on the object itself, not on a path below it.
      ['a password in the settings', { password: 'a-secret-passphrase' }, 'body/'],
    ] as const) {
      const res = await putAccess(id, { ...SETTINGS, ...patch }, '0');
      expect(res.statusCode, name).toBe(400);
      expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path), name).toContain(path);
    }
    // None of it wrote anything.
    expect(await rowOf(id)).toBeUndefined();
    expect(await auditEvents(orgId, 'form.access_changed', id)).toEqual([]);
  });

  it('stores availability, allowlists and screens as sent, and sends them back as they were saved', async () => {
    const { id } = await newForm();
    const screens = { closed: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We are closed for the season.' }] }] } } };
    const body = {
      ...SETTINGS,
      openAt: '2026-12-01T03:30:00Z',
      availability: { timeZone: 'Asia/Kolkata', windows: [{ weekdays: [5, 1], from: '09:00', to: '18:00' }] },
      redirectAllowlist: ['Example.com'],
      embedAllowlist: ['https://Forms.Example.com'],
      screens,
      acceptPreviousVersionsHours: 24,
    };
    const saved = await putAccess(id, body, '0');
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      availability: { timeZone: 'Asia/Kolkata', windows: [{ weekdays: [1, 5], from: '09:00', to: '18:00' }] },
      redirectAllowlist: ['example.com'],
      embedAllowlist: ['https://forms.example.com'],
      screens,
      acceptPreviousVersionsHours: 24,
    });
    const view = (await call('GET', `/v1/forms/${id}/access`)).json<Record<string, unknown>>();
    // What GET sends can be edited and put back (minus what the server owns).
    const { rev, hasPassword, passwordUpdatedAt, ...editable } = view;
    expect([rev, hasPassword, passwordUpdatedAt]).toEqual([1, false, undefined]);
    expect((await putAccess(id, { ...editable, submissionLimit: 2 }, String(rev))).statusCode).toBe(200);
    // A key left out clears it: this save has no window, no open date and no redirect list.
    const cleared = await putAccess(id, { ...SETTINGS }, '2');
    expect(cleared.json()).toEqual({ rev: 3, enabled: true, hasPassword: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 });
  });

  it('ignores an org named in the body and files the settings under the caller’s org', async () => {
    const { id } = await newForm();
    const res = await putAccess(id, { ...SETTINGS, orgId: otherOrgId }, '0');
    expect(res.statusCode).toBe(400);
    expect((await putAccess(id, { ...SETTINGS, submissionLimit: 1 }, '0')).statusCode).toBe(200);
    const { rows } = await owner.query<{ org_id: string }>('select org_id from form_access where form_id = $1', [id]);
    expect(rows).toEqual([{ org_id: orgId }]);
  });
});

describe('permission ops.manage', () => {
  it('gives a member without it an audited 403 on every access route, and writes nothing', async () => {
    const { id } = await newForm({ publish: true });
    const routes: Array<[Method, string, unknown]> = [
      ['GET', `/v1/forms/${id}/access`, undefined],
      ['PUT', `/v1/forms/${id}/access`, SETTINGS],
      ['PUT', `/v1/forms/${id}/access/password`, { password: 'a perfectly good passphrase' }],
      ['DELETE', `/v1/forms/${id}/access/password`, undefined],
      ['GET', `/v1/forms/${id}/slug`, undefined],
      ['PUT', `/v1/forms/${id}/slug`, { slug: 'viewer-was-here' }],
    ];
    // Viewers and data collaborators read forms and answers but do not manage a form's operations.
    for (const user of [viewerId, collaboratorId]) {
      for (const [method, url, body] of routes) {
        const res = await call(method, url, { user, body, ...(method === 'PUT' && url.endsWith('/access') ? { ifMatch: '0' } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
        const events = await auditEvents(orgId, 'request.authorize');
        expect(events.at(-1)).toMatchObject({
          actorId: user,
          outcome: 'denied',
          reason: 'missing_permission:ops.manage',
          requestId: res.headers['x-request-id'],
          resourceId: `${method} ${url.replace(id, ':id')}`,
        });
      }
    }
    expect(await rowOf(id)).toBeUndefined();
    expect((await call('GET', `/v1/forms/${id}/slug`)).json()).toMatchObject({ previousSlugs: [] });
  });

  it('is held by the roles that author forms: an editor may manage access', async () => {
    const editorId = randomUUID();
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [editorId, `editor-${editorId.slice(0, 8)}@access.test`]);
    await owner.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'editor')`, [orgId, editorId]);
    const { id } = await newForm();
    expect((await call('GET', `/v1/forms/${id}/access`, { user: editorId })).statusCode).toBe(200);
  });
});

describe('the password', () => {
  it('is stored as an argon2id hash, reported only as hasPassword, and audited without its value', async () => {
    const { id } = await newForm();
    const password = 'violet-anchor-teapot-91';
    const set = await call('PUT', `/v1/forms/${id}/access/password`, { body: { password } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ hasPassword: true });
    expect((await rowOf(id))?.password_hash).toMatch(/^\$argon2id\$/);

    const read = await call('GET', `/v1/forms/${id}/access`);
    expect(read.json()).toMatchObject({ hasPassword: true, passwordUpdatedAt: expect.any(String) });
    expect(Object.keys(read.json())).not.toContain('password');

    const events = await auditEvents(orgId, 'form.password_changed', id);
    expect(events).toEqual([expect.objectContaining({ actorId: ownerId, outcome: 'success', resourceType: 'form', metadata: { change: 'set' } })]);
    expect(JSON.stringify(events)).not.toContain(password);
    expect(JSON.stringify(events)).not.toContain('argon2');
  });

  it('does not change the settings revision, and survives a settings save', async () => {
    const { id } = await newForm();
    expect((await putAccess(id, { ...SETTINGS }, '0')).statusCode).toBe(200);
    expect((await call('PUT', `/v1/forms/${id}/access/password`, { body: { password: 'violet-anchor-teapot-91' } })).statusCode).toBe(200);
    expect((await call('GET', `/v1/forms/${id}/access`)).json()).toMatchObject({ rev: 1, hasPassword: true });
    const saved = await putAccess(id, { ...SETTINGS, submissionLimit: 4 }, '1');
    expect(saved.json()).toMatchObject({ rev: 2, hasPassword: true });
    expect((await rowOf(id))?.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('sets a password on a form that was never configured, and replaces one with a new hash', async () => {
    const { id } = await newForm();
    expect(await rowOf(id)).toBeUndefined();
    await call('PUT', `/v1/forms/${id}/access/password`, { body: { password: 'violet-anchor-teapot-91' } });
    const first = (await rowOf(id))?.password_hash;
    expect(first).toBeTruthy();
    // The first password made the row, with the defaults, at revision 1.
    expect(await rowOf(id)).toMatchObject({ rev: 1, enabled: true, submission_limit: null });
    await call('PUT', `/v1/forms/${id}/access/password`, { body: { password: 'a different passphrase 42' } });
    const second = (await rowOf(id))?.password_hash;
    expect(second).toMatch(/^\$argon2id\$/);
    expect(second).not.toBe(first);
    expect(await auditEvents(orgId, 'form.password_changed', id)).toHaveLength(2);
  });

  it('refuses a password that is too short, too long or common (422), and an empty or odd body (400), without storing one', async () => {
    const { id } = await newForm();
    for (const password of ['short1', 'password123', 'x'.repeat(129)]) {
      const res = await call('PUT', `/v1/forms/${id}/access/password`, { body: { password } });
      expect(res.statusCode, password.slice(0, 12)).toBe(422);
      expect(res.json()).toMatchObject({ code: 'WEAK_PASSWORD' });
      expect(res.body).not.toContain(password);
    }
    expect((await call('PUT', `/v1/forms/${id}/access/password`, { body: { password: '' } })).statusCode).toBe(400);
    expect((await call('PUT', `/v1/forms/${id}/access/password`, { body: { password: 'violet-anchor-teapot-91', hash: '$argon2id$x' } })).statusCode).toBe(400);
    expect((await call('PUT', `/v1/forms/${id}/access/password`, { body: {} })).statusCode).toBe(400);
    expect(await rowOf(id)).toBeUndefined();
    expect(await auditEvents(orgId, 'form.password_changed', id)).toEqual([]);
  });

  it('is removed by DELETE (idempotent, audited once) and then reads as no password', async () => {
    const { id } = await newForm();
    await call('PUT', `/v1/forms/${id}/access/password`, { body: { password: 'violet-anchor-teapot-91' } });
    const removed = await call('DELETE', `/v1/forms/${id}/access/password`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ hasPassword: false });
    expect((await rowOf(id))?.password_hash).toBeNull();
    expect((await call('GET', `/v1/forms/${id}/access`)).json()).toMatchObject({ hasPassword: false });
    const again = await call('DELETE', `/v1/forms/${id}/access/password`);
    expect(again.json()).toEqual({ hasPassword: false });
    expect((await auditEvents(orgId, 'form.password_changed', id)).map((e) => (e['metadata'] as { change: string }).change)).toEqual(['set', 'removed']);
    // A form that never had a row: nothing to remove, nothing audited, no row made.
    const fresh = await newForm();
    expect((await call('DELETE', `/v1/forms/${fresh.id}/access/password`)).json()).toEqual({ hasPassword: false });
    expect(await rowOf(fresh.id)).toBeUndefined();
    expect(await auditEvents(orgId, 'form.password_changed', fresh.id)).toEqual([]);
  });

  it('is a 404 for a form of another org, and the other org’s form keeps its own password', async () => {
    const mine = await newForm();
    await call('PUT', `/v1/forms/${mine.id}/access/password`, { body: { password: 'violet-anchor-teapot-91' } });
    const before = (await rowOf(mine.id))?.password_hash;
    expect((await call('PUT', `/v1/forms/${mine.id}/access/password`, { user: otherOwnerId, org: otherOrgId, body: { password: 'another org was here 77' } })).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/forms/${mine.id}/access/password`, { user: otherOwnerId, org: otherOrgId })).statusCode).toBe(404);
    expect((await rowOf(mine.id))?.password_hash).toBe(before);
  });
});

describe('the public address', () => {
  it('keeps the old slug resolving to the new primary one after a change, and keeps forms.slug in step', async () => {
    const form = await newForm({ publish: true });
    const oldSlug = form.slug!;
    expect((await call('GET', `/v1/forms/${form.id}/slug`)).json()).toEqual({ slug: oldSlug, previousSlugs: [] });

    const changed = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: 'spring-fair-2027' } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ slug: 'spring-fair-2027', previousSlugs: [oldSlug] });

    // The new address is the primary one; the old one resolves to the same form and names the new one to redirect to.
    expect(await resolveFormSlug(appDb.db, 'spring-fair-2027')).toMatchObject({ formId: form.id, primarySlug: 'spring-fair-2027' });
    expect(await resolveFormSlug(appDb.db, oldSlug)).toMatchObject({ formId: form.id, primarySlug: 'spring-fair-2027' });
    const viaOld = await app.inject({ url: `/v1/p/${oldSlug}` });
    expect(viaOld.statusCode).toBe(200);
    expect(viaOld.json<{ formId: string }>().formId).toBe(form.id);
    expect((await app.inject({ url: '/v1/p/spring-fair-2027' })).statusCode).toBe(200);

    const { rows } = await owner.query<{ slug: string; is_primary: boolean }>('select slug, is_primary from form_slugs where form_id = $1 order by created_at, slug', [form.id]);
    expect(rows).toEqual([
      { slug: oldSlug, is_primary: false },
      { slug: 'spring-fair-2027', is_primary: true },
    ]);
    expect((await owner.query<{ slug: string }>('select slug from forms where id = $1', [form.id])).rows[0]?.slug).toBe('spring-fair-2027');
    expect(await auditEvents(orgId, 'form.slug_changed', form.id)).toEqual([
      expect.objectContaining({ actorId: ownerId, outcome: 'success', resourceType: 'form', metadata: { previousSlug: oldSlug, slug: 'spring-fair-2027' } }),
    ]);

    // Going back to an earlier address promotes it again, and no address is lost.
    const back = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: oldSlug } });
    expect(back.json()).toEqual({ slug: oldSlug, previousSlugs: ['spring-fair-2027'] });
    expect(await resolveFormSlug(appDb.db, 'spring-fair-2027')).toMatchObject({ primarySlug: oldSlug });
  });

  it('answers 409 FORM_SLUG_TAKEN for an address another form holds: current, former, or in another org', async () => {
    const form = await newForm({ publish: true });
    const other = await newForm({ publish: true });
    const taken = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: other.slug } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'FORM_SLUG_TAKEN' });

    // A former address of another form is still that form's.
    await call('PUT', `/v1/forms/${other.id}/slug`, { body: { slug: 'second-address-for-other' } });
    expect((await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: other.slug } })).statusCode).toBe(409);

    // An address in another org (one of its forms' current address).
    const foreign = await newForm({ user: otherOwnerId, org: otherOrgId });
    expect((await call('PUT', `/v1/forms/${foreign.id}/slug`, { user: otherOwnerId, org: otherOrgId, body: { slug: 'org-b-only-address' } })).statusCode).toBe(200);
    const clash = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: 'org-b-only-address' } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: 'FORM_SLUG_TAKEN' });

    // Nothing moved: the form keeps its address, and the refusals wrote no audit record.
    expect((await call('GET', `/v1/forms/${form.id}/slug`)).json()).toEqual({ slug: form.slug, previousSlugs: [] });
    expect(await auditEvents(orgId, 'form.slug_changed', form.id)).toEqual([]);
    expect((await owner.query<{ form_id: string }>(`select form_id from form_slugs where slug = 'org-b-only-address'`)).rows).toEqual([{ form_id: foreign.id }]);
  });

  it('checks the shape of an address (400 with the path) and treats the current address as no change', async () => {
    const form = await newForm({ publish: true });
    for (const slug of ['Upper-Case', 'ab', '-leading', 'trailing-', 'has space', 'a/b', 'under_score', 'x'.repeat(101), '']) {
      const res = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug } });
      expect(res.statusCode, slug).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body/slug' }] });
    }
    expect((await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: form.slug, extra: 1 } })).statusCode).toBe(400);
    const same = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: form.slug } });
    expect(same.json()).toEqual({ slug: form.slug, previousSlugs: [] });
    expect(await auditEvents(orgId, 'form.slug_changed', form.id)).toEqual([]);
  });

  it('can be chosen before the first publish, and publishing keeps it', async () => {
    const form = await newForm();
    expect((await call('GET', `/v1/forms/${form.id}/slug`)).json()).toEqual({ slug: null, previousSlugs: [] });
    const chosen = await call('PUT', `/v1/forms/${form.id}/slug`, { body: { slug: 'chosen-before-publish' } });
    expect(chosen.json()).toEqual({ slug: 'chosen-before-publish', previousSlugs: [] });
    const live = await call('POST', `/v1/forms/${form.id}/publish`, { body: {} });
    expect(live.json()).toMatchObject({ slug: 'chosen-before-publish' });
    expect((await app.inject({ url: '/v1/p/chosen-before-publish' })).statusCode).toBe(200);
  });

  it('is a 404 for a form of another org', async () => {
    const form = await newForm({ publish: true });
    expect((await call('GET', `/v1/forms/${form.id}/slug`, { user: otherOwnerId, org: otherOrgId })).statusCode).toBe(404);
    expect((await call('PUT', `/v1/forms/${form.id}/slug`, { user: otherOwnerId, org: otherOrgId, body: { slug: 'org-b-takes-it' } })).statusCode).toBe(404);
    expect((await call('GET', `/v1/forms/${form.id}/slug`)).json()).toMatchObject({ slug: form.slug });
  });
});

describe('the unlock route, seen from the access API', () => {
  it('accepts the password the access API set and refuses every other, and the token is for this form and version only', async () => {
    const form = await newForm({ publish: true });
    await call('PUT', `/v1/forms/${form.id}/access/password`, { body: { password: 'violet-anchor-teapot-91' } });
    const wrong = await unlock(form.slug!, 'violet-anchor-teapot-92');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'FORM_UNLOCK_FAILED' });
    const right = await unlock(form.slug!, 'violet-anchor-teapot-91');
    expect(right.statusCode, right.body).toBe(200);
    const { accessToken, expiresAt } = right.json<{ accessToken: string; expiresAt: string }>();
    const scope = { formId: form.id, versionScope: form.versionId! };
    expect(verifyAccessToken(config.auth.secret, accessToken, scope, new Date())).toMatchObject({ formId: form.id });
    expect(verifyAccessToken(config.auth.secret, accessToken, { ...scope, formId: randomUUID() }, new Date())).toBeNull();
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(7190_000);

    // Removing the password ends the unlock: the same text no longer opens anything.
    await call('DELETE', `/v1/forms/${form.id}/access/password`);
    expect((await unlock(form.slug!, 'violet-anchor-teapot-91')).statusCode).toBe(401);
  });
});

describe('responses of the access and unlock routes', () => {
  it('never carry password_hash or an argon2 string, errors included', async () => {
    const routes = new Set(seen.map((s) => s.route));
    // The scan means something only if the suite reached every route and both kinds of answer.
    for (const route of [
      'GET /v1/forms/:id/access',
      'PUT /v1/forms/:id/access',
      'PUT /v1/forms/:id/access/password',
      'DELETE /v1/forms/:id/access/password',
      'GET /v1/forms/:id/slug',
      'PUT /v1/forms/:id/slug',
      'POST /v1/p/:slug/unlock',
    ]) {
      expect(routes, route).toContain(route);
      const answers = seen.filter((s) => s.route === route);
      expect(answers.some((s) => s.status < 300), `${route} answered 2xx`).toBe(true);
      expect(answers.some((s) => s.status >= 400), `${route} answered 4xx`).toBe(true);
    }
    expect(seen.length).toBeGreaterThan(150);

    const stored = (await owner.query<{ password_hash: string }>('select password_hash from form_access where password_hash is not null')).rows.map((r) => r.password_hash);
    expect(stored.length).toBeGreaterThan(3);
    const leaks = seen.filter((s) => /password_hash|passwordHash|argon2/i.test(s.body) || stored.some((hash) => s.body.includes(hash)));
    expect(leaks.map((s) => `${s.route} ${s.status}`)).toEqual([]);
  });

  it('are not the place the password is echoed: no response holds a password that was sent', async () => {
    const sent = ['violet-anchor-teapot-91', 'violet-anchor-teapot-92', 'a different passphrase 42', 'a-secret-passphrase', 'password123'];
    expect(seen.filter((s) => sent.some((p) => s.body.includes(p))).map((s) => `${s.route} ${s.status}`)).toEqual([]);
  });
});
