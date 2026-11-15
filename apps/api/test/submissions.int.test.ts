import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newSubmissionKey, provision, uuidV7 } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;
let formId: string;
/** The live version of `formId`: its two fields, `name` and `city`, are what the stored rows are shown with. */
let versionId: string;
let creatorId: string;
let outsiderOrgId: string;
let outsiderId: string;
let viewerId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_submissions');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  creatorId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'inbox']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@inbox.test']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [creatorId, 'creator@inbox.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, creatorId, 'creator']);
  viewerId = randomUUID();
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [viewerId, 'viewer@inbox.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, viewerId, 'viewer']);
  // Another org, with its own owner: a signed-in user who is nobody in the first org.
  outsiderOrgId = randomUUID();
  outsiderId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [outsiderOrgId, 'elsewhere']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [outsiderId, 'owner@elsewhere.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [outsiderOrgId, outsiderId, 'owner']);

  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false });
  // A published form, as the member routes make one: the responses below are filed under its live version.
  ({ id: formId, versionId } = await publish(userId, 'Contact'));
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

const as = (user: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': orgId, ...BROWSER });

/** Creates, drafts and publishes a form with the fields `name` and `city`, as `user`. */
async function publish(user: string, title: string): Promise<{ id: string; versionId: string }> {
  const { id } = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(user), payload: { title } })).json<{ id: string }>();
  const draft = draftWith(id, [fieldBlock('name', 'short_text'), fieldBlock('city', 'short_text')], title);
  expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(user), 'if-match': '0' }, payload: { draft } })).statusCode).toBe(200);
  const live = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(user), payload: {} });
  expect(live.statusCode, live.body).toBe(200);
  return { id, versionId: live.json<{ versionId: string }>().versionId };
}

const short = (value: string) => ({ type: 'short_text', value });

/**
 * A response stored the way the submit route stores it, as the schema owner (which may name any column): filed under
 * `version` of `form`, received at `at`, with a UUIDv7 id made from that moment.
 */
async function store(answers: Record<string, unknown>, o: { form?: string; version?: string; at?: Date; locale?: string; trashed?: boolean } = {}): Promise<string> {
  const { id, receivedAt } = newSubmissionKey(o.at ?? new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta, trashed_at)
     select $1, $2, org_id, form_id, id, decode(content_hash, 'hex'), 0, 'complete', $3, '{}', $4, case when $5 then now() end from form_versions where id = $6`,
    [id, receivedAt, JSON.stringify(answers), JSON.stringify({ locale: o.locale ?? 'en-IN' }), o.trashed ?? false, o.version ?? versionId],
  );
  return id;
}

describe('form submissions', () => {
  it('has no route that creates a submission: members read responses, only the published page writes them', async () => {
    const before = (await owner.query('select count(*)::int as n from submissions where form_id = $1', [formId])).rows[0].n;
    for (const headers of [as(userId), {}]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/forms/${formId}/submissions`,
        headers,
        payload: { answers: { name: { type: 'short_text', value: 'forged' } }, fields: [{ key: 'approval', label: 'Approved by HR', value: 'Yes' }], locale: 'en-IN' },
      });
      expect(res.statusCode).toBe(404);
    }
    expect((await owner.query('select count(*)::int as n from submissions where form_id = $1', [formId])).rows[0].n).toBe(before);
  });

  it('lists a stored submission and returns it with the filled fields', async () => {
    const id = await store({ name: short('Asha') });

    const list = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers: as(userId) });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string; fieldCount: number }[] }>().items).toEqual([expect.objectContaining({ id, formId, fieldCount: 1 })]);

    const one = await app.inject({ url: `/v1/forms/${formId}/submissions/${id}`, headers: as(userId) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      id,
      fieldCount: 1,
      locale: 'en-IN',
      fields: [{ key: 'name', label: 'name', value: 'Asha' }],
      answers: { name: { type: 'short_text', value: 'Asha' } },
    });
  });

  it('lists the newest first by the moment received, with trashed ones left out, and says when each was received', async () => {
    const f = await publish(userId, 'Order');
    const at = (iso: string) => new Date(iso);
    const older = await store({ name: short('older') }, { form: f.id, version: f.versionId, at: at('2026-11-03T10:00:00.000Z') });
    const newest = await store({ name: short('newest') }, { form: f.id, version: f.versionId, at: at('2026-11-14T08:15:30.250Z') });
    const middle = await store({ name: short('middle') }, { form: f.id, version: f.versionId, at: at('2026-11-09T23:59:59.999Z') });
    await store({ name: short('trashed') }, { form: f.id, version: f.versionId, at: at('2026-11-15T01:00:00.000Z'), trashed: true });
    const list = await app.inject({ url: `/v1/forms/${f.id}/submissions`, headers: as(userId) });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string; submittedAt: string }[] }>().items.map((i) => [i.id, i.submittedAt])).toEqual([
      [newest, '2026-11-14T08:15:30.250Z'],
      [middle, '2026-11-09T23:59:59.999Z'],
      [older, '2026-11-03T10:00:00.000Z'],
    ]);
  });

  it('shows each response with the labels of the version it was received on, not the live one', async () => {
    const f = await publish(userId, 'Relabelled');
    // A second version in which the same field is called something else.
    const name = fieldBlock('name', 'short_text');
    const renamed = { ...name, label: { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Full name' }] }] } };
    const draft = draftWith(f.id, [renamed, fieldBlock('city', 'short_text')], 'Relabelled');
    expect((await app.inject({ method: 'PUT', url: `/v1/forms/${f.id}/draft`, headers: { ...as(userId), 'if-match': '1' }, payload: { draft } })).statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/v1/forms/${f.id}/publish`, headers: as(userId), payload: {} });
    expect(second.statusCode, second.body).toBe(200);
    const onFirst = await store({ name: short('Asha'), city: short('Pune') }, { form: f.id, version: f.versionId });
    const onSecond = await store({ name: short('Ravi') }, { form: f.id, version: second.json<{ versionId: string }>().versionId });
    const detail = (id: string) => app.inject({ url: `/v1/forms/${f.id}/submissions/${id}`, headers: as(userId) });
    expect((await detail(onFirst)).json()).toMatchObject({
      fieldCount: 2,
      fields: [{ key: 'name', label: 'name', value: 'Asha' }, { key: 'city', label: 'city', value: 'Pune' }],
    });
    expect((await detail(onSecond)).json()).toMatchObject({ fieldCount: 1, fields: [{ key: 'name', label: 'Full name', value: 'Ravi' }] });
    const list = (await app.inject({ url: `/v1/forms/${f.id}/submissions`, headers: as(userId) })).json<{ items: { id: string; fieldCount: number }[] }>().items;
    expect(Object.fromEntries(list.map((i) => [i.id, i.fieldCount]))).toEqual({ [onFirst]: 2, [onSecond]: 1 });
  });

  it('finds one submission by id and its own moment, and nothing for an id that is not a UUIDv7 or is on another form', async () => {
    const mine = await store({ name: short('Asha') });
    const other = await publish(userId, 'Another form');
    expect((await app.inject({ url: `/v1/forms/${formId}/submissions/${mine}`, headers: as(userId) })).statusCode).toBe(200);
    // Not a UUIDv7: no submission can have it, and the database is never asked for its moment (that would be a 500).
    for (const id of [randomUUID(), '00000000-0000-0000-0000-000000000000']) {
      const res = await app.inject({ url: `/v1/forms/${formId}/submissions/${id}`, headers: as(userId) });
      expect(res.statusCode, id).toBe(404);
    }
    // A UUIDv7 nothing was stored under, and a stored one named under the wrong form.
    expect((await app.inject({ url: `/v1/forms/${formId}/submissions/${uuidV7(new Date())}`, headers: as(userId) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/forms/${other.id}/submissions/${mine}`, headers: as(userId) })).statusCode).toBe(404);
  });

  it('lets a creator register the form but not read submissions', async () => {
    const id = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/forms',
      headers: as(creatorId),
      payload: { id, title: 'Draft' },
    });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ url: `/v1/forms/${id}/submissions`, headers: as(creatorId) });
    expect(list.statusCode).toBe(403);
  });
});

describe('who may read the submissions of a form', () => {
  let submissionId: string;

  beforeAll(async () => {
    submissionId = await store({ name: short('secret') });
  });

  it('refuses a caller with no session, on the list and on one submission', async () => {
    for (const url of [`/v1/forms/${formId}/submissions`, `/v1/forms/${formId}/submissions/${submissionId}`]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('secret');
    }
  });

  it('has no public read route any more', async () => {
    for (const url of [`/v1/p/by-form/${formId}/submissions`, `/v1/p/by-form/${formId}/submissions/${submissionId}`]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret');
    }
  });

  it('refuses a member of another org who names that org', async () => {
    const res = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers: { 'x-fr-dev-user': outsiderId, 'x-fr-org': orgId } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('secret');
  });

  it('does not show a member of another org the form, whatever org they act in', async () => {
    const headers = { 'x-fr-dev-user': outsiderId, 'x-fr-org': outsiderOrgId };
    const list = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers });
    expect(list.statusCode).toBe(404);
    const one = await app.inject({ url: `/v1/forms/${formId}/submissions/${submissionId}`, headers });
    expect(one.statusCode).toBe(404);
    expect(one.body).not.toContain('secret');
  });

  it('lets a member with submissions.read in the form’s org read them', async () => {
    for (const who of [userId, viewerId]) {
      const list = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers: as(who) });
      expect(list.statusCode).toBe(200);
      const one = await app.inject({ url: `/v1/forms/${formId}/submissions/${submissionId}`, headers: as(who) });
      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject({ id: submissionId, fields: [{ key: 'name', value: 'secret' }] });
    }
  });
});
