import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTenantEgressGuard, egressHttp, sendHttp, type EgressResolver } from '@form/adapters/egress';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { parseEditionConfig } from '@form/config';
import { provision } from '@form/db';
import { PortError, type OrgSecrets } from '@form/ports';
import { createTestDatabase, installEgressTripwire } from '@form/testkit';
import { buildApp, type AppDeps } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import type { TenantHttp, UpstreamHttpRequest } from '../src/remote/upstream.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';
import { throttleWindowSeconds } from './throttle-window.ts';

/*
 * Server-side lookups (T-LK-01..14): the respondent's proxy `POST /v1/p/:slug/lookups|fields/...`, the org API credentials and
 * the author's test route. The upstream API is a stub `tenantHttp` that records what it was sent (so a test can say "the
 * credential was never sent" and "the upstream was never called"); the SSRF matrix runs through the real tenant egress guard
 * with a fake resolver and the testkit tripwire; the size and time caps run against a real local server.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const SECRET_TOKEN = 'SENTINEL-TOKEN-5f7a91c3d2e8b4a6';
const UPSTREAM_HOST = 'hr.example.test';
const LOOKUP_URL = `https://${UPSTREAM_HOST}/SENTINEL-PATH/people`;
const SENTINEL_ITEMS = 'SENTINEL_ITEMS_PATH';
const SENTINEL_PARAM = 'SENTINEL_SEARCH_PARAM';
const SENTINEL_Q = 'sentinelq9f3';
const SENTINEL_CELL = 'SENTINEL-CELL-VALUE-77';

let owner: pg.Pool;
let orgId: string;
let otherOrgId: string;
const user = { owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), otherOwner: randomUUID() };
let orgSecrets: OrgSecrets;
let urls: { fr_app: string };
let database: string;
const apps: FastifyInstance[] = [];
let nextAddress = 1;
const address = () => `198.51.100.${nextAddress++}`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
let calls: Call[] = [];
let upstream: (call: Call) => { status: number; body: string } | Promise<{ status: number; body: string }> = () => ({ status: 200, body: '{}' });
const stubHttp: TenantHttp = async (url, r: UpstreamHttpRequest) => {
  const call: Call = { url: url.toString(), method: r.method, headers: r.headers, body: r.body };
  calls.push(call);
  const out = await upstream(call);
  return { status: out.status, text: () => out.body };
};

const people = (n: number) => ({
  [SENTINEL_ITEMS]: Array.from({ length: n }, (_, i) => ({ name: `Maya ${i}`, city: i === 0 ? 'x'.repeat(1500) : `City ${i}`, secret: SENTINEL_CELL, phone: `90000000${i}` })),
});

async function startApp(deps: Partial<AppDeps>, env: Record<string, string> = {}, limits?: AppDeps['authLimits'], logStream?: Writable): Promise<FastifyInstance> {
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', AUTH_SECRET: Buffer.alloc(32, 7).toString('base64url'), LOG_LEVEL: logStream ? 'info' : 'silent', ...env });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const app = await buildApp(parsed.config, { underPressure: false, orgSecrets, ...(limits ? { authLimits: limits } : {}), ...(logStream ? { logStream } : {}), ...deps });
  apps.push(app);
  return app;
}

let app: FastifyInstance;
const asUser = (who: string, org = orgId) => ({ 'x-fr-dev-user': who, 'x-fr-org': org, ...BROWSER });
const api = (a: FastifyInstance, who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, org = orgId, extra: Record<string, string> = {}) =>
  a.inject({ method, url, headers: { ...asUser(who, org), ...extra }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });

async function credential(a: FastifyInstance, host = UPSTREAM_HOST, token = SECRET_TOKEN, who = user.owner, org = orgId): Promise<string> {
  const res = await api(a, who, 'POST', '/v1/org/api-credentials', { name: `cred ${host}`, host, auth: { type: 'bearer', token } }, org);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

interface Form {
  id: string;
  slug: string;
  versionId: string;
}
const lookupDef = (over: Record<string, unknown> = {}) => ({
  id: 'hr',
  name: 'HR',
  enabled: true,
  url: LOOKUP_URL,
  method: 'GET',
  itemsPath: SENTINEL_ITEMS,
  pickerFieldId: 'emp',
  pickerKey: 'name',
  mappings: [{ key: 'city', fieldId: 'city_name' }, { key: 'phone', fieldId: 'phone' }, { key: 'secret' }],
  searchParam: SENTINEL_PARAM,
  minChars: 2,
  maxRows: 3,
  ...over,
});

async function publishForm(a: FastifyInstance, o: { lookups?: Array<Record<string, unknown>>; blocks?: Array<ReturnType<typeof fieldBlock>>; title?: string; who?: string; org?: string } = {}): Promise<Form> {
  const who = o.who ?? user.owner;
  const org = o.org ?? orgId;
  const created = await api(a, who, 'POST', '/v1/forms', { title: o.title ?? 'Lookup form' }, org);
  const { id } = created.json<{ id: string }>();
  const blocks = o.blocks ?? [fieldBlock('emp', 'short_text'), fieldBlock('city_name', 'short_text'), fieldBlock('phone', 'short_text')];
  const draft = { ...draftWith(id, blocks, o.title ?? 'Lookup form'), ...(o.lookups ? { lookups: o.lookups } : {}) };
  const put = await api(a, who, 'PUT', `/v1/forms/${id}/draft`, { draft }, org, { 'if-match': '0' });
  expect(put.statusCode, put.body).toBe(200);
  const live = await api(a, who, 'POST', `/v1/forms/${id}/publish`, {}, org);
  expect(live.statusCode, live.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

const proxy = (a: FastifyInstance, f: Form, path: string, body: unknown, headers: Record<string, string> = {}, ip = address()) =>
  a.inject({ method: 'POST', url: `/v1/p/${f.slug}${path}`, remoteAddress: ip, headers, payload: body as Record<string, unknown> });
const lookup = (a: FastifyInstance, f: Form, q: string, over: Record<string, unknown> = {}, id = 'hr', headers: Record<string, string> = {}, ip = address()) =>
  proxy(a, f, `/lookups/${id}`, { formVersionId: f.versionId, q, ...over }, headers, ip);

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  database = await createTestDatabase(adminUrl, 'fr_api_remote');
  const prov = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  urls = prov.urls;
  owner = new pg.Pool({ connectionString: prov.urls.fr_migrator, max: 4 });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'remote-a', otherOrgId, 'remote-b']);
  for (const [id, role, org] of [[user.owner, 'owner', orgId], [user.editor, 'editor', orgId], [user.viewer, 'viewer', orgId], [user.otherOwner, 'owner', otherOrgId]] as const) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${role}-${id.slice(0, 8)}@remote.test`]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
  }
  orgSecrets = createOrgSecrets(createKeyfileKeyProvider({ masterKey: randomBytes(32) }));
  app = await startApp({ tenantHttp: stubHttp });
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await owner?.end();
});

describe('org API credentials (/v1/org/api-credentials)', () => {
  it('org.settings creates one; the secret is sealed, never returned, and only its last four characters are shown', async () => {
    const res = await api(app, user.owner, 'POST', '/v1/org/api-credentials', { name: 'HR api', host: 'HR.Example.Test:443', auth: { type: 'bearer', token: SECRET_TOKEN } });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json<Record<string, unknown>>();
    expect(made).toMatchObject({ name: 'HR api', type: 'bearer', host: 'hr.example.test', last4: SECRET_TOKEN.slice(-4), header: null, rotatedAt: null });
    expect(res.body).not.toContain(SECRET_TOKEN);
    const stored = (await owner.query('select enc, meta from secrets where id = $1', [made['id']])).rows[0] as { enc: unknown; meta: unknown };
    expect(JSON.stringify(stored)).not.toContain(SECRET_TOKEN);
    expect(await orgSecrets.open({ orgId, secretId: String(made['id']), kind: 'api_credential' }, stored.enc).then((b) => new TextDecoder().decode(b))).toContain(SECRET_TOKEN);
    const list = await api(app, user.owner, 'GET', '/v1/org/api-credentials');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(SECRET_TOKEN);
  });

  it('forms.edit lists them but cannot create, rotate or delete; a viewer cannot even list', async () => {
    const id = await credential(app, 'list.example.test');
    expect((await api(app, user.editor, 'GET', '/v1/org/api-credentials')).json<{ items: Array<{ id: string }> }>().items.map((c) => c.id)).toContain(id);
    const body = { name: 'x', host: 'x.example.test', auth: { type: 'bearer', token: 'abcdefghijklmnop' } };
    expect((await api(app, user.editor, 'POST', '/v1/org/api-credentials', body)).statusCode).toBe(403);
    expect((await api(app, user.editor, 'PUT', `/v1/org/api-credentials/${id}`, { name: 'renamed' })).statusCode).toBe(403);
    expect((await api(app, user.editor, 'DELETE', `/v1/org/api-credentials/${id}`)).statusCode).toBe(403);
    expect((await api(app, user.viewer, 'GET', '/v1/org/api-credentials')).statusCode).toBe(403);
  });

  it('refuses a framing header for an api_key, a host with a path or a scheme, and unknown keys', async () => {
    const make = (over: Record<string, unknown>) => api(app, user.owner, 'POST', '/v1/org/api-credentials', { name: 'k', host: 'k.example.test', auth: { type: 'api_key', header: 'X-Api-Key', value: 'abcdefghijklmnop' }, ...over });
    expect((await make({})).statusCode).toBe(201);
    for (const header of ['Host', 'content-length', 'Transfer-Encoding', 'Connection', 'Cookie', 'Set-Cookie', 'Proxy-Authorization', 'X-Forwarded-For', 'Forwarded', 'bad header']) {
      expect((await make({ auth: { type: 'api_key', header, value: 'abcdefghijklmnop' } })).statusCode, header).toBe(400);
    }
    for (const host of ['https://k.example.test', 'k.example.test/path', 'user@k.example.test', 'k example', '']) expect((await make({ host })).statusCode, host).toBe(400);
    expect((await make({ extra: 1 })).statusCode).toBe(400);
  });

  it('rotates in place (same id, new secret, rotatedAt set), re-binds the host, deletes, and audits without values', async () => {
    const id = await credential(app, 'rot.example.test');
    const before = (await owner.query('select enc from secrets where id = $1', [id])).rows[0] as { enc: unknown };
    const rot = await api(app, user.owner, 'PUT', `/v1/org/api-credentials/${id}`, { auth: { type: 'basic', username: 'svc', password: 'new-password-abcdef' } });
    expect(rot.statusCode, rot.body).toBe(200);
    expect(rot.json()).toMatchObject({ id, type: 'basic', host: 'rot.example.test' });
    expect(rot.json<{ rotatedAt: string | null }>().rotatedAt).not.toBeNull();
    const after = (await owner.query('select enc from secrets where id = $1', [id])).rows[0] as { enc: unknown };
    expect(after.enc).not.toEqual(before.enc);
    const rebound = await api(app, user.owner, 'PUT', `/v1/org/api-credentials/${id}`, { host: 'other.example.test:8443', name: 'renamed' });
    expect(rebound.json()).toMatchObject({ host: 'other.example.test:8443', name: 'renamed', type: 'basic' });
    expect((await api(app, user.owner, 'DELETE', `/v1/org/api-credentials/${id}`)).statusCode).toBe(204);
    expect((await api(app, user.owner, 'DELETE', `/v1/org/api-credentials/${id}`)).statusCode).toBe(404);
    const events = (await owner.query(`select event from audit_pending where org_key = $1 and event->>'resourceId' = $2 order by id`, [orgId, id])).rows.map((r: { event: Record<string, unknown> }) => r.event);
    expect(events.map((e) => e['action'])).toEqual(['api_credential.saved', 'api_credential.saved', 'api_credential.saved', 'api_credential.deleted']);
    expect(JSON.stringify(events)).not.toMatch(/new-password|SENTINEL|svc/);
  });

  it('answers 503 when the deployment has no key service', async () => {
    const bare = await startApp({ tenantHttp: stubHttp, orgSecrets: undefined as never });
    const res = await api(bare, user.owner, 'POST', '/v1/org/api-credentials', { name: 'k', host: 'k.example.test', auth: { type: 'bearer', token: 'abcdefghijklmnop' } });
    expect(res.statusCode).toBe(503);
  });
});

describe('the public proxy: lookup, options and check', () => {
  let form: Form;
  let secretId: string;

  async function makeForm(): Promise<Form> {
    const checkBlock = fieldBlock('code', 'short_text', {}, { apiValidation: { url: `https://${UPSTREAM_HOST}/verify`, method: 'GET', responseKey: 'SENTINEL_RESPONSE_KEY', success: { type: 'boolean', equals: true }, credentialRef: { secretId } } });
    const optionsBlock = fieldBlock('size', 'short_text', {}, { apiOptions: { url: `https://${UPSTREAM_HOST}/sizes`, method: 'GET', itemsPath: 'SENTINEL_ITEMS_OPTS', labelKey: 'label', valueKey: 'id', credentialRef: { secretId } } });
    return publishForm(app, {
      blocks: [fieldBlock('emp', 'short_text'), fieldBlock('city_name', 'short_text'), fieldBlock('phone', 'short_text'), checkBlock, optionsBlock],
      lookups: [lookupDef({ credentialRef: { secretId } }), lookupDef({ id: 'off', enabled: false })],
    });
  }

  beforeAll(async () => {
    secretId = await credential(app);
    form = await makeForm();
  });

  it('T-LK-01: the public form holds no secret, secret id, host, path, query key, items path or search param; neither does any proxy answer', async () => {
    calls = [];
    upstream = (c) => (c.url.includes('/sizes') ? { status: 200, body: JSON.stringify({ SENTINEL_ITEMS_OPTS: [{ id: 'm', label: 'Medium' }] }) } : c.url.includes('/verify') ? { status: 200, body: '{"SENTINEL_RESPONSE_KEY":true}' } : { status: 200, body: JSON.stringify(people(2)) });
    const page = await app.inject({ method: 'GET', url: `/v1/p/${form.slug}` });
    const answers = [page.body];
    answers.push((await lookup(app, form, 'ma')).body);
    answers.push((await proxy(app, form, '/fields/size/options', { formVersionId: form.versionId })).body);
    answers.push((await proxy(app, form, '/fields/code/check', { formVersionId: form.versionId, value: 'ABC' })).body);
    for (const leak of [SECRET_TOKEN, secretId, UPSTREAM_HOST, 'SENTINEL-PATH', SENTINEL_ITEMS, 'SENTINEL_ITEMS_OPTS', SENTINEL_PARAM, 'SENTINEL_RESPONSE_KEY', 'credentialRef', 'searchParam', 'itemsPath', SENTINEL_CELL]) {
      for (const body of answers) expect(body, leak).not.toContain(leak);
    }
    const definition = (JSON.parse(page.body) as { version: { definition: { lookups: unknown[]; blocks: Record<string, { apiOptions?: unknown; apiValidation?: unknown }> } } }).version.definition;
    expect(definition.lookups).toHaveLength(1);
    expect(definition.blocks['size']!.apiOptions).toEqual({ remote: true });
    expect(definition.blocks['code']!.apiValidation).toEqual({ remote: true });
  });

  it('a lookup: searches upstream under the stored search param with the credential, and returns only the declared cells, at most maxRows', async () => {
    calls = [];
    upstream = () => ({ status: 200, body: JSON.stringify(people(8)) });
    const res = await lookup(app, form, `${SENTINEL_Q}a`);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(new URL(calls[0]!.url).searchParams.get(SENTINEL_PARAM)).toBe(`${SENTINEL_Q}a`);
    expect(calls[0]!.headers['cookie']).toBeUndefined();
    const body = res.json<{ rows: Array<{ label: string; cells: Record<string, string> }>; truncated: boolean }>();
    // T-LK-03: three rows (maxRows), more existed; cells only for name, city, phone (the mapping without a field is not returned); long cell capped.
    expect(body.rows).toHaveLength(3);
    expect(body.truncated).toBe(true);
    for (const row of body.rows) expect(Object.keys(row.cells).every((k) => ['name', 'city', 'phone'].includes(k))).toBe(true);
    expect(body.rows[0]!.cells['city']!.length).toBe(1000);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_CELL);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('caches a lookup for 30 s per version, lookup and search (a repeat does not call upstream again)', async () => {
    calls = [];
    upstream = () => ({ status: 200, body: JSON.stringify(people(2)) });
    const first = await lookup(app, form, 'cache me');
    const second = await lookup(app, form, '  CACHE ME ');
    expect(first.body).toBe(second.body);
    expect(calls).toHaveLength(1);
  });

  it('with fewer characters than minChars it answers no rows and calls nothing', async () => {
    calls = [];
    const res = await lookup(app, form, 'm');
    expect(res.json()).toEqual({ rows: [], truncated: false });
    expect(calls).toHaveLength(0);
  });

  it('options: at most 500, cached 60 s; check: answers only { ok }, never cached, upstream body never returned', async () => {
    // A form of its own: the options of `form` were cached by the first test.
    const form = await makeForm();
    calls = [];
    upstream = (c) => (c.url.includes('/sizes') ? { status: 200, body: JSON.stringify({ SENTINEL_ITEMS_OPTS: Array.from({ length: 700 }, (_, i) => ({ id: `s${i}`, label: `Size ${i}` })) }) } : { status: 200, body: '{"SENTINEL_RESPONSE_KEY":false,"detail":"upstream-private-detail"}' });
    const options = await proxy(app, form, '/fields/size/options', { formVersionId: form.versionId });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json<{ options: unknown[] }>().options).toHaveLength(500);
    await proxy(app, form, '/fields/size/options', { formVersionId: form.versionId });
    expect(calls.filter((c) => c.url.includes('/sizes'))).toHaveLength(1);
    const check = await proxy(app, form, '/fields/code/check', { formVersionId: form.versionId, value: 'ZZZ' });
    expect(check.json()).toEqual({ ok: false });
    expect(check.body).not.toContain('upstream-private-detail');
    expect(new URL(calls.find((c) => c.url.includes('/verify'))!.url).searchParams.get('code')).toBe('ZZZ');
    await proxy(app, form, '/fields/code/check', { formVersionId: form.versionId, value: 'ZZZ' });
    expect(calls.filter((c) => c.url.includes('/verify'))).toHaveLength(2);
  });

  it('T-LK-07: unknown body keys give 400, and so does a search term over 100 characters', async () => {
    calls = [];
    for (const extra of [{ url: 'https://evil.example/' }, { itemsPath: 'x' }, { headers: { a: 'b' } }, { keys: ['a'] }]) {
      expect((await lookup(app, form, 'ma', extra)).statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await lookup(app, form, 'x'.repeat(101))).statusCode).toBe(400);
    expect((await proxy(app, form, '/fields/size/options', { formVersionId: form.versionId, url: 'x' })).statusCode).toBe(400);
    expect((await proxy(app, form, '/fields/code/check', { formVersionId: form.versionId, value: 'x', itemsPath: 'x' })).statusCode).toBe(400);
    expect((await proxy(app, form, '/fields/code/check', { formVersionId: form.versionId, value: { a: 1 } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('T-LK-05: an id of another form, a disabled lookup and an unknown version are refused without a call', async () => {
    calls = [];
    const other = await publishForm(app, { title: 'Other form', blocks: [fieldBlock('emp', 'short_text')] });
    for (const id of ['off', 'nope', 'vendor']) expect((await lookup(app, form, 'maya', {}, id)).statusCode, id).toBe(404);
    expect((await lookup(app, form, 'maya', {}, 'off')).json()).toMatchObject({ code: 'REMOTE_NOT_FOUND' });
    expect((await proxy(app, form, '/fields/emp/options', { formVersionId: form.versionId })).statusCode).toBe(404);
    expect((await proxy(app, form, '/fields/emp/check', { formVersionId: form.versionId, value: 'x' })).statusCode).toBe(404);
    // Another form's lookup id: the other form has no lookups at all.
    expect((await lookup(app, other, 'maya')).statusCode).toBe(404);
    // Another form's version id, and a version that does not exist: never served from the wrong form.
    expect([404, 409]).toContain((await lookup(app, form, 'maya', { formVersionId: other.versionId })).statusCode);
    expect((await lookup(app, form, 'maya', { formVersionId: randomUUID() })).statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('T-LK-05: a previous version within the window uses ITS stored config; outside the window (or retired) it is 409', async () => {
    const v1 = await publishForm(app, { title: 'Versioned', lookups: [lookupDef({ url: `https://${UPSTREAM_HOST}/v1-people` })] });
    const draft = { ...draftWith(v1.id, [fieldBlock('emp', 'short_text'), fieldBlock('city_name', 'short_text'), fieldBlock('phone', 'short_text')], 'Versioned'), lookups: [lookupDef({ url: `https://${UPSTREAM_HOST}/v2-people` })] };
    expect((await api(app, user.owner, 'PUT', `/v1/forms/${v1.id}/draft`, { draft }, orgId, { 'if-match': '1' })).statusCode).toBe(200);
    const v2 = (await api(app, user.owner, 'POST', `/v1/forms/${v1.id}/publish`, {})).json<{ versionId: string }>().versionId;
    expect(v2).not.toBe(v1.versionId);
    calls = [];
    upstream = () => ({ status: 200, body: JSON.stringify(people(1)) });
    expect((await lookup(app, v1, 'maya', { formVersionId: v1.versionId })).statusCode).toBe(200);
    expect(calls[0]!.url).toContain('/v1-people');
    expect((await lookup(app, v1, 'mayb', { formVersionId: v2 })).statusCode).toBe(200);
    expect(calls[1]!.url).toContain('/v2-people');
    await owner.query(`update form_version_state set superseded_at = now() - interval '30 days' where version_id = $1`, [v1.versionId]);
    calls = [];
    const late = await lookup(app, v1, 'mayc', { formVersionId: v1.versionId });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'VERSION_SUPERSEDED' });
    expect(calls).toHaveLength(0);
  });

  it('T-LK-06: a closed form is 409; a password form is 401 without a token or with one for another version, and works with its own', async () => {
    const closed = await publishForm(app, { title: 'Closed', lookups: [lookupDef()] });
    const accessOf = (id: string) => api(app, user.owner, 'GET', `/v1/forms/${id}/access`);
    const etag = (await accessOf(closed.id)).headers['etag'] as string;
    const saved = await api(app, user.owner, 'PUT', `/v1/forms/${closed.id}/access`, { enabled: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 }, orgId, { 'if-match': etag });
    expect(saved.statusCode, saved.body).toBe(200);
    calls = [];
    const refused = await lookup(app, closed, 'maya');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'FORM_CLOSED' });

    const locked = await publishForm(app, { title: 'Locked', lookups: [lookupDef()] });
    expect((await api(app, user.owner, 'PUT', `/v1/forms/${locked.id}/access/password`, { password: 'violet-anchor-teapot-91' })).statusCode).toBe(200);
    expect((await lookup(app, locked, 'maya')).statusCode).toBe(401);
    expect((await lookup(app, locked, 'maya')).json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
    const token = (await app.inject({ method: 'POST', url: `/v1/p/${locked.slug}/unlock`, remoteAddress: address(), payload: { password: 'violet-anchor-teapot-91' } })).json<{ accessToken: string }>().accessToken;
    upstream = () => ({ status: 200, body: JSON.stringify(people(1)) });
    expect((await lookup(app, locked, 'maya', {}, 'hr', { 'x-fr-access': token })).statusCode).toBe(200);
    // A token is for one version: after a republish, the old token does not serve the new version.
    const draft = { ...draftWith(locked.id, [fieldBlock('emp', 'short_text'), fieldBlock('city_name', 'short_text'), fieldBlock('phone', 'short_text')], 'Locked'), lookups: [lookupDef()] };
    await api(app, user.owner, 'PUT', `/v1/forms/${locked.id}/draft`, { draft }, orgId, { 'if-match': '1' });
    const v2 = (await api(app, user.owner, 'POST', `/v1/forms/${locked.id}/publish`, {})).json<{ versionId: string }>().versionId;
    const wrong = await lookup(app, locked, 'maya', { formVersionId: v2 }, 'hr', { 'x-fr-access': token });
    expect(wrong.statusCode).toBe(401);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('every upstream failure is one fixed 502 that names nothing; the host and reason are logged, never the term or a row', async () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const logged = await startApp({ tenantHttp: stubHttp }, {}, undefined, sink);
    const f = await publishForm(logged, { title: 'Logged', lookups: [lookupDef({ credentialRef: { secretId } })] });
    const bodies = new Set<string>();
    for (const behaviour of [
      () => ({ status: 500, body: 'oops' }),
      () => ({ status: 200, body: 'not json at all' }),
      () => { throw new PortError('egress_denied', `${UPSTREAM_HOST} resolves to 10.0.0.1`); },
      () => { throw new PortError('unavailable', `${UPSTREAM_HOST} timed out`); },
    ] as const) {
      upstream = behaviour as never;
      const res = await lookup(logged, f, `${SENTINEL_Q}z${bodies.size}`);
      expect(res.statusCode).toBe(502);
      const { instance: _i, requestId: _r, ...fixed } = res.json<Record<string, unknown>>();
      bodies.add(JSON.stringify(fixed));
      expect(res.body).not.toMatch(/10\.0\.0\.1|resolves|timed out|oops|hr\.example/);
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]!)).toMatchObject({ code: 'REMOTE_UPSTREAM_FAILED' });
    // T-LK-11: a good call with a sentinel term and sentinel cells; nothing of them is in the log.
    upstream = () => ({ status: 200, body: JSON.stringify(people(2)) });
    await lookup(logged, f, `${SENTINEL_Q}ok`);
    const log = lines.join('');
    expect(log).toContain('remote upstream failed');
    for (const leak of [SENTINEL_Q, SENTINEL_CELL, SECRET_TOKEN, 'SENTINEL-PATH', SENTINEL_PARAM]) expect(log, leak).not.toContain(leak);
  });

  it('T-LK-04: the ip, form and form-wide budgets give 429 with Retry-After, and an exhausted lookup budget never blocks a submit', async () => {
    const window = await throttleWindowSeconds(owner);
    const limited = await startApp({ tenantHttp: stubHttp }, {}, { auth_remote_ip: { max: 4, windowSeconds: window }, auth_remote_form: { max: 3, windowSeconds: window }, auth_remote_formall: { max: 5, windowSeconds: window } });
    const f = await publishForm(limited, { title: 'Limited', lookups: [lookupDef()] });
    upstream = () => ({ status: 200, body: JSON.stringify(people(1)) });
    const ip = address();
    for (let i = 0; i < 3; i++) expect((await lookup(limited, f, `ma${i}`, {}, 'hr', {}, ip)).statusCode).toBe(200);
    const perForm = await lookup(limited, f, 'maz', {}, 'hr', {}, ip);
    expect(perForm.statusCode).toBe(429);
    expect(Number(perForm.headers['retry-after'])).toBeGreaterThan(0);
    // Another address: its own per-form budget, but the whole form has 5 in all (3 spent above, the refused one counted too).
    const ip2 = address();
    expect((await lookup(limited, f, 'mb1', {}, 'hr', {}, ip2)).statusCode).toBe(200);
    const formAll = await lookup(limited, f, 'mb2', {}, 'hr', {}, ip2);
    expect([200, 429]).toContain(formAll.statusCode);
    const ip3 = address();
    let last = 200;
    for (let i = 0; i < 4 && last === 200; i++) last = (await lookup(limited, f, `mc${i}`, {}, 'hr', {}, ip3)).statusCode;
    expect(last).toBe(429);
    // The submit buckets are separate: this address can still submit.
    const submitted = await limited.inject({ method: 'POST', url: `/v1/p/${f.slug}/submissions`, remoteAddress: ip, headers: { 'idempotency-key': randomUUID() }, payload: { formVersionId: f.versionId, answers: {}, fields: [], locale: 'en-IN' } });
    expect(submitted.statusCode, submitted.body).toBe(200);
  });

  it('REMOTE_BUSY: a fifth upstream call in flight for one form is 503 with Retry-After: 1', async () => {
    const f = await publishForm(app, { title: 'Busy', lookups: [lookupDef()] });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    upstream = async () => { await gate; return { status: 200, body: JSON.stringify(people(1)) }; };
    calls = [];
    const inFlight = [1, 2, 3, 4].map((i) => lookup(app, f, `busy${i}`));
    while (calls.length < 4) await new Promise((r) => setTimeout(r, 10));
    const fifth = await lookup(app, f, 'busy5');
    expect(fifth.statusCode).toBe(503);
    expect(fifth.headers['retry-after']).toBe('1');
    expect(fifth.json()).toMatchObject({ code: 'REMOTE_BUSY' });
    release();
    expect((await Promise.all(inFlight)).map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
  });

  it('answers 503 REMOTE_UNAVAILABLE when the deployment has no egress, after the target is found', async () => {
    const bare = await startApp({});
    const f = await publishForm(bare, { title: 'Bare', lookups: [lookupDef()] });
    expect((await lookup(bare, f, 'maya')).json()).toMatchObject({ code: 'REMOTE_UNAVAILABLE' });
    expect((await lookup(bare, f, 'maya', {}, 'nope')).statusCode).toBe(404);
  });
});

describe('credentials: host binding, https and org isolation (T-LK-08, T-LK-09)', () => {
  it('T-LK-08: a credential bound to another host is never sent, and the upstream is never called', async () => {
    const bound = await credential(app, 'bound.example.test');
    const f = await publishForm(app, { title: 'Mismatch', lookups: [lookupDef({ credentialRef: { secretId: bound } })] });
    calls = [];
    const res = await lookup(app, f, 'maya');
    expect(res.statusCode).toBe(502);
    expect(calls).toHaveLength(0);
    // The same credential to its own host is sent.
    const ok = await publishForm(app, { title: 'Match', lookups: [lookupDef({ url: 'https://bound.example.test/people', credentialRef: { secretId: bound } })] });
    upstream = () => ({ status: 200, body: JSON.stringify(people(1)) });
    expect((await lookup(app, ok, 'maya')).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    // Even a different port is a different host.
    const port = await publishForm(app, { title: 'Port', lookups: [lookupDef({ url: 'https://bound.example.test:8443/people', credentialRef: { secretId: bound } })] });
    calls = [];
    expect((await lookup(app, port, 'maya')).statusCode).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it('T-LK-08: a credential on an http: URL is refused at publish (credential_needs_https)', async () => {
    const id = await credential(app, 'plain.example.test');
    const created = await api(app, user.owner, 'POST', '/v1/forms', { title: 'Plain' });
    const formId = created.json<{ id: string }>().id;
    const draft = { ...draftWith(formId, [fieldBlock('emp', 'short_text')], 'Plain'), lookups: [lookupDef({ url: 'http://plain.example.test/people', credentialRef: { secretId: id }, mappings: [] })] };
    expect((await api(app, user.owner, 'PUT', `/v1/forms/${formId}/draft`, { draft }, orgId, { 'if-match': '0' })).statusCode).toBe(200);
    const res = await api(app, user.owner, 'POST', `/v1/forms/${formId}/publish`, {});
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('credential_needs_https');
  });

  it('T-LK-09: another org\'s credential is credential_missing at publish, and 502 with no header at runtime when forced into the database', async () => {
    const theirs = await credential(app, UPSTREAM_HOST, 'other-org-token-abcdef', user.otherOwner, otherOrgId);
    const created = await api(app, user.owner, 'POST', '/v1/forms', { title: 'Cross org' });
    const formId = created.json<{ id: string }>().id;
    const blocks = [fieldBlock('emp', 'short_text'), fieldBlock('city_name', 'short_text'), fieldBlock('phone', 'short_text')];
    const draft = { ...draftWith(formId, blocks, 'Cross org'), lookups: [lookupDef({ credentialRef: { secretId: theirs } })] };
    expect((await api(app, user.owner, 'PUT', `/v1/forms/${formId}/draft`, { draft }, orgId, { 'if-match': '0' })).statusCode).toBe(200);
    const refused = await api(app, user.owner, 'POST', `/v1/forms/${formId}/publish`, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain('credential_missing');
    // Forced in: publish a clean version, then point its stored lookup at the other org's credential.
    const clean = await publishForm(app, { title: 'Forced', lookups: [lookupDef()] });
    // A published version is immutable (a trigger refuses the UPDATE), so a superuser session in replica mode does it.
    const adminUrl = new URL(inject('pgAdminUrl'));
    adminUrl.pathname = `/${database}`;
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`set session_replication_role = replica`);
      await admin.query(`update form_versions set definition = jsonb_set(definition, '{lookups,0,credentialRef}', $2::jsonb) where id = $1`, [clean.versionId, JSON.stringify({ secretId: theirs })]);
    } finally {
      await admin.end();
    }
    const fresh = await startApp({ tenantHttp: stubHttp });
    calls = [];
    const res = await lookup(fresh, clean, 'maya');
    expect(res.statusCode).toBe(502);
    expect(calls).toHaveLength(0);
    expect(res.body).not.toContain('other-org-token');
  });
});

describe('the author route and the SSRF guard (T-LK-02, T-LK-13)', () => {
  const author = (a: FastifyInstance, who: string, formId: string, body: unknown, org = orgId) => api(a, who, 'POST', `/v1/forms/${formId}/remote/test`, body, org);
  let formId: string;
  beforeAll(async () => {
    formId = (await publishForm(app, { title: 'Author' })).id;
  });

  it('forms.edit gets the parsed answer cut to 50 entries per array and 256 KiB; a viewer is refused; another org\'s form is a 404', async () => {
    upstream = () => ({ status: 200, body: JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'x'.repeat(2000) })) }) });
    const res = await author(app, user.editor, formId, { request: { url: 'https://hr.example.test/x', method: 'GET' } });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(256 * 1024 + 2048);
    const body = res.json<{ status: number; data: { items: unknown[] }; truncated: boolean }>();
    expect(body.status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.data.items.length).toBeLessThanOrEqual(50);
    expect((await author(app, user.viewer, formId, { request: { url: 'https://hr.example.test/x' } })).statusCode).toBe(403);
    expect((await author(app, user.otherOwner, formId, { request: { url: 'https://hr.example.test/x' } }, otherOrgId)).statusCode).toBe(404);
    expect((await author(app, user.editor, formId, { request: { url: 'https://hr.example.test/x' }, extra: 1 })).statusCode).toBe(400);
  });

  it('sends the search term under searchParam and the credential to its host only, and shows an upstream failure as the fixed 502', async () => {
    const id = await credential(app, 'author.example.test');
    upstream = () => ({ status: 200, body: '{"ok":true}' });
    calls = [];
    const res = await author(app, user.editor, formId, { request: { url: 'https://author.example.test/p', method: 'GET', searchParam: 'term', credentialRef: { secretId: id } }, q: 'asha' });
    expect(res.statusCode).toBe(200);
    expect(new URL(calls[0]!.url).searchParams.get('term')).toBe('asha');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    calls = [];
    expect((await author(app, user.editor, formId, { request: { url: 'https://elsewhere.example.test/p', method: 'GET', credentialRef: { secretId: id } } })).statusCode).toBe(502);
    expect(calls).toHaveLength(0);
    upstream = () => ({ status: 500, body: 'boom' });
    const failed = await author(app, user.editor, formId, { request: { url: 'https://hr.example.test/x' } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: 'REMOTE_UPSTREAM_FAILED' });
  });

  it('counts calls per user (auth_remote_test) and answers 429 with Retry-After', async () => {
    const window = await throttleWindowSeconds(owner);
    const limited = await startApp({ tenantHttp: stubHttp }, {}, { auth_remote_test: { max: 3, windowSeconds: window } });
    upstream = () => ({ status: 200, body: '{}' });
    for (let i = 0; i < 3; i++) expect((await author(limited, user.editor, formId, { request: { url: 'https://hr.example.test/x' } })).statusCode).toBe(200);
    const over = await author(limited, user.editor, formId, { request: { url: 'https://hr.example.test/x' } });
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await author(limited, user.owner, formId, { request: { url: 'https://hr.example.test/x' } })).statusCode).toBe(200);
  });

  describe('through the real tenant egress guard', () => {
    const DNS: Record<string, string> = { 'rebind.example.test': '10.0.0.7', 'public.example.test': '93.184.216.34', 'mapped.example.test': '::ffff:127.0.0.1' };
    const resolver: EgressResolver = async (host) => {
      const address = DNS[host];
      if (!address) throw new Error(`ENOTFOUND ${host}`);
      return [{ address, family: address.includes(':') ? 6 : 4 }];
    };
    let guarded: FastifyInstance;
    let tripwire: ReturnType<typeof installEgressTripwire>;
    beforeAll(async () => {
      const edition = parseEditionConfig({ DEPLOYMENT_MODE: 'saas' });
      if (!edition.ok) throw new Error(edition.errors.join('\n'));
      const tenantEgress = createTenantEgressGuard(edition.config, resolver);
      guarded = await startApp({ tenantEgress, tenantHttp: (url, r) => egressHttp(tenantEgress, url, r) }, { DEPLOYMENT_MODE: 'saas' });
      tripwire = installEgressTripwire();
    });
    afterAll(() => tripwire?.uninstall());

    const targets = ['http://127.0.0.1/x', 'http://127.0.0.1:55491/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::1]/x', 'https://rebind.example.test/x', 'https://mapped.example.test/x', 'https://nxdomain.example.test/x'];

    it('T-LK-02: every private target gives the same fixed 502 on the author route, and nothing is connected to', async () => {
      const bodies = new Set<string>();
      for (const url of targets) {
        const res = await author(guarded, user.editor, formId, { request: { url, method: 'GET' } });
        // Either the schema refuses the address outright (400) or the egress guard does (the one fixed 502).
        expect([400, 502], url).toContain(res.statusCode);
        if (res.statusCode === 502) {
          const { instance: _i, requestId: _r, ...fixed } = res.json<Record<string, unknown>>();
          bodies.add(JSON.stringify(fixed));
        }
      }
      expect(bodies.size).toBe(1);
      expect(tripwire.connections.filter((c) => !c.startsWith('127.0.0.1:') && !c.startsWith('localhost:') && !c.startsWith('unix:'))).toEqual([]);
      expect(tripwire.connections.filter((c) => /10\.0\.0\.|169\.254|:55491$/.test(c) && !/55491$/.test(c))).toEqual([]);
    });

    it('T-LK-02: the same on the public proxy, for a stored lookup', async () => {
      const results = new Set<string>();
      for (const url of ['http://127.0.0.1:1/x', 'https://169.254.169.254/x', 'https://rebind.example.test/x']) {
        const f = await publishForm(guarded, { title: `Ssrf ${url.length}`, lookups: [lookupDef({ url })] });
        const res = await lookup(guarded, f, 'maya');
        expect(res.statusCode, url).toBe(502);
        const { instance: _i, requestId: _r, ...fixed } = res.json<Record<string, unknown>>();
        results.add(JSON.stringify(fixed));
        expect(res.body).not.toMatch(/10\.0\.0\.7|169\.254|127\.0\.0\.1|rebind/);
      }
      expect(results.size).toBe(1);
    });
  });
});

describe('caps against a real server (T-LK-14)', () => {
  let server: Server;
  let base: string;
  let mode: 'big' | 'hang' | 'drip' | 'xml' | 'ok' = 'ok';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (mode === 'hang') return; // never answers: the 5 s limit must cut it off
      if (mode === 'xml') {
        // About 1 MiB of repeated siblings: the parser must stay linear on the API's event loop (review blocker).
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<r>${'<a>1</a>'.repeat(130_000)}</r>`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'drip') {
        // One byte every 2 s: never idle for 5 s, never over 1 MiB. The 5 s is a total deadline, so it still ends.
        const timer = setInterval(() => res.write(' '), 2000);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (mode === 'big') res.end(JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }));
      else res.end(JSON.stringify({ data: [{ name: 'Maya Rao' }] }));
      void req;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('a body over 1 MiB and an answer slower than 5 s are both the fixed 502', async () => {
    // Plain sendHttp (no guard): the caps are the transport's, which is what this checks; the guard is checked above.
    const direct = await startApp({ tenantHttp: (url, r) => sendHttp(url, { method: r.method, headers: r.headers, ...(r.body !== undefined ? { body: r.body } : {}), timeoutMs: r.timeoutMs, maxResponseBytes: r.maxResponseBytes }) });
    const f = await publishForm(direct, { title: 'Caps', lookups: [lookupDef({ url: `${base}/people`, itemsPath: 'data', searchParam: undefined as never })] });
    mode = 'ok';
    expect((await lookup(direct, f, 'maya')).statusCode).toBe(200);
    mode = 'big';
    expect((await lookup(direct, f, 'mayb')).statusCode).toBe(502);
    mode = 'hang';
    const started = Date.now();
    const slow = await lookup(direct, f, 'mayc');
    expect(slow.statusCode).toBe(502);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    mode = 'drip';
    const dripStarted = Date.now();
    expect((await lookup(direct, f, 'mayd')).statusCode).toBe(502);
    expect(Date.now() - dripStarted).toBeLessThan(9000);
  }, 40_000);

  it('1 MiB of XML siblings answers 502 or 200 within about a second (the event loop is never held)', async () => {
    const direct = await startApp({ tenantHttp: (url, r) => sendHttp(url, { method: r.method, headers: r.headers, ...(r.body !== undefined ? { body: r.body } : {}), timeoutMs: r.timeoutMs, maxResponseBytes: r.maxResponseBytes }) });
    const f = await publishForm(direct, { title: 'Xml', lookups: [lookupDef({ url: `${base}/people`, itemsPath: 'a', parser: 'xml', searchParam: undefined as never })] });
    mode = 'xml';
    const started = Date.now();
    expect([200, 502]).toContain((await lookup(direct, f, 'maye')).statusCode);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 30_000);
});
