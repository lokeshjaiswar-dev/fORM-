import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

interface Org {
  id: string;
  owner: string;
  member: string;
  forms: string[];
}

let app: FastifyInstance;
let owner: pg.Pool;
let a: Org;
let b: Org;

async function seedOrg(slug: string, titles: string[]): Promise<Org> {
  const org: Org = { id: randomUUID(), owner: randomUUID(), member: randomUUID(), forms: titles.map(() => randomUUID()) };
  const team = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  for (const [id, role] of [
    [org.owner, 'owner'],
    [org.member, 'creator'],
  ] as const) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${role}@${slug}.test`]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org.id, id, role]);
  }
  for (const [i, title] of titles.entries()) {
    await owner.query(
      `insert into forms (id, org_id, team_id, owner_user_id, title, updated_at) values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))`,
      [org.forms[i], org.id, team, org.owner, title, i],
    );
  }
  return org;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  a = await seedOrg('acme', ['Acme newest', 'Acme older']);
  b = await seedOrg('globex', ['Globex only']);
  await owner.query(`update forms set lifecycle = 'archived' where id = $1`, [a.forms[1]]);

  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config);
  app.get('/v1/test-only/members', { config: { auth: 'user', perm: 'members.manage' } }, async () => ({ ok: true }));
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

const as = (user: string, org: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': org });

async function pending(orgKey: string): Promise<Array<{ action: string; outcome: string; reason: string }>> {
  const { rows } = await owner.query<{ event: { action: string; outcome: string; reason: string } }>(
    'select event from audit_pending where org_key = $1 order by id',
    [orgKey],
  );
  return rows.map((r) => r.event);
}

describe('GET /v1/forms (RLS demo)', () => {
  it('lists only the active org’s forms, newest first', async () => {
    const res = await app.inject({ url: '/v1/forms?lifecycle=active', headers: as(a.owner, a.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [{ id: a.forms[0], title: 'Acme newest', lifecycle: 'active', teamId: expect.any(String), updatedAt: expect.any(String) }],
    });
    const archived = await app.inject({ url: '/v1/forms?lifecycle=archived', headers: as(a.owner, a.id) });
    expect(archived.json<{ items: { id: string }[] }>().items.map((f) => f.id)).toEqual([a.forms[1]]);
    const other = await app.inject({ url: '/v1/forms', headers: as(b.owner, b.id) });
    expect(other.json<{ items: { title: string }[] }>().items.map((f) => f.title)).toEqual(['Globex only']);
  });

  it('honours the limit', async () => {
    const res = await app.inject({ url: '/v1/forms?limit=1&lifecycle=active', headers: as(b.owner, b.id) });
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('refuses an org the user does not belong to, and audits the denial under the platform key', async () => {
    const res = await app.inject({ url: '/v1/forms', headers: as(a.owner, b.id) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN', detail: 'You are not a member of this org.' });
    const events = await pending('00000000-0000-0000-0000-000000000000');
    expect(events.at(-1)).toMatchObject({ action: 'request.authorize', outcome: 'denied', reason: 'not_a_member' });
  });

  it('lets any member role read forms, and no one else', async () => {
    const creator = await app.inject({ url: '/v1/forms', headers: as(a.member, a.id) });
    expect(creator.statusCode).toBe(200);
    const stranger = await app.inject({ url: '/v1/forms', headers: as(randomUUID(), a.id) });
    expect(stranger.statusCode).toBe(403);
  });

  it('audits a missing permission under the member’s org', async () => {
    await owner.query(`update memberships set role = 'data_viewer' where user_id = $1`, [a.member]);
    const res = await app.inject({ url: '/v1/test-only/members', headers: as(a.member, a.id) });
    expect(res.statusCode).toBe(403);
    expect((await pending(a.id)).at(-1)).toMatchObject({ outcome: 'denied', reason: 'missing_permission:members.manage' });
  });

  it('is ready against the real database', async () => {
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { db: { status: 'ok' }, clock: { status: 'skipped' } } });
  });
});
