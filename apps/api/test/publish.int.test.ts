import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { RuntimeFormVersionSchema } from '@form/schema';
import { TEST_PASSWORDS } from './global-setup.ts';
import { publishableDraft } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_publish');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'live']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@live.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);

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

describe('publish and public fill', () => {
  it('publishes a draft and accepts an anonymous submission on the slug', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'Live form' } });
    expect(created.statusCode).toBe(200);
    const { id } = created.json<{ id: string }>();
    const draft = publishableDraft(id);
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/forms/${id}/draft`,
      headers: as(userId),
      payload: { draft },
    });
    expect(put.statusCode).toBe(200);

    const published = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId) });
    expect(published.statusCode).toBe(200);
    const live = published.json<{ slug: string; versionId: string; number: number }>();
    expect(live.number).toBe(1);
    expect(live.slug).toContain(id.slice(0, 8));

    const again = await app.inject({ url: `/v1/forms/${id}/live`, headers: as(userId) });
    expect(again.json()).toMatchObject({ slug: live.slug, versionId: live.versionId });

    const publicGet = await app.inject({ url: `/v1/p/${live.slug}` });
    expect(publicGet.statusCode).toBe(200);
    const body = publicGet.json<{ formId: string; version: { versionId: string; status: { state: string } } }>();
    expect(body.formId).toBe(id);
    expect(body.version.versionId).toBe(live.versionId);
    expect(body.version.status.state).toBe('open');
    expect(RuntimeFormVersionSchema.safeParse(body.version).success).toBe(true);

    const submit = await app.inject({
      method: 'POST',
      url: `/v1/p/${live.slug}/submissions`,
      payload: { formVersionId: live.versionId, answers: {}, fields: [], locale: 'en-IN' },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json()).toEqual({ id: expect.any(String) });
  });

  it('refuses an unpublished slug', async () => {
    const res = await app.inject({ url: '/v1/p/missing-form' });
    expect(res.statusCode).toBe(404);
  });

  it('publishes without a session so another device can fill the form', async () => {
    const id = randomUUID();
    const published = await app.inject({
      method: 'POST',
      url: '/v1/p/publish',
      payload: { id, draft: publishableDraft(id, 'Phone form') },
    });
    expect(published.statusCode).toBe(200);
    const live = published.json<{ slug: string; versionId: string }>();
    const publicGet = await app.inject({ url: `/v1/p/${live.slug}` });
    expect(publicGet.statusCode).toBe(200);
    expect(publicGet.json()).toMatchObject({ formId: id });

    const versionId = publicGet.json<{ version: { versionId: string } }>().version.versionId;
    const submit = await app.inject({
      method: 'POST',
      url: `/v1/p/${live.slug}/submissions`,
      payload: { formVersionId: versionId, answers: {}, fields: [{ key: 'name', label: 'Name', value: 'Ada' }], locale: 'en-IN' },
    });
    expect(submit.statusCode).toBe(200);
    const list = await app.inject({ url: `/v1/p/by-form/${id}/submissions` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      items: [expect.objectContaining({ formId: id, fieldCount: 1 })],
    });
  });
});
