import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PLATFORM_ORG_KEY, provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig, type ApiConfig } from '../src/config.ts';
import { ACCESS_TOKEN_TTL_SECONDS, verifyAccessToken } from '../src/runtime/access-token.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { publishableDraft } from './publishable-draft.ts';

/*
 * `POST /v1/p/:slug/unlock` (WP-1.07, ACC-05): the respondent's password check for a protected form. The route is public
 * (a respondent has no account), so what a stranger with `curl` can do is what this file pins down: guess, and be
 * counted, refused and written down, without the answer saying which forms are protected.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const PASSWORD = 'violet-anchor-teapot-91';
/** A small budget, so a test can spend it: five tries per address and form. */
const BUDGET = 5;
/** And ten per address over every form, so two forms spend it and a third has none left. */
const IP_BUDGET = 10;

let app: FastifyInstance;
let config: ApiConfig;
let owner: pg.Pool;
let orgId: string;
let userId: string;
let protectedForm: Form;
let openForm: Form;
let nextAddress = 1;
const seen: Array<{ route: string; status: number; body: string }> = [];

interface Form {
  id: string;
  slug: string;
  versionId: string;
}

/** An address of its own for each test, so the budgets of two tests never meet. */
const address = () => `203.0.113.${nextAddress++}`;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_unlock');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'unlock']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@unlock.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    AUTH_SECRET: Buffer.alloc(32, 5).toString('base64url'),
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  config = parsed.config;
  app = await buildApp(config, { underPressure: false, authLimits: { auth_unlock_form: { max: BUDGET, windowSeconds: 600 }, auth_unlock_ip: { max: IP_BUDGET, windowSeconds: 600 } } });
  protectedForm = await publish('Protected form');
  openForm = await publish('Open form');
  const set = await member('PUT', `/v1/forms/${protectedForm.id}/access/password`, { password: PASSWORD });
  expect(set.statusCode, set.body).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

function member(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) {
  return app.inject({ method, url, headers: { 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
}

async function publish(title: string): Promise<Form> {
  const { id } = (await member('POST', '/v1/forms', { title })).json<{ id: string }>();
  expect((await member('PUT', `/v1/forms/${id}/draft`, { draft: publishableDraft(id, title) })).statusCode).toBe(200);
  const live = await member('POST', `/v1/forms/${id}/publish`, {});
  expect(live.statusCode).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

/** The respondent's request: no session, no org, only an address. Every response is kept for the scan at the end. */
async function unlock(slug: string, body: unknown, ip: string) {
  const res = await app.inject({ method: 'POST', url: `/v1/p/${slug}/unlock`, remoteAddress: ip, payload: body as Record<string, unknown> });
  seen.push({ route: 'POST /v1/p/:slug/unlock', status: res.statusCode, body: res.body });
  return res;
}

/** The refusals of the form that are on the record, oldest first (the chain worker does not run in these tests). */
async function failures(formId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `select event from audit_pending where org_key = $1 and event->>'action' = 'form.unlock_failed' and event->>'formId' = $2 order by id`,
    [orgId, formId],
  );
  return rows.map((r) => r.event);
}

/** What a caller can tell of an answer apart from the request it asked about. */
const shape = (res: { json: () => Record<string, unknown> }) => {
  const { instance: _instance, requestId: _requestId, ...rest } = res.json();
  return rest;
};

describe('a wrong password', () => {
  it('is a generic 401 and leaves an audit record with the keyed address hash and nothing else about the caller', async () => {
    const ip = address();
    const res = await unlock(protectedForm.slug, { password: 'violet-anchor-teapot-92' }, ip);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'FORM_UNLOCK_FAILED', status: 401, title: 'The password is not right', detail: 'That password is not right.' });
    expect(Object.keys(res.json())).not.toContain('errors');
    expect(res.headers['cache-control']).toBe('no-store');

    const events = await failures(protectedForm.id);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      actorKind: 'respondent',
      action: 'form.unlock_failed',
      resourceType: 'form',
      resourceId: protectedForm.id,
      formId: protectedForm.id,
      outcome: 'denied',
      reason: 'wrong_password',
      requestId: res.headers['x-request-id'],
    });
    // The address hash is hex and is not the address; there is no user, session, user agent, password or hash.
    expect(event['actorIpHash']).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(event)).not.toContain(ip);
    for (const key of ['actorId', 'sessionId', 'actorUa', 'metadata']) expect(Object.keys(event), key).not.toContain(key);
    expect(JSON.stringify(event)).not.toContain('violet-anchor');
    expect(JSON.stringify(event)).not.toMatch(/argon2/);
  });

  it('is told apart by nothing in the answer from a form that has no password at all', async () => {
    const wrong = await unlock(protectedForm.slug, { password: 'not the password' }, address());
    const none = await unlock(openForm.slug, { password: 'not the password' }, address());
    expect(none.statusCode).toBe(wrong.statusCode);
    expect(shape(none)).toEqual(shape(wrong));
    // Both are on the record, and only the record knows which it was.
    expect((await failures(openForm.id)).at(-1)).toMatchObject({ reason: 'no_password', outcome: 'denied' });
  });

  it('costs the same argon2id work for a form with a password and for one without', async () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const time = async (slug: string) => {
      const started = performance.now();
      await unlock(slug, { password: 'a guess that is wrong' }, address());
      return performance.now() - started;
    };
    await time(openForm.slug);
    const protectedTimes: number[] = [];
    const openTimes: number[] = [];
    for (let i = 0; i < 4; i++) {
      protectedTimes.push(await time(protectedForm.slug));
      openTimes.push(await time(openForm.slug));
    }
    // If the form without a password skipped the hash check it would answer in a few milliseconds, a tenth of this.
    expect(median(openTimes) / median(protectedTimes)).toBeGreaterThan(0.5);
  });
});

describe('the right password', () => {
  it('returns an access token for the live version, good for two hours, and writes no refusal', async () => {
    const before = (await failures(protectedForm.id)).length;
    const started = Date.now();
    const res = await unlock(protectedForm.slug, { password: PASSWORD }, address());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { accessToken, expiresAt } = res.json<{ accessToken: string; expiresAt: string }>();
    expect(Object.keys(res.json()).sort()).toEqual(['accessToken', 'expiresAt']);
    expect(Math.abs(new Date(expiresAt).getTime() - (started + ACCESS_TOKEN_TTL_SECONDS * 1000))).toBeLessThan(10_000);

    const scope = { formId: protectedForm.id, versionScope: protectedForm.versionId };
    const claims = verifyAccessToken(config.auth.secret, accessToken, scope, new Date());
    expect(claims).toMatchObject({ formId: protectedForm.id, versionScope: protectedForm.versionId });
    // Not for another form, not after its two hours, not under another secret.
    expect(verifyAccessToken(config.auth.secret, accessToken, { ...scope, formId: openForm.id }, new Date())).toBeNull();
    expect(verifyAccessToken(config.auth.secret, accessToken, scope, new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1000))).toBeNull();
    expect(verifyAccessToken(new Uint8Array(32).fill(1), accessToken, scope, new Date())).toBeNull();
    expect((await failures(protectedForm.id)).length).toBe(before);
  });

  it('is good for the version that was live, not for the next one: a new publish asks the respondent again', async () => {
    const form = await publish('Republished form');
    expect((await member('PUT', `/v1/forms/${form.id}/access/password`, { password: PASSWORD })).statusCode).toBe(200);
    const first = (await unlock(form.slug, { password: PASSWORD }, address())).json<{ accessToken: string }>().accessToken;
    const republished = await member('POST', `/v1/forms/${form.id}/publish`, {});
    const next = republished.json<{ versionId: string; slug: string }>();
    expect(next.versionId).not.toBe(form.versionId);
    expect(verifyAccessToken(config.auth.secret, first, { formId: form.id, versionScope: form.versionId }, new Date())).not.toBeNull();
    expect(verifyAccessToken(config.auth.secret, first, { formId: form.id, versionScope: next.versionId }, new Date())).toBeNull();
    const second = (await unlock(form.slug, { password: PASSWORD }, address())).json<{ accessToken: string }>().accessToken;
    expect(verifyAccessToken(config.auth.secret, second, { formId: form.id, versionScope: next.versionId }, new Date())).not.toBeNull();
  });

  it('follows a change of password: the old one stops working at once', async () => {
    const form = await publish('Rotated password form');
    await member('PUT', `/v1/forms/${form.id}/access/password`, { password: PASSWORD });
    expect((await unlock(form.slug, { password: PASSWORD }, address())).statusCode).toBe(200);
    await member('PUT', `/v1/forms/${form.id}/access/password`, { password: 'a different passphrase 42' });
    expect((await unlock(form.slug, { password: PASSWORD }, address())).statusCode).toBe(401);
    expect((await unlock(form.slug, { password: 'a different passphrase 42' }, address())).statusCode).toBe(200);
  });

  it('opens with the old slug of a form whose address was changed', async () => {
    const form = await publish('Moved form');
    await member('PUT', `/v1/forms/${form.id}/access/password`, { password: PASSWORD });
    expect((await member('PUT', `/v1/forms/${form.id}/slug`, { slug: 'moved-form-new-address' })).statusCode).toBe(200);
    expect((await unlock(form.slug, { password: PASSWORD }, address())).statusCode).toBe(200);
    expect((await unlock('moved-form-new-address', { password: PASSWORD }, address())).statusCode).toBe(200);
  });
});

describe('the throttle', () => {
  it('counts every attempt per address and form, then answers 429 with Retry-After, even for the right password', async () => {
    const ip = address();
    const before = (await failures(protectedForm.id)).length;
    for (let i = 0; i < BUDGET; i++) expect((await unlock(protectedForm.slug, { password: `guess number ${i} here` }, ip)).statusCode, `attempt ${i}`).toBe(401);
    const over = await unlock(protectedForm.slug, { password: 'guess number six here' }, ip);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // The budget is spent, so the right password is refused too until the window ends.
    const right = await unlock(protectedForm.slug, { password: PASSWORD }, ip);
    expect(right.statusCode).toBe(429);
    expect(right.body).not.toContain('accessToken');

    // Only the attempts that were made are on the record as refused passwords; the first one over the limit is on it once.
    expect((await failures(protectedForm.id)).length - before).toBe(BUDGET);
    const { rows } = await owner.query<{ n: number }>(
      `select count(*)::int as n from audit_pending where org_key = $1 and event->>'action' = 'auth.throttled' and event->>'reason' = 'auth_unlock_form' and event->>'actorIpHash' is not null`,
      [PLATFORM_ORG_KEY],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);

    // Another address has its own budget, and so does another form of the same address.
    expect((await unlock(protectedForm.slug, { password: PASSWORD }, address())).statusCode).toBe(200);
    expect((await unlock(openForm.slug, { password: 'a guess that is wrong' }, ip)).statusCode).toBe(401);
  });

  it('also counts every attempt per address over all forms, so a form the address never tried is refused once it has spent its budget elsewhere', async () => {
    // Each form's own budget is five; the address's is ten. Two forms take all ten and neither is over its own limit.
    const third = await publish('Third form');
    expect((await member('PUT', `/v1/forms/${third.id}/access/password`, { password: PASSWORD })).statusCode).toBe(200);
    const ip = address();
    const before = (await failures(third.id)).length;
    for (const form of [protectedForm, openForm]) {
      for (let i = 0; i < BUDGET; i++) expect((await unlock(form.slug, { password: `guess ${i} at ${form.slug}` }, ip)).statusCode, `${form.slug} attempt ${i}`).toBe(401);
    }
    expect(BUDGET * 2).toBe(IP_BUDGET);

    // The third form has had no attempt from this address, and is refused all the same, before any password is checked
    // (so it writes no refusal of a password): the right password does not get through either.
    const over = await unlock(third.slug, { password: PASSWORD }, ip);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(over.body).not.toContain('accessToken');
    expect((await failures(third.id)).length).toBe(before);

    // The refusal is on the record once, under the per-address bucket, with the keyed address hash and not the address.
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(
      `select event from audit_pending where org_key = $1 and event->>'action' = 'auth.throttled' and event->>'reason' = 'auth_unlock_ip'`,
      [PLATFORM_ORG_KEY],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.event)).not.toContain(ip);

    // Another address is not affected by it.
    expect((await unlock(third.slug, { password: PASSWORD }, address())).statusCode).toBe(200);
  });
});

describe('what is refused before any password is checked', () => {
  it('answers 404 for a slug that is not published, and for a form that is archived or trashed', async () => {
    const ip = address();
    expect((await unlock('no-such-form-anywhere', { password: PASSWORD }, ip)).statusCode).toBe(404);
    const archived = await publish('Archived form');
    await member('PUT', `/v1/forms/${archived.id}/access/password`, { password: PASSWORD });
    await owner.query(`update forms set lifecycle = 'archived' where id = $1`, [archived.id]);
    expect((await unlock(archived.slug, { password: PASSWORD }, ip)).statusCode).toBe(404);
    await owner.query(`update forms set lifecycle = 'trashed' where id = $1`, [archived.id]);
    expect((await unlock(archived.slug, { password: PASSWORD }, ip)).statusCode).toBe(404);
    expect(await failures(archived.id)).toEqual([]);
  });

  it('answers 400 for a body that is not exactly a password, and counts none of it', async () => {
    const ip = address();
    const before = (await failures(protectedForm.id)).length;
    for (const body of [{}, { password: '' }, { password: 42 }, { password: 'x'.repeat(513) }, { password: PASSWORD, formId: openForm.id }, { pass: PASSWORD }, []]) {
      const res = await unlock(protectedForm.slug, body, ip);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await failures(protectedForm.id)).length).toBe(before);
    // The budget was not touched: the full budget of wrong guesses is still available to this address.
    for (let i = 0; i < BUDGET; i++) expect((await unlock(protectedForm.slug, { password: `guess ${i} after the junk` }, ip)).statusCode).toBe(401);
  });

  it('takes the org from the slug and nothing from the caller: a session and an org header change nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/p/${protectedForm.slug}/unlock`,
      remoteAddress: address(),
      headers: { 'x-fr-dev-user': randomUUID(), 'x-fr-org': randomUUID() },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('responses of the unlock route', () => {
  it('never carry password_hash, an argon2 string, or a password that was sent', async () => {
    expect(seen.length).toBeGreaterThan(30);
    expect(new Set(seen.map((s) => s.status))).toEqual(new Set([200, 400, 401, 404, 429]));
    const stored = (await owner.query<{ password_hash: string }>('select password_hash from form_access where password_hash is not null')).rows.map((r) => r.password_hash);
    expect(stored.length).toBeGreaterThan(2);
    const leaks = seen.filter(
      (s) => /password_hash|passwordHash|argon2/i.test(s.body) || stored.some((hash) => s.body.includes(hash)) || s.body.includes('violet-anchor') || s.body.includes('a different passphrase'),
    );
    expect(leaks.map((s) => `${s.route} ${s.status}`)).toEqual([]);
  });
});
