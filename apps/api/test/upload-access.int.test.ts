import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * `POST /v1/p/:slug/files` takes the form's status (WP-1.07 ACC-01..06, WP-1.12). The upload route used to check only that
 * the slug resolves to a live version, so a form that was switched off, closed, full or behind its password still took
 * files from anyone with `curl` and its address. It now asks the question a submission asks (`readAccess`, `isUnlocked`,
 * `runtimeStatus`, `assertOpen`) before the body is read, and these tests hold the two routes to the same answers: each
 * case below is sent to the upload route and to the submit route, and both must refuse with the same status and code.
 *
 * The app's clock is frozen per test (`clock`), so the open and close dates, the weekly window and the password
 * rotation are decided by the moment the test names and never by how long the run took.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PASSWORD = 'violet-anchor-teapot-91';
const HOUR = 3_600_000;
/** More than any test sends from one address, so no throttle speaks here. */
const BUDGET = { max: 100_000, windowSeconds: 600 };

let app: FastifyInstance;
let owner: pg.Pool;
let dir: string;
let orgId: string;
let userId: string;
/** The moment the app believes it is: the real time at the start of the test, then whatever the test sets. */
let clock = new Date();

const as = () => ({ 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER });

interface Form {
  id: string;
  slug: string;
  versionId: string;
}

async function publish(title: string): Promise<Form> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(), payload: { title } })).json<{ id: string }>();
  const fields = [fieldBlock('name', 'short_text', {}, { required: true }), fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } })];
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(), 'if-match': '0' }, payload: { draft: draftWith(id, fields, title) } });
  expect(put.statusCode, put.body).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return { id, ...live.json<{ slug: string; versionId: string }>() };
}

/** Saves the form's access settings (the ones in `patch` over the defaults), reading the revision first. */
async function setAccess(formId: string, patch: Record<string, unknown>): Promise<void> {
  const current = await app.inject({ url: `/v1/forms/${formId}/access`, headers: as() });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/forms/${formId}/access`,
    headers: { ...as(), 'if-match': String(current.json<{ rev: number }>().rev) },
    payload: { enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72, ...patch },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function setPassword(formId: string, password = PASSWORD): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: `/v1/forms/${formId}/access/password`, headers: as(), payload: { password } });
  expect(res.statusCode, res.body).toBe(200);
}

const unlock = async (slug: string, password = PASSWORD): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: `/v1/p/${slug}/unlock`, remoteAddress: '198.51.100.7', payload: { password } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ accessToken: string }>().accessToken;
};

/** An `arrange` that saves access settings worked out from the frozen clock, and sends no header. */
const withAccess = (patch: (now: Date) => Record<string, unknown>) => async (f: Form): Promise<Record<string, string>> => {
  await setAccess(f.id, patch(clock));
  return {};
};

/** The respondent's upload to the form's `cv` field. */
const upload = (slug: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/v1/p/${slug}/files`, headers, payload: { blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', data: PDF.toString('base64') } });

/** The respondent's submission of one answer to the live version (or the one named). */
const submit = (f: Form, headers: Record<string, string> = {}, versionId = f.versionId) =>
  app.inject({
    method: 'POST',
    url: `/v1/p/${f.slug}/submissions`,
    headers: { 'idempotency-key': randomUUID(), ...headers },
    payload: { formVersionId: versionId, answers: { name: { type: 'short_text', value: 'Asha' } }, fields: [], locale: 'en-IN' },
  });

const storedFiles = async (formId: string): Promise<number> => Number((await owner.query('select count(*) as n from form_files where form_id = $1', [formId])).rows[0].n);
const bytesOnDisk = async (): Promise<string[]> => (await readdir(dir)).sort();

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_upload_access');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'fr-upload-access-'));
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'upload-access']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@upload-access.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  const parsed = parseConfig({ NODE_ENV: 'test', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: urls.fr_app, AUTH_DEV_HEADERS: 'true', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(dir),
    now: () => clock,
    authLimits: { auth_files_ip: BUDGET, auth_files_form: BUDGET, auth_submit_ip: BUDGET, auth_submit_form: BUDGET, auth_unlock_ip: BUDGET, auth_unlock_form: BUDGET },
  });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock = new Date();
});

interface Refusal {
  name: string;
  /** Puts the form in the state under test and returns the headers a respondent would send (an access token, say). */
  arrange: (f: Form) => Promise<Record<string, string>>;
  status: number;
  code: string;
}

/** Every way a form says no, and what each answers: the codes of `problems/submit.ts` and `PASSWORD_REQUIRED`. */
const REFUSALS: Refusal[] = [
  { name: 'is switched off (ACC-01)', arrange: withAccess(() => ({ enabled: false })), status: 409, code: 'FORM_CLOSED' },
  {
    name: 'is before its open date (ACC-03)',
    arrange: withAccess((now) => ({ openAt: new Date(now.getTime() + HOUR).toISOString() })),
    status: 409,
    code: 'FORM_CLOSED',
  },
  {
    name: 'is past its close date (ACC-02)',
    arrange: withAccess((now) => ({ openAt: new Date(now.getTime() - 2 * HOUR).toISOString(), closeAt: new Date(now.getTime() - 60_000).toISOString() })),
    status: 409,
    code: 'FORM_CLOSED',
  },
  {
    name: 'has taken its limit of responses (ACC-04)',
    arrange: async (f) => {
      await setAccess(f.id, { submissionLimit: 1 });
      expect((await submit(f)).statusCode).toBe(200);
      return {};
    },
    status: 409,
    code: 'LIMIT_REACHED',
  },
  {
    name: 'is outside its weekly hours (ACC-06)',
    // One window, on every weekday but the one the frozen clock is on (UTC), all day: the form is open on six days.
    arrange: withAccess((now) => ({
      availability: { timeZone: 'UTC', windows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== now.getUTCDay()), from: '00:00', to: '23:59' }] },
    })),
    status: 409,
    code: 'FORM_CLOSED',
  },
  {
    name: 'has a password and the request has no access token (ACC-05)',
    arrange: async (f) => {
      await setPassword(f.id);
      return {};
    },
    status: 401,
    code: 'PASSWORD_REQUIRED',
  },
  {
    name: 'has a password and the access token is forged',
    arrange: async (f) => {
      await setPassword(f.id);
      return { 'x-fr-access': 'fr1.AAAA.BBBB' };
    },
    status: 401,
    code: 'PASSWORD_REQUIRED',
  },
  {
    name: 'has a password and the access token was made for another form',
    arrange: async (f) => {
      await setPassword(f.id);
      const other = await publish('Other protected form');
      await setPassword(other.id);
      return { 'x-fr-access': await unlock(other.slug) };
    },
    status: 401,
    code: 'PASSWORD_REQUIRED',
  },
  {
    name: 'has had its password changed since the access token was made',
    arrange: async (f) => {
      await setPassword(f.id);
      const token = await unlock(f.slug);
      // The token says when it was issued in whole seconds, so the owner rotates the leaked password a few seconds later.
      clock = new Date(clock.getTime() + 3_000);
      await setPassword(f.id, 'copper-lantern-orbit-47');
      return { 'x-fr-access': token };
    },
    status: 401,
    code: 'PASSWORD_REQUIRED',
  },
  {
    name: 'is switched off and has a password: closed comes before the password, whatever token is sent',
    arrange: async (f) => {
      await setPassword(f.id);
      const token = await unlock(f.slug);
      await setAccess(f.id, { enabled: false });
      return { 'x-fr-access': token };
    },
    status: 409,
    code: 'FORM_CLOSED',
  },
  {
    name: 'has a password, a valid token and is not open yet: the token does not open a form that is not open',
    arrange: async (f) => {
      await setPassword(f.id);
      const token = await unlock(f.slug);
      await setAccess(f.id, { openAt: new Date(clock.getTime() + HOUR).toISOString() });
      return { 'x-fr-access': token };
    },
    status: 409,
    code: 'FORM_CLOSED',
  },
];

describe('POST /v1/p/:slug/files refuses a form that takes no responses, with the codes the submit route uses', () => {
  for (const refusal of REFUSALS) {
    it(`a form that ${refusal.name}`, async () => {
      const f = await publish('Refused upload');
      const headers = await refusal.arrange(f);
      const filesBefore = await bytesOnDisk();

      const up = await upload(f.slug, headers);
      expect(up.statusCode, up.body).toBe(refusal.status);
      expect(up.json()).toMatchObject({ code: refusal.code });
      // Nothing was stored for the refused file: no row, no bytes.
      expect(await storedFiles(f.id)).toBe(0);
      expect(await bytesOnDisk()).toEqual(filesBefore);

      // The same form, the same headers, the same moment: the submit route says the same, in the same words.
      const sub = await submit(f, headers);
      expect(sub.statusCode, sub.body).toBe(up.statusCode);
      expect(sub.json()).toMatchObject({ code: refusal.code, detail: up.json<{ detail: string }>().detail });
    });
  }
});

describe('POST /v1/p/:slug/files takes a file from a form that is open', () => {
  const taken: Array<{ name: string; arrange: (f: Form) => Promise<Record<string, string>> }> = [
    { name: 'has no access settings at all', arrange: async () => ({}) },
    {
      name: 'is inside its open and close dates',
      arrange: withAccess((now) => ({ openAt: new Date(now.getTime() - HOUR).toISOString(), closeAt: new Date(now.getTime() + HOUR).toISOString() })),
    },
    {
      name: 'is inside its weekly hours',
      arrange: withAccess((now) => ({ availability: { timeZone: 'UTC', windows: [{ weekdays: [now.getUTCDay()], from: '00:00', to: '23:59' }] } })),
    },
    {
      name: 'has room under its limit',
      arrange: async (f) => {
        await setAccess(f.id, { submissionLimit: 2 });
        expect((await submit(f)).statusCode).toBe(200);
        return {};
      },
    },
    {
      name: 'has a password and the request carries a valid access token',
      arrange: async (f) => {
        await setPassword(f.id);
        return { 'x-fr-access': await unlock(f.slug) };
      },
    },
  ];
  for (const t of taken) {
    it(`a form that ${t.name}`, async () => {
      const f = await publish('Open upload');
      const headers = await t.arrange(f);
      const up = await upload(f.slug, headers);
      expect(up.statusCode, up.body).toBe(200);
      expect(await storedFiles(f.id)).toBe(1);
      // And the submit route agrees that the form is open.
      expect((await submit(f, headers)).statusCode).toBe(200);
    });
  }

  it('judges the form at the app’s clock: the same upload is refused before the open date and taken after it', async () => {
    const f = await publish('Opens later');
    const opensAt = new Date(clock.getTime() + HOUR);
    await setAccess(f.id, { openAt: opensAt.toISOString() });
    expect((await upload(f.slug)).statusCode).toBe(409);
    clock = new Date(opensAt.getTime() - 1);
    expect((await upload(f.slug)).statusCode).toBe(409);
    clock = opensAt;
    expect((await upload(f.slug)).statusCode).toBe(200);
  });

  it('takes the form back when it is switched on again, and refuses it again when it is switched off', async () => {
    const f = await publish('Switched');
    await setAccess(f.id, { enabled: false });
    expect((await upload(f.slug)).statusCode).toBe(409);
    await setAccess(f.id, { enabled: true });
    expect((await upload(f.slug)).statusCode).toBe(200);
    await setAccess(f.id, { enabled: false });
    expect((await upload(f.slug)).statusCode).toBe(409);
    expect(await storedFiles(f.id)).toBe(1);
  });
});

describe('what a refused upload does not cost', () => {
  it('is refused before the body is read: a closed form answers 409 to a declared length that would be 413 on an open one, and closes the connection', async () => {
    const f = await publish('Closed, big body');
    const declared = { 'content-type': 'application/json', 'content-length': String(20 * 1024 * 1024) };
    const open = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/files`, headers: declared, payload: '{' });
    expect(open.statusCode).toBe(413);

    await setAccess(f.id, { enabled: false });
    const closed = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/files`, headers: declared, payload: '{' });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: 'FORM_CLOSED' });
    expect(closed.headers['connection']).toBe('close');
  });

  it('asks a password form for its password before it says anything about the file: a body that is not even JSON gets 401, not 400', async () => {
    const f = await publish('Protected, junk body');
    await setPassword(f.id);
    const res = await app.inject({ method: 'POST', url: `/v1/p/${f.slug}/files`, headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
  });

  it('says what a submission is told when a password form is also full: the limit comes before the password in the status order', async () => {
    // The order is the one `runtimeStatus` fixes (closed, not yet open, full, outside hours, password): a full password
    // form is `limit_reached` for everyone, with or without the password. The upload says what submit says.
    const f = await publish('Protected and full');
    await setPassword(f.id);
    const token = await unlock(f.slug);
    await setAccess(f.id, { submissionLimit: 1 });
    expect((await submit(f, { 'x-fr-access': token })).statusCode).toBe(200);
    for (const headers of [{}, { 'x-fr-access': token }]) {
      const up = await upload(f.slug, headers);
      const sub = await submit(f, headers);
      expect([up.statusCode, up.json<{ code: string }>().code]).toEqual([409, 'LIMIT_REACHED']);
      expect([sub.statusCode, sub.json<{ code: string }>().code]).toEqual([409, 'LIMIT_REACHED']);
    }
    expect(await storedFiles(f.id)).toBe(0);
  });
});

describe('a password form after a republish', () => {
  it('asks again for the password: an upload names no version, so a token made for the old live version is not the live one’s', async () => {
    const f = await publish('Protected, republished');
    await setPassword(f.id);
    const token = await unlock(f.slug);
    expect((await upload(f.slug, { 'x-fr-access': token })).statusCode).toBe(200);

    const next = await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/publish`, headers: as(), payload: {} });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json<{ versionId: string }>().versionId).not.toBe(f.versionId);

    const stale = await upload(f.slug, { 'x-fr-access': token });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: 'PASSWORD_REQUIRED' });
    // The page of the new version unlocks again, and its token is the one that works.
    expect((await upload(f.slug, { 'x-fr-access': await unlock(f.slug) })).statusCode).toBe(200);
  });
});
