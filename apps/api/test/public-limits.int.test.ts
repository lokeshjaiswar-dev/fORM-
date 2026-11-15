import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const ADDRESS_A = '203.0.113.10';
const ADDRESS_B = '203.0.113.11';

let app: FastifyInstance;
let owner: pg.Pool;
let dir: string;
let orgId: string;
let userId: string;

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });
const text = (value: string) => ({ type: 'short_text', value });

async function publish(title: string): Promise<{ id: string; slug: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const blocks = [fieldBlock('comment', 'short_text'), fieldBlock('doc', 'file_upload', { accept: { extensions: ['txt'], mimeTypes: ['text/plain'] } })];
  expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft: draftWith(id, blocks, title) } })).statusCode).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

const upload = (slug: string, remoteAddress = ADDRESS_A) =>
  app.inject({ method: 'POST', url: `/v1/p/${slug}/files`, remoteAddress, payload: { blockId: 'doc', name: 'n.txt', mime: 'text/plain', data: Buffer.from('notes').toString('base64') } });

const submit = (slug: string, versionId: string, remoteAddress = ADDRESS_A) =>
  app.inject({
    method: 'POST',
    url: `/v1/p/${slug}/submissions`,
    remoteAddress,
    headers: { 'idempotency-key': randomUUID() },
    payload: { formVersionId: versionId, answers: { comment: text('hi') }, fields: [], locale: 'en-IN' },
  });

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_limits');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-limits-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'limits']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@limits.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    // Small budgets, so a test spends them: three uploads or two submissions per address and form, six or five per address.
    authLimits: {
      auth_files_ip: { max: 6, windowSeconds: 600 },
      auth_files_form: { max: 3, windowSeconds: 600 },
      auth_submit_ip: { max: 5, windowSeconds: 600 },
      auth_submit_form: { max: 2, windowSeconds: 600 },
    },
  });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

describe('rate limits on the anonymous writes of respondents', () => {
  it('limits uploads per address and form, then per address over every form, with 429 problem+json and Retry-After', async () => {
    const a = await publish('Limits files A');
    const b = await publish('Limits files B');
    for (let i = 0; i < 3; i++) expect((await upload(a.slug)).statusCode, `upload ${i}`).toBe(200);
    const refused = await upload(a.slug);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // The same address on another form still has that form's budget (its address budget has 2 left of 6: the refused one counted).
    expect((await upload(b.slug)).statusCode).toBe(200);
    expect((await upload(b.slug)).statusCode).toBe(200);
    expect((await upload(b.slug)).statusCode).toBe(429);
    // Another address is not affected by either.
    expect((await upload(a.slug, ADDRESS_B)).statusCode).toBe(200);
  });

  it('limits submissions the same way, per address and form and per address overall', async () => {
    const a = await publish('Limits submit A');
    const b = await publish('Limits submit B');
    for (let i = 0; i < 2; i++) expect((await submit(a.slug, a.versionId)).statusCode, `submission ${i}`).toBe(200);
    const refused = await submit(a.slug, a.versionId);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await submit(b.slug, b.versionId)).statusCode).toBe(200);
    // Five requests from this address so far (one refused): the sixth is over the address budget, on any form.
    expect((await submit(b.slug, b.versionId)).statusCode).toBe(200);
    expect((await submit(b.slug, b.versionId)).statusCode).toBe(429);
    expect((await submit(a.slug, a.versionId, ADDRESS_B)).statusCode).toBe(200);
    // Nothing refused was stored.
    const { rows } = await owner.query<{ n: number }>('select count(*)::int as n from submissions where form_id = any ($1)', [[a.id, b.id]]);
    expect(rows[0]!.n).toBe(5);
  });

  it('refuses before reading the body: a throttled upload is a 429 whatever it carries, and keeps nothing', async () => {
    const f = await publish('Limits body');
    const before = (await readdir(dir)).length;
    for (let i = 0; i < 3; i++) await upload(f.slug, '203.0.113.50');
    const big = `{"blockId":"doc","name":"a.txt","mime":"text/plain","data":"${'A'.repeat(1024 * 1024)}`;
    const res = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/files`, remoteAddress: '203.0.113.50', headers: { 'content-type': 'application/json' }, payload: big });
    expect(res.statusCode).toBe(429);
    expect((await readdir(dir)).length).toBe(before + 3);
  });

  it('counts the address as a keyed hash: the audit record of the first refusal holds no address', async () => {
    const f = await publish('Limits audit');
    for (let i = 0; i < 4; i++) await upload(f.slug, '203.0.113.77');
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where event->>'action' = 'auth.throttled' and event->>'reason' = 'auth_files_form'`);
    expect(rows.length).toBeGreaterThan(0);
    const mine = rows.map((r) => r.event).filter((e) => e['resourceId'] === 'POST /v1/p/:slug/files');
    expect(mine.length).toBeGreaterThan(0);
    expect(String(mine[0]!['actorIpHash'])).toMatch(/^[0-9a-f]{32}$/);
    const keys = await owner.query<{ key: Buffer }>(`select key from auth_throttle where bucket like 'auth\\_files\\_%'`);
    expect(keys.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify([rows, keys.rows.map((r) => r.key.toString('hex'))])).not.toContain('203.0.113.77');
  });

  it('answers an unknown form with 404 before reading the body, and counts the probe against the address', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/p/no-such-form/submissions', remoteAddress: '203.0.113.99', payload: { formVersionId: randomUUID(), answers: {} } });
    expect(res.statusCode).toBe(404);
    const { rows } = await owner.query<{ n: number }>(`select count(*)::int as n from auth_throttle where bucket = 'auth_submit_ip'`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});
