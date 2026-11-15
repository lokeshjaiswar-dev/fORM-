import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { PLATFORM_ORG_KEY, provision, type MembershipRole } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { createFileStore } from '../src/files.ts';
import { SESSION_COOKIE } from '../src/modules/auth/index.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import {
  collect,
  coverage,
  ISOLATION_CASES,
  ISOLATION_SEEDS,
  seedCore,
  type Actor,
  type AuditExpect,
  type Call,
  type CollectedRoute,
  type Fixture,
  type IsolationCase,
  type Method,
  type Res,
  type SeedEnv,
} from './isolation-cases/index.ts';
import { ISOLATION_STORAGE } from './isolation-cases/exports.ts';

/*
 * The cross-org isolation suite for the API (WP-1.06: "every endpoint in the RLS suite"; the table-level suite is
 * packages/db/test/rls.int.test.ts). Every route that needs a signed-in caller (`auth: 'user'` or `'account'`) has a case
 * in test/isolation-cases/, and a route without one fails the first test below. A case runs as a member of org B:
 *
 * 1. naming org B, aimed at org A's ids: org A's rows must look as if they do not exist (404, or an answer that holds
 *    none of org A's data) and none of them may change;
 * 2. naming org A (`auth: 'user'` routes): 403, and the refusal is on the audit record.
 *
 * Org A's rows are compared with their state before any case ran, through the migrator handle, after every case.
 */

const BUILDER = 'https://app.form.test';
/** What the builder's fetch sends on every unsafe request (ADR-0008). */
const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const EXTRA_USER = 'GET /v1/test-only/user-route-without-a-case';
const EXTRA_DEFAULT = 'GET /v1/test-only/route-with-no-auth-setting';
const EXTRA_PUBLIC = 'GET /v1/test-only/public-route';

interface LiveActor extends Actor {
  token: string;
}

let app: FastifyInstance;
let owner: pg.Pool;
let filesDir: string;
let fixture: Fixture;
let baseline: Record<string, string>;
const routes: CollectedRoute[] = [];

const sha256 = (text: string) => createHash('sha256').update(text).digest();

function seedEnv(): SeedEnv {
  return {
    app,
    owner,
    as: (userId, orgId, method, url, body) =>
      app.inject({
        method,
        url,
        headers: { 'x-fr-dev-user': userId, 'x-fr-org': orgId, ...BROWSER },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      }),
  };
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_isolation');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  filesDir = await mkdtemp(path.join(tmpdir(), 'fr-isolation-'));
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    LOG_LEVEL: 'silent',
    PUBLIC_BUILDER_URL: BUILDER,
    // The log mailer is what lets an admin hand a member a one-time link (members/:userId/access-link).
    MAILER_DRIVER: 'log',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const keys = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
  app = await buildApp(parsed.config, {
    underPressure: false,
    files: createFileStore(filesDir),
    keys,
    // The org email senders seal their SMTP URL under the org's key (WP-1.16), so their cases can reach the database.
    orgSecrets: createOrgSecrets(keys),
    // The export routes answer 503 without an object store; the exports cases put org A's finished file in this one.
    storage: ISOLATION_STORAGE,
    // Dozens of auth requests from one address in a minute are the point of this suite, not an attack.
    authLimits: { auth_any: { max: 100_000, windowSeconds: 60 } },
    onRoute: (route) => collect(routes, route),
  });
  // Routes only this file registers, to prove the guard: one a signed-in member uses and nothing covers, one that forgot
  // to say who may call it (which is `user`, not public), and one that is public on purpose.
  app.get(EXTRA_USER.slice(4), { config: { auth: 'user', perm: 'forms.read' } }, async () => ({ ok: true }));
  app.get(EXTRA_DEFAULT.slice(4), async () => ({ ok: true }));
  app.get(EXTRA_PUBLIC.slice(4), { config: { auth: 'none' } }, async () => ({ ok: true }));

  fixture = await seedCore(seedEnv());
  for (const seed of ISOLATION_SEEDS) {
    const extra = await seed(seedEnv(), fixture);
    Object.assign(fixture.extra, extra);
    fixture.secrets.push(...Object.values(extra));
  }
  baseline = await snapshotOrgA();
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  if (filesDir) await rm(filesDir, { recursive: true, force: true });
});

/**
 * Org A's rows, as a hash per table: every table with an `org_id` column (so a table a later work package adds is
 * covered without touching this file), the tables keyed by user id for org A's users (sessions, grievances, notice
 * acknowledgements, …), and the org and user rows themselves. The audit tables are left out: a refusal is supposed to
 * add to them, and the audit checks below read them.
 */
async function snapshotOrgA(db: Pick<pg.Pool, 'query'> = owner): Promise<Record<string, string>> {
  const a = fixture.a;
  const users = [a.ownerId, a.memberId];
  const tables = async (column: string) =>
    (
      await db.query<{ t: string }>(
        `select c.table_name as t
           from information_schema.columns c
           join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
          where c.table_schema = 'public' and x.table_type = 'BASE TABLE' and c.column_name = $1 and c.table_name not like 'audit\\_%'
          order by 1`,
        [column],
      )
    ).rows.map((r) => r.t);
  const hash = async (table: string, where: string, arg: unknown) => {
    const { rows } = await db.query<{ n: number; h: string }>(
      `select count(*)::int as n, md5(coalesce(string_agg(r::text, E'\\n' order by r::text), '')) as h from "${table}" r where ${where}`,
      [arg],
    );
    return `${rows[0]!.n} rows, ${rows[0]!.h}`;
  };
  const out: Record<string, string> = {};
  for (const t of await tables('org_id')) out[`${t} by org`] = await hash(t, 'r.org_id::text = $1', a.orgId);
  for (const t of await tables('user_id')) out[`${t} by user`] = await hash(t, 'r.user_id::text = any($1::text[])', users);
  out['orgs'] = await hash('orgs', 'r.id::text = $1', a.orgId);
  out['users'] = await hash('users', 'r.id::text = any($1::text[])', users);
  return out;
}

/** A fresh member of org B with a live session, so one case cannot spend or delete what the next one needs. */
async function newActor(role: MembershipRole): Promise<LiveActor> {
  const id = randomUUID();
  const email = `actor-${id.slice(0, 8)}@iso-b.test`;
  const sessionId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await owner.query('insert into users (id, email, email_norm, name, email_verified_at) values ($1, $2, $2, $3, now())', [id, email, 'Org B member']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [fixture.b.orgId, id, role]);
  await owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at) values ($1, $2, $3, 'pwd', now() + interval '1 hour', now() + interval '1 day')`,
    [sessionId, sha256(token), id],
  );
  return { id, email, orgId: fixture.b.orgId, sessionId, token };
}

function send(actor: LiveActor, c: IsolationCase, call: Call, org: string | null): Promise<Res> {
  const method = c.route.split(' ')[0] as Method;
  return app.inject({
    method,
    url: call.url,
    headers: { cookie: `${SESSION_COOKIE}=${actor.token}`, ...(method === 'GET' ? {} : BROWSER), ...(org ? { 'x-fr-org': org } : {}), ...call.headers },
    ...(call.body === undefined ? {} : { payload: call.body as Record<string, unknown> }),
  });
}

/** Org A's identifiers that the answer carries although the request did not name them. */
function leaked(res: Res, call: Call): string[] {
  const sent = `${call.url} ${JSON.stringify(call.body ?? null)}`;
  let body = res.body;
  if (res.statusCode >= 400) {
    // A problem names the address that was asked for (`instance`); the rest of it must not carry anything of org A's.
    try {
      const problem = res.json<Record<string, unknown>>();
      delete problem.instance;
      body = JSON.stringify(problem);
    } catch {
      /* Not JSON: scan it whole. */
    }
  }
  return fixture.secrets.filter((s) => !sent.includes(s) && body.includes(s));
}

/** The not-found handler's answer for an address that matches no route: a mistyped case URL would pass for a 404 otherwise. */
function notFoundFromNoRoute(res: Res): boolean {
  return res.statusCode === 404 && /^No route for /.test(res.json<{ detail?: string }>().detail ?? '');
}

/** The audit event the request left, found by its id: `audit_pending` holds it until `audit.chain` runs. */
async function expectAudit(res: Res, want: AuditExpect, actor: Actor): Promise<void> {
  const orgKey = want.orgKey === 'a' ? fixture.a.orgId : PLATFORM_ORG_KEY;
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [
    orgKey,
    res.headers['x-request-id'],
  ]);
  expect(rows.map((r) => r.event), `audit events of request ${String(res.headers['x-request-id'])}`).toEqual([
    expect.objectContaining({
      action: want.action,
      outcome: want.outcome,
      actorId: actor.id,
      ...(want.reason ? { reason: want.reason } : {}),
      ...(want.metadata ? { metadata: expect.objectContaining(want.metadata) } : {}),
    }),
  ]);
}

describe('the isolation cases cover the routes', () => {
  it('has a case for every auth:user and auth:account route, none stale and none twice', () => {
    const { missing, stale, duplicate } = coverage(routes, ISOLATION_CASES);
    expect(missing.filter((key) => !key.includes('/v1/test-only/')), 'routes without a case: add one to test/isolation-cases/').toEqual([]);
    expect(stale, 'cases for routes that are not registered').toEqual([]);
    expect(duplicate, 'routes with two cases').toEqual([]);
  });

  it('fails for an extra auth:user route that has no case, and for one that sets no auth at all', () => {
    const { missing } = coverage(routes, ISOLATION_CASES);
    expect(missing.filter((key) => key.includes('/v1/test-only/')).sort()).toEqual([EXTRA_DEFAULT, EXTRA_USER].sort());
    // A public route is reviewed on its own (CONTRIBUTING §5), so it needs no case here.
    expect(missing).not.toContain(EXTRA_PUBLIC);
    expect(routes.map((r) => r.key)).toContain(EXTRA_PUBLIC);
  });

  it('knows the seeded fixture', () => {
    expect(fixture.a.orgId).not.toBe(fixture.b.orgId);
    expect(Object.keys(baseline)).toEqual(expect.arrayContaining(['forms by org', 'form_drafts by org', 'form_versions by org', 'memberships by org', 'invites by org', 'sessions by user', 'orgs', 'users']));
  });
});

describe('the checks themselves', () => {
  it('see a change to org A’s rows (rolled back, so the baseline stays true)', async () => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query(`update forms set title = title || ' (changed)' where id = $1`, [fixture.a.formId]);
      const changed = await snapshotOrgA(client);
      await client.query('rollback');
      expect(changed['forms by org']).not.toBe(baseline['forms by org']);
      expect({ ...changed, 'forms by org': baseline['forms by org'] }).toEqual(baseline);
    } finally {
      client.release();
    }
  });

  it('see an org A identifier in an answer, unless the request itself named it', () => {
    const body = JSON.stringify({ id: fixture.a.formId, note: fixture.a.ownerEmail });
    const answer = { statusCode: 200, body } as Res;
    expect(leaked(answer, { url: '/v1/forms' }).sort()).toEqual([fixture.a.formId, fixture.a.ownerEmail].sort());
    expect(leaked(answer, { url: `/v1/forms/${fixture.a.formId}`, body: { email: fixture.a.ownerEmail } })).toEqual([]);
    // A problem may name the address that was asked for, but nothing else of org A's.
    const problem = { statusCode: 404, body: JSON.stringify({ instance: `/v1/forms/${fixture.a.formId}`, detail: fixture.a.formTitle }), json: () => ({ instance: `/v1/forms/${fixture.a.formId}`, detail: fixture.a.formTitle }) } as unknown as Res;
    expect(leaked(problem, { url: '/v1/forms' })).toEqual([fixture.a.formTitle]);
  });

  it('aim every read case at rows that exist: org A’s own owner gets 200 for the same request', async () => {
    const reads = ISOLATION_CASES.filter((c) => c.route.startsWith('GET ') && (c.own ?? { status: 404 }).status === 404);
    expect(reads.length).toBeGreaterThan(3);
    for (const c of reads) {
      const call = c.call(fixture, { id: fixture.a.ownerId, email: fixture.a.ownerEmail, orgId: fixture.a.orgId, sessionId: fixture.a.sessionId });
      const res = await seedEnv().as(fixture.a.ownerId, fixture.a.orgId, 'GET', call.url);
      expect(res.statusCode, `${c.route}: ${res.body}`).toBe(200);
    }
    expect(await snapshotOrgA(), 'org A rows after the reads').toEqual(baseline);
  });
});

/** What a case expects of its own request: the status and problem code, nothing of org A's in the answer, org A unchanged. */
async function expectOwn(c: IsolationCase, actor: Actor, call: Call, res: Res): Promise<void> {
  const want = c.own ?? { status: 404 };
  expect(res.statusCode, res.body).toBe(want.status);
  if (want.code) expect(res.json<{ code: string }>().code).toBe(want.code);
  expect(notFoundFromNoRoute(res), 'the 404 must come from the route, not from a URL that matches none').toBe(false);
  expect(leaked(res, call), 'org A identifiers in the answer').toEqual([]);
  await want.check?.(res, fixture, actor);
  if (want.audit) await expectAudit(res, typeof want.audit === 'function' ? want.audit(fixture, actor) : want.audit, actor);
  expect(await snapshotOrgA(), 'org A rows after the request').toEqual(baseline);
}

describe('an org B member against org A', () => {
  for (const c of ISOLATION_CASES) {
    describe(c.route, () => {
      it('naming org B: org A’s rows look as if they do not exist, and none change', async () => {
        const actor = await newActor(c.role ?? 'owner');
        const call = c.call(fixture, actor);
        await expectOwn(c, actor, call, await send(actor, c, call, actor.orgId));
      });

      it('naming org A: a user route answers 403 and audits it; an account route ignores the header', async () => {
        const actor = await newActor(c.role ?? 'owner');
        const call = c.call(fixture, actor);
        const res = await send(actor, c, call, fixture.a.orgId);
        if (routes.find((r) => r.key === c.route)?.auth !== 'user') {
          // An `account` route acts for the signed-in user and names no org, so a header naming org A changes nothing:
          // the answer is the one it gives without it (and where the route takes an org itself, its case checks that).
          await expectOwn(c, actor, call, res);
          return;
        }
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
        expect(leaked(res, call), 'org A identifiers in the answer').toEqual([]);
        await expectAudit(res, { orgKey: 'platform', action: 'request.authorize', outcome: 'denied', reason: 'not_a_member', metadata: { claimedOrgId: fixture.a.orgId } }, actor);
        expect(await snapshotOrgA(), 'org A rows after the request').toEqual(baseline);
      });
    });
  }
});
