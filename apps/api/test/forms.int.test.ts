import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chainPending, createDb, forms, PLATFORM_ORG_KEY, provision, withTenant, type DbHandle } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { tenantOf } from '../src/auth.ts';
import { parseConfig } from '../src/config.ts';
import { ProblemError } from '../src/errors.ts';
import { verifyPassword } from '../src/modules/auth/passwords.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';
import { v1Form } from './v1-form.ts';

interface Org {
  id: string;
  owner: string;
  member: string;
  forms: string[];
}

let app: FastifyInstance;
let owner: pg.Pool;
let chainer: DbHandle;
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
  // Back-pressure off: a loaded machine running the int suites in parallel would see 503s that say nothing about RLS.
  app = await buildApp(parsed.config, { underPressure: false });
  app.get('/v1/test-only/members', { config: { auth: 'user', perm: 'members.manage' } }, async () => ({ ok: true }));
  // A write, then a refusal inside the same transaction: the change rolls back, the denied record must not.
  app.post('/v1/test-only/rename-then-refuse', { config: { auth: 'user', perm: 'forms.read' } }, async (request) =>
    withTenant(chainer.db, tenantOf(request), async (tx) => {
      await tx.update(forms).set({ title: 'should roll back' }).where(eq(forms.id, a.forms[0]!));
      throw new ProblemError('FORBIDDEN', 'Only the form owner may rename it.');
    }),
  );
  app.get('/v1/test-only/boom', { config: { auth: 'user', perm: 'forms.read' } }, async () => {
    throw new Error('downstream exploded');
  });
  chainer = createDb(urls.fr_app, { max: 2, applicationName: 'fr-api-test-chain' });
});

afterAll(async () => {
  await app?.close();
  await chainer?.close();
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
      items: [
        {
          id: a.forms[0],
          title: 'Acme newest',
          lifecycle: 'active',
          teamId: expect.any(String),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          favourite: false,
          submissionCount: 0,
          isLive: false,
        },
      ],
      nextCursor: null,
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

  it('turns a 403 into an audit_log row once audit.chain runs, surviving the rollback of the request', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/test-only/rename-then-refuse', headers: as(a.owner, a.id) });
    expect(res.statusCode).toBe(403);
    const { rows: title } = await owner.query<{ title: string }>('select title from forms where id = $1', [a.forms[0]]);
    expect(title[0]!.title).toBe('Acme newest');
    const stranger = await app.inject({ url: '/v1/forms', headers: as(b.owner, a.id) });
    expect(stranger.statusCode).toBe(403);

    for (const key of [a.id, PLATFORM_ORG_KEY]) {
      await withTenant(chainer.db, { orgId: key, actor: 'system', requestId: 'chain' }, (tx) => chainPending(tx, key));
    }
    const { rows } = await owner.query<{ org_id: string; actor_id: string; action: string; resource_id: string; outcome: string; reason: string; request_id: string; metadata: unknown }>(
      `select org_id, actor_id, action, resource_id, outcome, reason, request_id, metadata from audit_log where request_id = any($1) order by org_id`,
      [[res.headers['x-request-id'], stranger.headers['x-request-id']]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          org_id: a.id,
          actor_id: a.owner,
          action: 'request.authorize',
          resource_id: 'POST /v1/test-only/rename-then-refuse',
          outcome: 'denied',
          reason: 'forbidden',
          request_id: res.headers['x-request-id'],
          metadata: { code: 'FORBIDDEN', claimedOrgId: null },
        },
        {
          org_id: PLATFORM_ORG_KEY,
          actor_id: b.owner,
          action: 'request.authorize',
          resource_id: 'GET /v1/forms',
          outcome: 'denied',
          reason: 'not_a_member',
          request_id: stranger.headers['x-request-id'],
          metadata: { code: 'FORBIDDEN', claimedOrgId: a.id },
        },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('audits a 5xx as an error under the tenant, without the error details', async () => {
    const res = await app.inject({ url: '/v1/test-only/boom', headers: as(a.owner, a.id) });
    expect(res.statusCode).toBe(500);
    expect((await pending(a.id)).at(-1)).toMatchObject({ action: 'request.failed', outcome: 'error', reason: 'INTERNAL' });
    expect(JSON.stringify(await pending(a.id))).not.toContain('exploded');
  });

  it('is ready against the real database', async () => {
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { db: { status: 'ok' }, clock: { status: 'skipped' } } });
  });
});

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const asWrite = (user: string, org: string) => ({ ...as(user, org), ...BROWSER });


interface Put {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T = Record<string, unknown>>(): T;
}

/** A draft write. `ifMatch` undefined sends no header at all. */
function putDraft(user: string, org: string, id: string, draft: unknown, ifMatch?: string): Promise<Put> {
  return app.inject({
    method: 'PUT',
    url: `/v1/forms/${id}/draft`,
    headers: { ...asWrite(user, org), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
    payload: { draft },
  });
}

async function createForm(user: string, org: string, title: string): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(user, org), payload: { title } });
  expect(created.statusCode).toBe(200);
  return created.json<{ id: string }>().id;
}

const def = (id: string, title: string) => draftWith(id, [fieldBlock('name', 'short_text')], title);

async function newUser(org: string, role: string): Promise<string> {
  const id = randomUUID();
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${role}-${id.slice(0, 8)}@acme.test`]);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
  return id;
}

describe('draft writes: If-Match, compare-and-swap and the strict definition', () => {
  it('refuses a PUT without If-Match (428) and writes nothing', async () => {
    const id = await createForm(a.owner, a.id, 'Needs a revision');
    const res = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: asWrite(a.owner, a.id), payload: { draft: def(id, 'x') } });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({ code: 'PRECONDITION_REQUIRED', status: 428 });
    expect(res.headers['content-type']).toContain('application/problem+json');
    const { rows } = await owner.query('select 1 from form_drafts where form_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('creates the draft at If-Match 0, then two PUTs with the same If-Match: the second gets 409 with the server draft and draftRev', async () => {
    const id = await createForm(a.owner, a.id, 'Contact');
    const created = await putDraft(a.owner, a.id, id, def(id, 'Contact'), '0');
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ draftRev: 1 });
    expect(created.headers.etag).toBe('"1"');

    const first = await putDraft(a.owner, a.id, id, def(id, 'Alice edit'), '1');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ draftRev: 2 });

    const bob = await newUser(a.id, 'editor');
    const second = await putDraft(bob, a.id, id, def(id, 'Bob edit'), '1');
    expect(second.statusCode).toBe(409);
    expect(second.headers['content-type']).toContain('application/problem+json');
    expect(second.headers.etag).toBe('"2"');
    expect(second.json()).toMatchObject({
      code: 'DRAFT_REV_CONFLICT',
      status: 409,
      draftRev: 2,
      updatedBy: a.owner,
      updatedAt: first.json<{ updatedAt: string }>().updatedAt,
      draft: { title: 'Alice edit', formId: id },
    });

    // The refused write changed nothing: the draft and the form's title are still Alice's.
    const { rows } = await owner.query<{ draft_rev: number; title: string; form_title: string }>(
      `select d.draft_rev, d.draft->>'title' as title, f.title as form_title from form_drafts d join forms f on f.id = d.form_id where d.form_id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ draft_rev: 2, title: 'Alice edit', form_title: 'Alice edit' });
  });

  it('lets exactly one of several parallel PUTs from the same revision win', async () => {
    const id = await createForm(a.owner, a.id, 'Race');
    expect((await putDraft(a.owner, a.id, id, def(id, 'Race'), '0')).statusCode).toBe(200);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => putDraft(a.owner, a.id, id, def(id, `Racer ${i}`), '1')));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    const { rows } = await owner.query<{ draft_rev: number }>('select draft_rev from form_drafts where form_id = $1', [id]);
    expect(rows[0]!.draft_rev).toBe(2);
  });

  it('refuses If-Match 0 when a draft exists, and a revision that never existed when none does', async () => {
    const id = await createForm(a.owner, a.id, 'Existing');
    expect((await putDraft(a.owner, a.id, id, def(id, 'Existing'), '0')).statusCode).toBe(200);
    const again = await putDraft(a.owner, a.id, id, def(id, 'Overwrite'), '0');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ draftRev: 1, draft: { title: 'Existing' } });

    const fresh = await createForm(a.owner, a.id, 'No draft yet');
    const stale = await putDraft(a.owner, a.id, fresh, def(fresh, 'x'), '5');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'DRAFT_REV_CONFLICT', draftRev: 0, draft: null });
  });

  it('reads If-Match as "3", W/"3" or 3, and refuses anything else as a bad request', async () => {
    const id = await createForm(a.owner, a.id, 'Header forms');
    expect((await putDraft(a.owner, a.id, id, def(id, 'v1'), '0')).statusCode).toBe(200);
    expect((await putDraft(a.owner, a.id, id, def(id, 'v2'), '"1"')).json()).toMatchObject({ draftRev: 2 });
    expect((await putDraft(a.owner, a.id, id, def(id, 'v3'), 'W/"2"')).json()).toMatchObject({ draftRev: 3 });
    expect((await putDraft(a.owner, a.id, id, def(id, 'v4'), '3')).json()).toMatchObject({ draftRev: 4 });
    for (const bad of ['*', 'abc', '-1', '1.5', '"1", "2"']) {
      const res = await putDraft(a.owner, a.id, id, def(id, 'nope'), bad);
      expect(res.statusCode, `If-Match: ${bad}`).toBe(400);
    }
  });

  it('answers GET draft after a PUT with the latest draftRev, in the body and as the ETag', async () => {
    const id = await createForm(a.owner, a.id, 'Reload me');
    await putDraft(a.owner, a.id, id, def(id, 'Reload me'), '0');
    await putDraft(a.owner, a.id, id, def(id, 'Reload me v2'), '1');
    const last = await putDraft(a.owner, a.id, id, def(id, 'Reload me v3'), '2');
    expect(last.headers.etag).toBe('"3"');

    const got = await app.inject({ url: `/v1/forms/${id}/draft`, headers: as(a.owner, a.id) });
    expect(got.statusCode).toBe(200);
    expect(got.headers.etag).toBe('"3"');
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(got.json()).toMatchObject({ draftRev: 3, schemaVersion: 2, updatedBy: a.owner, draft: { title: 'Reload me v3', formId: id } });
    expect(got.json<{ draft: unknown }>().draft).toEqual(JSON.parse(JSON.stringify(def(id, 'Reload me v3'))));
  });

  it('refuses a draft the strict definition does not know: an unknown key such as settings.password is a 422 and is not stored', async () => {
    const id = await createForm(a.owner, a.id, 'Strict');
    expect((await putDraft(a.owner, a.id, id, def(id, 'Strict'), '0')).statusCode).toBe(200);
    const withPassword = { ...def(id, 'Strict'), settings: { password: 'plaintext-secret-9' } };
    const res = await putDraft(a.owner, a.id, id, withPassword, '1');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'DRAFT_INVALID', status: 422, errors: [{ path: '/', message: expect.stringContaining('settings') }] });
    expect(JSON.stringify(res.json())).not.toContain('plaintext-secret-9');
    const { rows } = await owner.query<{ draft_rev: number; text: string }>('select draft_rev, draft::text as text from form_drafts where form_id = $1', [id]);
    expect(rows[0]!.draft_rev).toBe(1);
    expect(rows[0]!.text).not.toContain('plaintext-secret-9');

    // Also a wrong type deep inside, and the legacy shape the old route took (`schemaVersion`, `title` and anything else).
    const wrongType = { ...def(id, 'Strict'), behavior: { ...def(id, 'x').behavior, timeZone: 5 } };
    expect((await putDraft(a.owner, a.id, id, wrongType, '1')).statusCode).toBe(422);
    expect((await putDraft(a.owner, a.id, id, { schemaVersion: 2, title: 'Legacy', blocks: { q1: { type: 'short_text' } } }, '1')).statusCode).toBe(422);
    // A body with no `draft` at all is not a definition to judge: the request itself is malformed (400).
    expect((await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...asWrite(a.owner, a.id), 'if-match': '1' }, payload: {} })).statusCode).toBe(400);
  });

  it('refuses a draft that names another form than the address', async () => {
    const id = await createForm(a.owner, a.id, 'Mine');
    const other = randomUUID();
    const res = await putDraft(a.owner, a.id, id, def(other, 'Not mine'), '0');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'DRAFT_INVALID', errors: [{ path: '/formId' }] });
    expect((await owner.query('select 1 from form_drafts where form_id in ($1, $2)', [id, other])).rows).toHaveLength(0);
  });

  it('keeps the form row’s title in step with the draft, and a rename through PATCH renames the draft too', async () => {
    const id = await createForm(a.owner, a.id, 'Before');
    await putDraft(a.owner, a.id, id, def(id, 'Draft title'), '0');
    const renamed = await app.inject({ method: 'PATCH', url: `/v1/forms/${id}`, headers: asWrite(a.owner, a.id), payload: { title: '  Renamed in the list  ' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id, title: 'Renamed in the list' });
    const got = await app.inject({ url: `/v1/forms/${id}/draft`, headers: as(a.owner, a.id) });
    expect(got.json()).toMatchObject({ draftRev: 2, draft: { title: 'Renamed in the list' } });
    // A builder still on revision 1 gets the renamed draft in the 409, not a silent rename back.
    const stale = await putDraft(a.owner, a.id, id, def(id, 'Stale tab'), '1');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ draft: { title: 'Renamed in the list' } });
    for (const bad of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(501) }, {}, { title: 'ok', extra: 1 }]) {
      const res = await app.inject({ method: 'PATCH', url: `/v1/forms/${id}`, headers: asWrite(a.owner, a.id), payload: bad });
      expect(res.statusCode, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
  });

  it('takes the form row before the draft row in both PUT draft and PATCH, so a save and a rename that meet cannot deadlock', async () => {
    const id = await createForm(a.owner, a.id, 'Lock order');
    expect((await putDraft(a.owner, a.id, id, def(id, 'Lock order'), '0')).statusCode).toBe(200);

    // Force the unlucky interleaving instead of hoping for it. A test connection holds the draft row, so the save waits
    // there; the rename queues behind it. With the old order the save then holds the draft row and wants the form row
    // while the rename holds the form row and wants the draft row: Postgres aborts one of them (40P01, a 500 for the user).
    const holder = await owner.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder.query('rollback');
      holder.release();
    };
    try {
      await holder.query('begin');
      await holder.query('select 1 from form_drafts where form_id = $1 for update', [id]);
      const holderPid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      // Sessions of this database waiting on a lock, not counting the test's own (it holds, it does not wait).
      const waiting = async (): Promise<number> =>
        Number(
          (
            await owner.query<{ n: string }>(
              `select count(*) as n from pg_stat_activity where datname = current_database() and pid <> $1 and cardinality(pg_blocking_pids(pid)) > 0`,
              [holderPid],
            )
          ).rows[0]!.n,
        );
      const until = async (n: number) => {
        for (let i = 0; i < 200 && (await waiting()) < n; i++) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(await waiting()).toBeGreaterThanOrEqual(n);
      };

      const save = putDraft(a.owner, a.id, id, def(id, 'Saved from the builder'), '1');
      await until(1);
      const rename = app.inject({ method: 'PATCH', url: `/v1/forms/${id}`, headers: asWrite(a.owner, a.id), payload: { title: 'Renamed from the list' } });
      await until(2);
      await release();

      const [saved, renamed] = await Promise.all([save, rename]);
      expect(saved.statusCode).toBe(200);
      expect(renamed.statusCode).toBe(200);
    } finally {
      await release();
    }
    // Both took effect, in the order the locks were granted: the save (revision 2), then the rename (revision 3).
    const { rows } = await owner.query<{ draft_rev: number; draft_title: string; form_title: string }>(
      `select d.draft_rev, d.draft->>'title' as draft_title, f.title as form_title from form_drafts d join forms f on f.id = d.form_id where d.form_id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ draft_rev: 3, draft_title: 'Renamed from the list', form_title: 'Renamed from the list' });
  });

  it('answers repeated saves and renames of one form that run at the same time with 200 or 409, never a 500', async () => {
    const id = await createForm(a.owner, a.id, 'Autosave while renaming');
    expect((await putDraft(a.owner, a.id, id, def(id, 'Autosave while renaming'), '0')).statusCode).toBe(200);
    const bob = await newUser(a.id, 'editor');
    for (let round = 0; round < 6; round++) {
      const { rows } = await owner.query<{ draft_rev: number }>('select draft_rev from form_drafts where form_id = $1', [id]);
      const rev = String(rows[0]!.draft_rev);
      const results = await Promise.all([
        putDraft(a.owner, a.id, id, def(id, `Save ${round}`), rev),
        app.inject({ method: 'PATCH', url: `/v1/forms/${id}`, headers: asWrite(bob, a.id), payload: { title: `Rename ${round}` } }),
        putDraft(bob, a.id, id, def(id, `Other save ${round}`), rev),
        app.inject({ method: 'PATCH', url: `/v1/forms/${id}`, headers: asWrite(a.owner, a.id), payload: { title: `Second rename ${round}` } }),
      ]);
      expect(results.map((r) => r.statusCode).filter((code) => code !== 200 && code !== 409)).toEqual([]);
      // Both renames always succeed: a rename never compares revisions.
      expect([results[1]!.statusCode, results[3]!.statusCode]).toEqual([200, 200]);
    }
  });

  it('lets a viewer read a draft, and gives the viewer an audited 403 on a write (BL-228)', async () => {
    const viewer = await newUser(a.id, 'viewer');
    const id = await createForm(a.owner, a.id, 'Viewer target');
    await putDraft(a.owner, a.id, id, def(id, 'Viewer target'), '0');
    const read = await app.inject({ url: `/v1/forms/${id}/draft`, headers: as(viewer, a.id) });
    expect(read.statusCode).toBe(200);

    const write = await putDraft(viewer, a.id, id, def(id, 'Viewer edit'), '1');
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ code: 'FORBIDDEN' });
    const { rows } = await owner.query<{ event: { actorId: string; resourceId: string; reason: string; action: string; outcome: string } }>(
      `select event from audit_pending where org_key = $1 and event->>'requestId' = $2`,
      [a.id, write.headers['x-request-id']],
    );
    expect(rows.map((r) => r.event)).toEqual([
      expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: viewer, resourceId: 'PUT /v1/forms/:id/draft', reason: 'missing_permission:forms.edit' }),
    ]);
    expect((await owner.query<{ draft_rev: number }>('select draft_rev from form_drafts where form_id = $1', [id])).rows[0]!.draft_rev).toBe(1);

    // The same member cannot rename, archive or clone either.
    for (const [method, url, payload] of [
      ['PATCH', `/v1/forms/${id}`, { title: 'Hijack' }],
      ['POST', `/v1/forms/${id}/archive`, undefined],
      ['POST', `/v1/forms/${id}/clone`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: asWrite(viewer, a.id), ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('trashes a form so the active list no longer returns it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/forms',
      headers: asWrite(a.owner, a.id),
      payload: { title: 'Throw away' },
    });
    const { id } = created.json<{ id: string }>();
    const removed = await app.inject({ method: 'DELETE', url: `/v1/forms/${id}`, headers: asWrite(a.owner, a.id) });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ id });
    const list = await app.inject({ url: '/v1/forms?lifecycle=active', headers: as(a.owner, a.id) });
    expect(list.json<{ items: { id: string }[] }>().items.some((item) => item.id === id)).toBe(false);
    const trashed = await app.inject({ url: '/v1/forms?lifecycle=trashed', headers: as(a.owner, a.id) });
    expect(trashed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(id);
  });

  it('does not leak another org’s draft', async () => {
    const res = await app.inject({ url: `/v1/forms/${a.forms[0]}/draft`, headers: as(b.owner, b.id) });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/forms: create', () => {
  it('makes the id on the server and does not touch a form whose id is sent again', async () => {
    const made = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { title: '  Spaced  ' } });
    expect(made.statusCode).toBe(200);
    const { id } = made.json<{ id: string }>();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await owner.query('select title from forms where id = $1', [id])).rows[0]).toEqual({ title: 'Spaced' });

    const again = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { id, title: 'Replaced?' } });
    expect(again.statusCode).toBe(200);
    expect((await owner.query('select title from forms where id = $1', [id])).rows[0]).toEqual({ title: 'Spaced' });
  });

  it('refuses a body it does not know (an unknown `from` must not quietly create a blank form)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { from: 'importV3', v1: {} } });
    expect(res.statusCode).toBe(400);
  });
});

/** Every text of every row of the org that could carry a password: the forms, drafts, access settings and audit events. */
async function everythingStored(org: string): Promise<string> {
  const parts = await Promise.all([
    owner.query<{ t: string }>(`select row_to_json(f)::text as t from forms f where org_id = $1`, [org]),
    owner.query<{ t: string }>(`select row_to_json(d)::text as t from form_drafts d where org_id = $1`, [org]),
    // The hash column is left out on purpose: it is the one place a secret derivative belongs. Everything else is scanned.
    owner.query<{ t: string }>(`select (to_jsonb(x) - 'password_hash')::text as t from form_access x where org_id = $1`, [org]),
    owner.query<{ t: string }>(`select event::text as t from audit_pending where org_key = $1`, [org]),
  ]);
  return parts.flatMap((p) => p.rows.map((r) => r.t)).join('\n');
}

describe('POST /v1/forms from a v1 form (BL-107)', () => {
  const PASSWORD = 'Tr0ub4dor&3-horse-staple';

  it('stores a v2 draft, hashes the password with argon2id into form_access, and leaves no password anywhere else', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/forms',
      headers: asWrite(a.owner, a.id),
      payload: { from: 'importV1', v1: v1Form({ title: 'Event signup', password: PASSWORD }) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ id: string; notes: Array<{ code: string; path: string }>; enabled: boolean; hasPassword: boolean }>();
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body).toMatchObject({ enabled: true, hasPassword: true });
    expect(body.notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'password_extracted', path: '/settings/password' })]));
    expect(res.body).not.toContain(PASSWORD);

    const { rows } = await owner.query<{ draft: Record<string, unknown>; draft_rev: number; title: string; password_hash: string; password_updated_at: Date; enabled: boolean }>(
      `select d.draft, d.draft_rev, f.title, x.password_hash, x.password_updated_at, x.enabled
         from form_drafts d join forms f on f.id = d.form_id join form_access x on x.form_id = d.form_id where d.form_id = $1`,
      [body.id],
    );
    const stored = rows[0]!;
    expect(stored).toMatchObject({ draft_rev: 1, title: 'Event signup', enabled: true });
    expect(stored.draft).toMatchObject({ schemaVersion: 2, formId: body.id, title: 'Event signup' });
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.password_updated_at).toBeInstanceOf(Date);
    expect(await verifyPassword(stored.password_hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored.password_hash, `${PASSWORD}x`)).toBe(false);

    // Deep scan: the plaintext is in no value and no key of the draft, and in nothing else the import wrote.
    const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    expect(JSON.stringify(stored.draft)).not.toContain(PASSWORD);
    expect(keys(stored.draft).filter((k) => /password/i.test(k))).toEqual([]);
    expect(await everythingStored(a.id)).not.toContain(PASSWORD);

    // The hash is not readable through the app's role at all, and no read route returns it.
    for (const url of [`/v1/forms/${body.id}`, `/v1/forms/${body.id}/draft`, '/v1/forms?limit=200']) {
      const read = await app.inject({ url, headers: as(a.owner, a.id) });
      expect(read.body, url).not.toContain('argon2');
      expect(read.body, url).not.toContain('password_hash');
    }
  });

  it('writes one form.imported audit record that says a password was hashed and carries no password', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { from: 'importV1', v1: v1Form({ password: PASSWORD, closed: true }) } });
    const { id } = res.json<{ id: string }>();
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(
      `select event from audit_pending where org_key = $1 and event->>'resourceId' = $2 and event->>'action' = 'form.imported'`,
      [a.id, id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      outcome: 'success',
      actorId: a.owner,
      formId: id,
      metadata: { passwordHashed: true, closed: true, notes: expect.any(Number) },
    });
    expect(JSON.stringify(rows[0]!.event)).not.toContain(PASSWORD);
  });

  it('maps v1 closed to enabled = false and keeps the closed message as the closed screen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/forms',
      headers: asWrite(a.owner, a.id),
      payload: { from: 'importV1', v1: v1Form({ closed: true, closedMessage: 'Sign-ups are over.' }) },
    });
    const body = res.json<{ id: string; enabled: boolean; hasPassword: boolean }>();
    expect(body).toMatchObject({ enabled: false, hasPassword: false });
    const { rows } = await owner.query<{ enabled: boolean; password_hash: string | null; screens: unknown }>('select enabled, password_hash, screens from form_access where form_id = $1', [body.id]);
    expect(rows[0]).toMatchObject({ enabled: false, password_hash: null });
    expect(JSON.stringify(rows[0]!.screens)).toContain('Sign-ups are over.');
  });

  it('reports what the migration changed as notes, including the logo it left for the asset import', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/forms',
      headers: asWrite(a.owner, a.id),
      payload: { from: 'importV1', v1: v1Form({ logoUrl: 'https://cdn.example.test/logo.png' }) },
    });
    const { notes } = res.json<{ notes: Array<{ code: string; path: string }> }>();
    expect(notes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'external_asset_queued', path: '/settings/logoUrl' })]));
  });

  it('does not use the id inside the v1 document, and a retry with the same id finds the form it made', async () => {
    const id = randomUUID();
    const first = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { from: 'importV1', id, v1: v1Form({ id: randomUUID(), password: 'first-password-1' }) } });
    expect(first.json()).toMatchObject({ id });
    const retry = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { from: 'importV1', id, v1: v1Form({ title: 'Different', password: 'second-password-2' }) } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id });
    const { rows } = await owner.query<{ title: string; password_hash: string; n: string }>(
      `select f.title, x.password_hash, (select count(*) from forms where id = $1) as n from forms f join form_access x on x.form_id = f.id where f.id = $1`,
      [id],
    );
    expect(rows[0]!.n).toBe('1');
    expect(rows[0]!.title).toBe('Event signup');
    expect(await verifyPassword(rows[0]!.password_hash, 'first-password-1')).toBe(true);
    expect(await verifyPassword(rows[0]!.password_hash, 'second-password-2')).toBe(false);
  });

  it('refuses something that is not a v1 form with a 422 and stores nothing', async () => {
    const before = (await owner.query<{ n: string }>('select count(*) as n from forms where org_id = $1', [a.id])).rows[0]!.n;
    for (const v1 of [{ nonsense: true }, 'text', null, []]) {
      const res = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { from: 'importV1', v1 } });
      expect(res.statusCode, JSON.stringify(v1)).toBe(422);
      expect(res.json()).toMatchObject({ code: 'IMPORT_INVALID' });
    }
    // No `v1` key at all is a malformed request, not a form that could not be read.
    expect((await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(a.owner, a.id), payload: { from: 'importV1' } })).statusCode).toBe(400);
    expect((await owner.query<{ n: string }>('select count(*) as n from forms where org_id = $1', [a.id])).rows[0]!.n).toBe(before);
  });

  it('needs forms.create: a viewer is refused, audited, and nothing is stored', async () => {
    const viewer = await newUser(a.id, 'viewer');
    const res = await app.inject({ method: 'POST', url: '/v1/forms', headers: asWrite(viewer, a.id), payload: { from: 'importV1', v1: v1Form({ password: PASSWORD }) } });
    expect(res.statusCode).toBe(403);
    expect((await pending(a.id)).at(-1)).toMatchObject({ action: 'request.authorize', outcome: 'denied', reason: 'missing_permission:forms.create' });
    expect(await everythingStored(a.id)).not.toContain(PASSWORD);
  });
});
