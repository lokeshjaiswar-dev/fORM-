import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { RuntimeFormVersionSchema, type FormDefinition } from '@form/schema';
import { TEST_PASSWORDS } from './global-setup.ts';
import { publishableDraft } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;
let viewerId: string;
let otherOrgId: string;
let otherUserId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_publish');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  viewerId = randomUUID();
  otherOrgId = randomUUID();
  otherUserId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'live']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@live.test']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [viewerId, 'viewer@live.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, viewerId, 'viewer']);
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [otherOrgId, 'elsewhere']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [otherUserId, 'owner@elsewhere.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [otherOrgId, otherUserId, 'owner']);

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

const as = (user: string, org = orgId) => ({ 'x-fr-dev-user': user, 'x-fr-org': org, ...BROWSER });

/** A form row with a saved draft, as the builder leaves it before Publish. */
async function savedForm(draft: (id: string) => FormDefinition = (id) => publishableDraft(id)): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'Live form' } });
  expect(created.statusCode).toBe(200);
  const { id } = created.json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(userId), payload: { draft: draft(id) } });
  expect(put.statusCode).toBe(200);
  return id;
}

const withCover = (assetId: string) => (id: string): FormDefinition => {
  const base = publishableDraft(id);
  return { ...base, theme: { ...base.theme, tokens: { ...base.theme.tokens, cover: { image: { assetId }, heightPx: 200 } } } } as unknown as FormDefinition;
};

describe('publish and public fill', () => {
  it('publishes the saved draft and accepts an anonymous submission on the slug', async () => {
    const id = await savedForm();

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

  it('keeps the slug and numbers the next version when a form is published again', async () => {
    const id = await savedForm();
    const first = (await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: {} })).json<{ slug: string; versionId: string }>();
    const second = (await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: {} })).json<{ slug: string; versionId: string; number: number }>();
    expect(second.slug).toBe(first.slug);
    expect(second.number).toBe(2);
    const publicGet = await app.inject({ url: `/v1/p/${first.slug}` });
    expect(publicGet.json<{ version: { versionId: string } }>().version.versionId).toBe(second.versionId);
  });

  it('refuses an unpublished slug', async () => {
    const res = await app.inject({ url: '/v1/p/missing-form' });
    expect(res.statusCode).toBe(404);
  });

  it('records who published each version on the org’s audit log (form.published), without an address', async () => {
    const id = await savedForm();
    const live = (await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: { ...as(userId), 'user-agent': 'audit-test' }, payload: {} })).json<{ slug: string; versionId: string; number: number }>();
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = 'form.published' and event->>'resourceId' = $2`, [orgId, live.versionId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      actorKind: 'user',
      actorId: userId,
      action: 'form.published',
      resourceType: 'form_version',
      resourceId: live.versionId,
      formId: id,
      outcome: 'success',
      metadata: { number: live.number, slug: live.slug },
    });
    expect(JSON.stringify(rows[0]!.event)).not.toMatch(/127\.0\.0\.1/);
    // A publish that fails (no draft) records nothing.
    const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'No draft' } });
    const bare = created.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/v1/forms/${bare}/publish`, headers: as(userId), payload: {} });
    const none = await owner.query(`select 1 from audit_pending where event->>'action' = 'form.published' and event->>'formId' = $1`, [bare]);
    expect(none.rows).toEqual([]);
  });
});

describe('publishing needs a signed-in member with forms.publish', () => {
  it('has no anonymous publish route, and an anonymous post creates nothing', async () => {
    const id = randomUUID();
    const before = (await owner.query<{ n: number }>('select count(*)::int as n from forms')).rows[0]!.n;
    for (const headers of [{}, BROWSER]) {
      const res = await app.inject({ method: 'POST', url: '/v1/p/publish', headers, payload: { id, draft: publishableDraft(id, 'Phone form') } });
      expect(res.statusCode).toBe(404);
    }
    expect((await owner.query<{ n: number }>('select count(*)::int as n from forms')).rows[0]!.n).toBe(before);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('answers 401 without a session', async () => {
    const id = await savedForm();
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: BROWSER })).statusCode).toBe(401);
  });

  it('refuses a member whose role cannot publish', async () => {
    const id = await savedForm();
    const res = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(viewerId), payload: {} });
    expect(res.statusCode).toBe(403);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('does not publish into, or out of, another org', async () => {
    const id = await savedForm();
    // A member of another org naming their own org: the form is not theirs.
    const own = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(otherUserId, otherOrgId), payload: {} });
    expect(own.statusCode).toBe(404);
    // ... naming the form's org: not a member.
    const named = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(otherUserId, orgId), payload: {} });
    expect(named.statusCode).toBe(403);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('files every published form under the caller’s org, never another one', async () => {
    const id = await savedForm();
    await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: {} });
    const { rows } = await owner.query<{ org_id: string; published_by: string }>('select org_id, published_by from form_versions where form_id = $1', [id]);
    expect(rows).toEqual([{ org_id: orgId, published_by: userId }]);
  });
});

describe('the pictures a form uses', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('are stored with the version, only the ones the definition names, and shown on the public page', async () => {
    const id = await savedForm(withCover('pic1'));
    const published = await app.inject({
      method: 'POST',
      url: `/v1/forms/${id}/publish`,
      headers: as(userId),
      payload: { media: { pic1: PNG, unused: PNG } },
    });
    expect(published.statusCode).toBe(200);
    const { slug } = published.json<{ slug: string }>();
    const publicGet = await app.inject({ url: `/v1/p/${slug}` });
    expect(publicGet.json()).toMatchObject({ media: { pic1: PNG } });
    expect(Object.keys(publicGet.json<{ media: Record<string, string> }>().media)).toEqual(['pic1']);
  });

  it('refuse anything that is not a raster data URL (an SVG can carry script)', async () => {
    const id = await savedForm(withCover('pic1'));
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'https://evil.example/x.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+']) {
      const res = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: { media: { pic1: bad } } });
      expect(res.statusCode).toBe(400);
    }
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });
});
