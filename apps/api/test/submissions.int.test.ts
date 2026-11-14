import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;
let formId: string;
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
  formId = randomUUID();
  const team = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'inbox']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@inbox.test']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [creatorId, 'creator@inbox.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, creatorId, 'creator']);
  await owner.query(
    `insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, 'Contact')`,
    [formId, orgId, team, userId],
  );
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
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

const as = (user: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': orgId, ...BROWSER });

describe('form submissions', () => {
  it('stores a submission and returns it with the filled fields', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/forms/${formId}/submissions`,
      headers: as(userId),
      payload: {
        answers: { name: { type: 'short_text', value: 'Asha' } },
        fields: [{ key: 'name', label: 'Name', value: 'Asha' }],
        locale: 'en-IN',
      },
    });
    expect(created.statusCode).toBe(200);
    const { id } = created.json<{ id: string }>();

    const list = await app.inject({ url: `/v1/forms/${formId}/submissions`, headers: as(userId) });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string; fieldCount: number }[] }>().items).toEqual([
      expect.objectContaining({ id, formId, fieldCount: 1 }),
    ]);

    const one = await app.inject({ url: `/v1/forms/${formId}/submissions/${id}`, headers: as(userId) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      id,
      fields: [{ key: 'name', label: 'Name', value: 'Asha' }],
      answers: { name: { type: 'short_text', value: 'Asha' } },
    });
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
    submissionId = randomUUID();
    await owner.query(
      `insert into form_submissions (id, org_id, form_id, answers, fields)
       values ($1, $2, $3, '{"q":{"type":"short_text","value":"secret"}}', '[{"key":"q","label":"Q","value":"secret"}]')`,
      [submissionId, orgId, formId],
    );
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
      expect(one.json()).toMatchObject({ id: submissionId, fields: [{ key: 'q', value: 'secret' }] });
    }
  });
});
