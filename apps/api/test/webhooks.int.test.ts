import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createTenantEgressGuard, type EgressResolver } from '@form/adapters/egress';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { parseEditionConfig } from '@form/config';
import { newSubmissionKey, provision } from '@form/db';
import type { JobName, JobRequest, OrgSecrets, Queue, SendOptions } from '@form/ports';
import type { FormDefinition } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp, type AppDeps } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock } from './publishable-draft.ts';

/*
 * WP-1.18 webhooks API: /v1/forms/:formId/webhooks. Who may use it (data.route), the purposes a webhook must declare, the
 * save-time SSRF check under each EGRESS_POLICY (the real tenant egress guard, with a fake resolver), the signing secret
 * (shown once, sealed under the org's key, never read back), revisions (If-Match), the delivery log and the replay (a new
 * row and one `webhook.deliver` job in one transaction), and org isolation. The cross-org cases of every route are also in
 * the isolation suite (`isolation-cases/webhooks.ts`).
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface WebhookJson {
  id: string;
  formId: string;
  url: string;
  enabled: boolean;
  events: string[];
  keyBy: string;
  fieldKeys: string[] | 'all_in_purposes';
  purposeIds: string[];
  files: string;
  bodyFormat: string;
  payloadMapping: { root?: string; entries: Array<{ path: string; source: Record<string, string> }> } | null;
  secretHint: string;
  secretRotatedAt: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
}
interface Created extends WebhookJson {
  secret: string;
}
interface DeliveryJson {
  id: string;
  webhookId: string;
  event: string;
  submissionId: string | null;
  status: string;
  attempt: number;
  httpStatus: number | null;
  durationMs: number | null;
  responseSnippet: string | null;
  replayOf: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

let owner: pg.Pool;
let orgSecrets: OrgSecrets;
const apps: FastifyInstance[] = [];
/** SaaS: `EGRESS_POLICY=open`. The app most tests use. */
let open: FastifyInstance;
/** On-prem with an allowlist: http or https, to a listed host only. */
let allowlist: FastifyInstance;
/** Air-gapped: `EGRESS_POLICY=none`. */
let none: FastifyInstance;
/** An app that was given no key provider, egress guard or queue (a deployment that has not wired the webhooks). */
let bare: FastifyInstance;
let orgId: string;
let otherOrgId: string;
const user = {
  owner: randomUUID(),
  admin: randomUUID(),
  editor: randomUUID(),
  creator: randomUUID(),
  dataCollaborator: randomUUID(),
  viewer: randomUUID(),
  otherOwner: randomUUID(),
};

/** A queue that records what was sent, and what the database showed at that moment, from inside the transaction and from outside it. */
interface Sent {
  name: JobName;
  job: JobRequest<JobName>;
  options: SendOptions | undefined;
  /** Rows of the delivery the job names, as seen through the transaction the job was sent on. */
  insideTx: number;
  /** The same count through another connection: 0 until the transaction commits. */
  outsideTx: number;
}
let sent: Sent[];
let queueMode: 'ok' | 'none';

const fakeQueue = {
  async send(name: JobName, job: JobRequest<JobName>, options?: SendOptions): Promise<string | null> {
    if (queueMode === 'none') return null;
    const id = (job.data as { deliveryId: string }).deliveryId;
    const count = async (run: () => Promise<{ rows: unknown[] }>) => Number((((await run()).rows[0] ?? {}) as { n?: number }).n);
    const insideTx = options?.tx ? await count(() => options.tx!.executeSql('select count(*)::int as n from webhook_deliveries where id = $1', [id])) : -1;
    const outsideTx = await count(() => owner.query('select count(*)::int as n from webhook_deliveries where id = $1', [id]));
    sent.push({ name, job, options, insideTx, outsideTx });
    return `job-${sent.length}`;
  },
  work: async () => ({ stop: async () => {} }),
  schedule: async () => {},
  unschedule: async () => {},
} as unknown as Queue;

/** Names the fake resolver knows: a public address, a private one, and the link-local metadata address. */
const DNS: Record<string, string> = {
  'hooks.example.test': '93.184.216.34',
  'other.example.test': '93.184.216.35',
  'internal.example.test': '10.0.0.9',
  'metadata.example.test': '169.254.169.254',
  'hooks.corp.test': '10.1.2.3',
};
const resolver: EgressResolver = async (host) => {
  const address = DNS[host];
  if (!address) throw new Error(`ENOTFOUND ${host}`);
  return [{ address, family: 4 }];
};

async function startApp(urls: { fr_app: string }, env: Record<string, string>, deps: Partial<AppDeps>): Promise<FastifyInstance> {
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    AUTH_SECRET: Buffer.alloc(32, 9).toString('base64url'),
    LOG_LEVEL: 'silent',
    ...env,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const app = await buildApp(parsed.config, { underPressure: false, ...deps });
  apps.push(app);
  return app;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_webhooks');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 4 });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'hooks-a', otherOrgId, 'hooks-b']);
  const members: Array<[string, string, string]> = [
    [user.owner, 'owner', orgId],
    [user.admin, 'admin', orgId],
    [user.editor, 'editor', orgId],
    [user.creator, 'creator', orgId],
    [user.dataCollaborator, 'data_collaborator', orgId],
    [user.viewer, 'viewer', orgId],
    [user.otherOwner, 'owner', otherOrgId],
  ];
  for (const [id, role, org] of members) {
    await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, `${role}-${id.slice(0, 8)}@hooks.test`]);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
  }
  // What `main.ts` builds: the org secrets sealer over the KMS, and the tenant egress guard of the config's edition.
  orgSecrets = createOrgSecrets(createKeyfileKeyProvider({ masterKey: randomBytes(32) }));
  const wired = (env: Record<string, string>): Partial<AppDeps> => {
    const edition = parseEditionConfig(env);
    if (!edition.ok) throw new Error(edition.errors.join('\n'));
    return { orgSecrets, queue: fakeQueue, tenantEgress: createTenantEgressGuard(edition.config, resolver) };
  };
  const saas = { DEPLOYMENT_MODE: 'saas' };
  const listed = { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'allowlist', EGRESS_ALLOWLIST: 'hooks.corp.test' };
  const airGapped = { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none', EGRESS_ALLOWLIST: 'hooks.corp.test' };
  open = await startApp(urls, saas, wired(saas));
  allowlist = await startApp(urls, listed, wired(listed));
  none = await startApp(urls, airGapped, wired(airGapped));
  bare = await startApp(urls, saas, {});
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await owner?.end();
});

beforeEach(() => {
  sent = [];
  queueMode = 'ok';
});

interface CallOptions {
  as?: string;
  org?: string;
  body?: unknown;
  ifMatch?: string;
  app?: FastifyInstance;
}

async function call(method: Method, url: string, o: CallOptions = {}) {
  return (o.app ?? open).inject({
    method,
    url,
    headers: { 'x-fr-dev-user': o.as ?? user.owner, 'x-fr-org': o.org ?? orgId, ...BROWSER, ...(o.ifMatch === undefined ? {} : { 'if-match': o.ifMatch }) },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
  });
}

/** A form of org A (or `org`'s) whose draft declares the purposes `pur_1` and `pur_2`. */
async function newForm(o: { as?: string; org?: string; purposes?: boolean } = {}): Promise<string> {
  const ctx = { ...(o.as ? { as: o.as } : {}), ...(o.org ? { org: o.org } : {}) };
  const created = await call('POST', '/v1/forms', { ...ctx, body: { title: 'Hooked form' } });
  expect(created.statusCode, created.body).toBe(200);
  const { id } = created.json<{ id: string }>();
  const base = draftWith(id, [fieldBlock('name', 'short_text')], 'Hooked form');
  const first = base.privacy.purposes[0]!;
  const draft = { ...base, privacy: { ...base.privacy, purposes: o.purposes === false ? [] : [first, { ...first, id: 'pur_2', name: 'Follow up' }] } } as unknown as FormDefinition;
  const saved = await call('PUT', `/v1/forms/${id}/draft`, { ...ctx, ifMatch: '0', body: { draft } });
  expect(saved.statusCode, saved.body).toBe(200);
  return id;
}

const HOOK = 'https://hooks.example.test/in?token=abc123';
const hook = (o: Record<string, unknown> = {}) => ({ url: HOOK, events: ['submission.created'], purposeIds: ['pur_1'], ...o });
const base = (formId: string) => `/v1/forms/${formId}/webhooks`;

async function create(formId: string, body: Record<string, unknown> = hook(), o: CallOptions = {}): Promise<Created> {
  const res = await call('POST', base(formId), { ...o, body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Created>();
}

const countOf = async (sql: string, args: unknown[]): Promise<number> => Number((await owner.query<{ n: number }>(sql, args)).rows[0]!.n);
const webhookRows = (formId: string) => countOf('select count(*)::int as n from webhooks where form_id = $1', [formId]);
const secretRows = () => countOf(`select count(*)::int as n from secrets where kind = 'webhook_hmac'`, []);

/** The audit events an action left in an org's pending log for one form, oldest first (the chain worker does not run in these tests). */
async function auditEvents(orgKey: string, action: string, formId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = $2 and event->>'formId' = $3 order by id`, [
    orgKey,
    action,
    formId,
  ]);
  return rows.map((r) => r.event);
}

/** What a request left on the record under its id (a refusal is filed by the error handler, with the request's id). */
async function auditOf(requestId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where event->>'requestId' = $1 order by id`, [requestId]);
  return rows.map((r) => r.event);
}

/** Inserts a delivery through the migrator handle (the worker's job), `ageSeconds` after now so rows have an order and a partition. */
async function seedDelivery(
  webhookId: string,
  o: { status?: string; event?: string; httpStatus?: number | null; snippet?: string | null; offsetSeconds?: number; submission?: boolean; replayOf?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const withSubmission = o.submission ?? true;
  await owner.query(
    `insert into webhook_deliveries (id, org_id, webhook_id, event, submission_id, submission_received_at, status, http_status, duration_ms, attempt, response_snippet, replay_of, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 120, 3, $9, $10, now() + ($11 || ' seconds')::interval)`,
    [
      id,
      orgId,
      webhookId,
      o.event ?? 'submission.created',
      withSubmission ? randomUUID() : null,
      withSubmission ? new Date().toISOString() : null,
      o.status ?? 'failed',
      o.httpStatus === undefined ? 500 : o.httpStatus,
      o.snippet === undefined ? 'upstream said no' : o.snippet,
      o.replayOf ?? null,
      String(o.offsetSeconds ?? 0),
    ],
  );
  return id;
}

describe('who may use the webhook routes (data.route)', () => {
  it('refuses a creator, a viewer and an outsider on GET, POST and replay with a 403 and a request.authorize denied record, and an editor succeeds', async () => {
    const formId = await newForm();
    const existing = await create(formId);
    const deliveryId = await seedDelivery(existing.id);
    const calls: Array<{ label: string; method: Method; url: string; body?: unknown }> = [
      { label: 'GET list', method: 'GET', url: base(formId) },
      { label: 'POST create', method: 'POST', url: base(formId), body: hook() },
      { label: 'replay', method: 'POST', url: `${base(formId)}/${existing.id}/deliveries/${deliveryId}/replay` },
    ];
    for (const who of ['creator', 'viewer'] as const) {
      for (const c of calls) {
        const res = await call(c.method, c.url, { as: user[who], ...(c.body === undefined ? {} : { body: c.body }) });
        expect(res.statusCode, `${who} ${c.label}: ${res.body}`).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
        expect(await auditOf(String(res.headers['x-request-id'])), `${who} ${c.label}`).toEqual([
          expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user[who], reason: 'missing_permission:data.route' }),
        ]);
      }
    }
    // Nothing the refused calls could have written is there: one webhook, one delivery, no job.
    expect(await webhookRows(formId)).toBe(1);
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [existing.id])).toBe(1);
    expect(sent).toEqual([]);

    // Every role that has data.route gets through, on the same three calls.
    for (const who of ['editor', 'dataCollaborator', 'admin', 'owner'] as const) {
      expect((await call('GET', base(formId), { as: user[who] })).statusCode, `${who} list`).toBe(200);
      const made = await call('POST', base(formId), { as: user[who], body: hook() });
      expect(made.statusCode, `${who} create: ${made.body}`).toBe(201);
      const replayed = await call('POST', `${base(formId)}/${existing.id}/deliveries/${deliveryId}/replay`, { as: user[who] });
      expect(replayed.statusCode, `${who} replay: ${replayed.body}`).toBe(201);
    }
    expect(sent).toHaveLength(4);
  });

  it('refuses every other route to a creator too, and writes nothing', async () => {
    const formId = await newForm();
    const existing = await create(formId);
    const urls: Array<[Method, string, unknown?]> = [
      ['GET', `${base(formId)}/${existing.id}`],
      ['PUT', `${base(formId)}/${existing.id}`, hook()],
      ['DELETE', `${base(formId)}/${existing.id}`],
      ['POST', `${base(formId)}/${existing.id}/rotate-secret`],
      ['GET', `${base(formId)}/${existing.id}/deliveries`],
    ];
    for (const [method, url, body] of urls) {
      const res = await call(method, url, { as: user.creator, ifMatch: '1', ...(body === undefined ? {} : { body }) });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
    }
    expect(await webhookRows(formId)).toBe(1);
    expect((await owner.query('select rev, rotated_at from webhooks w join secrets s on s.id = w.secret_id where w.id = $1', [existing.id])).rows[0]).toMatchObject({ rev: 1, rotated_at: null });
  });

  it('is a 403 for a member of another org who names this org, and answers 404 for this org’s form when they name their own', async () => {
    const formId = await newForm();
    const forged = await call('GET', base(formId), { as: user.otherOwner, org: orgId });
    expect(forged.statusCode).toBe(403);
    const own = await call('GET', base(formId), { as: user.otherOwner, org: otherOrgId });
    expect(own.statusCode).toBe(404);
  });
});

describe('purposes: a webhook must name purposes its form declares', () => {
  it('answers 422 MISSING_PURPOSE for [] and for a purpose the draft does not declare, and writes no webhook and no secret', async () => {
    const formId = await newForm();
    const secretsBefore = await secretRows();
    for (const purposeIds of [[], ['pur_unknown'], ['pur_1', 'pur_unknown']]) {
      const res = await call('POST', base(formId), { body: hook({ purposeIds }) });
      expect(res.statusCode, `${JSON.stringify(purposeIds)}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'MISSING_PURPOSE', status: 422 });
    }
    expect(await webhookRows(formId)).toBe(0);
    expect(await secretRows()).toBe(secretsBefore);
    expect(await auditEvents(orgId, 'webhook.saved', formId)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('accepts the purposes the draft declares, in any number, once each', async () => {
    const formId = await newForm();
    const made = await create(formId, hook({ purposeIds: ['pur_2', 'pur_1', 'pur_2'] }));
    expect(made.purposeIds).toEqual(['pur_2', 'pur_1']);
    expect((await owner.query('select purpose_ids from webhooks where id = $1', [made.id])).rows[0]).toEqual({ purpose_ids: ['pur_2', 'pur_1'] });
  });

  it('refuses every purpose of a form whose draft declares none', async () => {
    const formId = await newForm({ purposes: false });
    const res = await call('POST', base(formId), { body: hook({ purposeIds: ['pur_1'] }) });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'MISSING_PURPOSE' });
    expect(await webhookRows(formId)).toBe(0);
  });

  it('checks a save the same way and leaves the stored webhook as it was', async () => {
    const formId = await newForm();
    const made = await create(formId);
    for (const purposeIds of [[], ['pur_unknown']]) {
      const res = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ purposeIds }) });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'MISSING_PURPOSE' });
    }
    expect((await owner.query('select rev, purpose_ids from webhooks where id = $1', [made.id])).rows[0]).toEqual({ rev: 1, purpose_ids: ['pur_1'] });
  });
});

describe('the save-time SSRF check (EGRESS_POLICY)', () => {
  it('refuses the cloud metadata address, a private address and any http:// URL under EGRESS_POLICY=open with 422 EGRESS_DENIED, and writes nothing', async () => {
    const formId = await newForm();
    const secretsBefore = await secretRows();
    const urls = [
      'http://169.254.169.254/latest/meta-data',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/hook',
      'https://127.0.0.1/hook',
      'https://2130706433/hook',
      // A name that points inside: the guard resolves it and refuses what it finds.
      'https://internal.example.test/hook',
      'https://metadata.example.test/hook',
      // A public host over plain http: the scheme is not allowed on SaaS whatever the address.
      'http://hooks.example.test/hook',
      // A name that does not resolve cannot be sent to.
      'https://nowhere.example.test/hook',
    ];
    for (const url of urls) {
      const res = await call('POST', base(formId), { body: hook({ url }) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
      expect(res.json(), url).toMatchObject({ code: 'EGRESS_DENIED', status: 422 });
    }
    expect(await webhookRows(formId)).toBe(0);
    expect(await secretRows()).toBe(secretsBefore);
  });

  it('does not say what a name resolved to', async () => {
    const formId = await newForm();
    const res = await call('POST', base(formId), { body: hook({ url: 'https://internal.example.test/hook' }) });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain('10.0.0.9');
  });

  it('accepts a public https address, and checks it again on every save', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const moved = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ url: 'https://other.example.test/in' }) });
    expect(moved.statusCode, moved.body).toBe(200);
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://10.0.0.5/hook', 'http://other.example.test/in']) {
      const res = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '2', body: hook({ url }) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'EGRESS_DENIED' });
    }
    expect((await owner.query('select url, rev from webhooks where id = $1', [made.id])).rows[0]).toEqual({ url: 'https://other.example.test/in', rev: 2 });
  });

  it('allows http and https under EGRESS_POLICY=allowlist for a listed host only, and refuses the metadata address even if it is listed', async () => {
    const formId = await newForm();
    for (const url of ['http://hooks.corp.test/hook', 'https://hooks.corp.test/hook']) {
      const res = await call('POST', base(formId), { app: allowlist, body: hook({ url }) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(201);
    }
    for (const url of ['http://hooks.example.test/hook', 'https://other.example.test/hook', 'http://169.254.169.254/latest/meta-data']) {
      const res = await call('POST', base(formId), { app: allowlist, body: hook({ url }) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'EGRESS_DENIED' });
    }
    expect(await webhookRows(formId)).toBe(2);
  });

  it('refuses every URL under EGRESS_POLICY=none, a listed host included', async () => {
    const formId = await newForm();
    for (const url of ['https://hooks.corp.test/hook', 'http://hooks.corp.test/hook', 'https://hooks.example.test/hook']) {
      const res = await call('POST', base(formId), { app: none, body: hook({ url }) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({ code: 'EGRESS_DENIED' });
    }
    expect(await webhookRows(formId)).toBe(0);
  });

  it('answers 503, not a guess, when the deployment has no egress guard, key provider or queue, but 404 for another org’s ids first', async () => {
    const formId = await newForm();
    const unwired = await call('POST', base(formId), { app: bare, body: hook() });
    expect(unwired.statusCode).toBe(503);
    expect(await webhookRows(formId)).toBe(0);
    // The database is asked before the deployment: org B learns nothing about org A's forms from which half is missing.
    expect((await call('POST', base(formId), { app: bare, as: user.otherOwner, org: otherOrgId, body: hook() })).statusCode).toBe(404);

    const made = await create(formId);
    const deliveryId = await seedDelivery(made.id);
    expect((await call('POST', `${base(formId)}/${made.id}/rotate-secret`, { app: bare })).statusCode).toBe(503);
    const replay = await call('POST', `${base(formId)}/${made.id}/deliveries/${deliveryId}/replay`, { app: bare });
    expect(replay.statusCode).toBe(503);
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [made.id])).toBe(1);
    expect((await call('POST', `${base(formId)}/${made.id}/deliveries/${randomUUID()}/replay`, { app: bare })).statusCode).toBe(404);
  });
});

describe('the signing secret', () => {
  it('is returned once by create, never by a read, and is sealed under the org’s key (the stored value holds none of it)', async () => {
    const formId = await newForm();
    const made = await create(formId);
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.secretHint).toBe(made.secret.slice(-4));
    const key = made.secret.slice('whsec_'.length);

    // Every read of the webhook leaves it out.
    const reads = [
      await call('GET', base(formId)),
      await call('GET', `${base(formId)}/${made.id}`),
      await call('GET', `${base(formId)}/${made.id}/deliveries`),
      await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ enabled: false }) }),
    ];
    for (const res of reads) {
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain(key);
      expect(res.body).not.toContain('whsec_');
      expect(res.body).not.toContain('"secret"');
    }
    expect((await call('GET', `${base(formId)}/${made.id}`)).json()).toMatchObject({ secretHint: made.secretHint, secretRotatedAt: null });
    expect(made.rev).toBe(1);

    // At rest: a webhook_hmac row of this org, with the last four characters and an envelope in which the key is nowhere.
    const { rows } = await owner.query<{ secret_id: string }>('select secret_id from webhooks where id = $1', [made.id]);
    const secretId = rows[0]!.secret_id;
    const stored = (await owner.query<{ enc: Record<string, unknown>; meta: Record<string, unknown>; kind: string; org_id: string }>('select enc, meta, kind, org_id from secrets where id = $1', [secretId])).rows[0]!;
    expect(stored).toMatchObject({ kind: 'webhook_hmac', org_id: orgId, meta: { last4: made.secretHint } });
    const text = JSON.stringify(stored.enc);
    expect(text).not.toContain(key);
    expect(text).not.toContain(Buffer.from(key, 'base64url').toString('hex'));
    expect(text).not.toContain(Buffer.from(key, 'base64url').toString('base64'));
    expect(JSON.stringify(stored.meta)).not.toContain(key);
    // The sealed bytes are the 32 key bytes that the secret text encodes, and they open for this org, row and kind only.
    const opened = await orgSecrets.open({ orgId, secretId, kind: 'webhook_hmac' }, stored.enc);
    expect(Buffer.from(opened).toString('base64url')).toBe(key);
    expect(opened).toHaveLength(32);
    await expect(orgSecrets.open({ orgId: otherOrgId, secretId, kind: 'webhook_hmac' }, stored.enc)).rejects.toThrow();
    await expect(orgSecrets.open({ orgId, secretId: randomUUID(), kind: 'webhook_hmac' }, stored.enc)).rejects.toThrow();
    await expect(orgSecrets.open({ orgId, secretId, kind: 'smtp' }, stored.enc)).rejects.toThrow();

    // Nor is it on the audit record, which names the host and never the path or query of the URL.
    const events = await auditEvents(orgId, 'webhook.saved', formId);
    expect(events).toHaveLength(2);
    const trail = JSON.stringify(events);
    expect(trail).not.toContain(key);
    expect(trail).not.toContain('whsec_');
    expect(trail).not.toContain('abc123');
    expect(events[0]).toMatchObject({ actorId: user.owner, resourceType: 'webhook', resourceId: made.id, outcome: 'success', metadata: { change: 'created', host: 'hooks.example.test', purposeIds: ['pur_1'] } });
  });

  it('makes a different secret for every webhook', async () => {
    const formId = await newForm();
    const a = await create(formId);
    const b = await create(formId);
    expect(a.secret).not.toBe(b.secret);
    expect(a.secretHint === b.secretHint && a.secret === b.secret).toBe(false);
  });

  it('is replaced by rotate-secret, which returns the new one once, seals it in place and leaves the webhook’s revision alone', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const secretId = (await owner.query<{ secret_id: string }>('select secret_id from webhooks where id = $1', [made.id])).rows[0]!.secret_id;
    const before = (await owner.query<{ enc: Record<string, unknown> }>('select enc from secrets where id = $1', [secretId])).rows[0]!.enc;

    const res = await call('POST', `${base(formId)}/${made.id}/rotate-secret`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const fresh = res.json<{ secret: string; secretHint: string; secretRotatedAt: string }>();
    expect(fresh.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(fresh.secret).not.toBe(made.secret);
    expect(fresh.secretHint).toBe(fresh.secret.slice(-4));
    expect(new Date(fresh.secretRotatedAt).getTime()).toBeGreaterThan(0);

    const after = (await owner.query<{ enc: Record<string, unknown>; meta: Record<string, unknown>; rotated_at: Date | null }>('select enc, meta, rotated_at from secrets where id = $1', [secretId])).rows[0]!;
    expect(after.enc).not.toEqual(before);
    expect(after.rotated_at).not.toBeNull();
    expect(after.meta).toEqual({ last4: fresh.secretHint });
    expect(JSON.stringify(after)).not.toContain(fresh.secret.slice(6));
    const opened = await orgSecrets.open({ orgId, secretId, kind: 'webhook_hmac' }, after.enc);
    expect(Buffer.from(opened).toString('base64url')).toBe(fresh.secret.slice(6));
    // The old one no longer opens: the row holds the new key only.
    expect(Buffer.from(opened).toString('base64url')).not.toBe(made.secret.slice(6));

    const read = await call('GET', `${base(formId)}/${made.id}`);
    expect(read.json()).toMatchObject({ rev: 1, secretHint: fresh.secretHint, secretRotatedAt: fresh.secretRotatedAt });
    expect(read.body).not.toContain(fresh.secret.slice(6));

    const events = await auditEvents(orgId, 'webhook.secret_rotated', formId);
    expect(events).toEqual([expect.objectContaining({ actorId: user.owner, resourceType: 'webhook', resourceId: made.id, outcome: 'success' })]);
    expect(JSON.stringify(events)).not.toContain(fresh.secret.slice(6));
    expect(JSON.stringify(events)).not.toContain('whsec_');
  });

  it('is not rotated for a webhook of another form or org (404), and nothing is sealed', async () => {
    const formId = await newForm();
    const otherForm = await newForm();
    const made = await create(formId);
    const before = (await owner.query('select enc, rotated_at from secrets s join webhooks w on w.secret_id = s.id where w.id = $1', [made.id])).rows[0];
    expect((await call('POST', `${base(otherForm)}/${made.id}/rotate-secret`)).statusCode).toBe(404);
    expect((await call('POST', `${base(formId)}/${made.id}/rotate-secret`, { as: user.otherOwner, org: otherOrgId })).statusCode).toBe(404);
    expect((await owner.query('select enc, rotated_at from secrets s join webhooks w on w.secret_id = s.id where w.id = $1', [made.id])).rows[0]).toEqual(before);
  });
});

describe('create, read, save and delete', () => {
  it('creates with the server’s ids and the database’s defaults, and answers 201 with the view, a revision and no-store', async () => {
    const formId = await newForm();
    const res = await call('POST', base(formId), { body: hook() });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['etag']).toBe('"1"');
    expect(res.headers['cache-control']).toBe('no-store');
    const made = res.json<Created>();
    expect(made).toMatchObject({
      formId,
      url: HOOK,
      enabled: true,
      events: ['submission.created'],
      keyBy: 'key',
      fieldKeys: 'all_in_purposes',
      purposeIds: ['pur_1'],
      files: 'none',
      bodyFormat: 'json',
      payloadMapping: null,
      consecutiveFailures: 0,
      disabledReason: null,
      rev: 1,
    });
    expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await owner.query('select org_id, updated_by from webhooks where id = $1', [made.id])).rows[0]).toEqual({ org_id: orgId, updated_by: user.owner });
  });

  it('refuses what the server decides or does not store: an id, an org, a secret reference, a filter, an unknown key', async () => {
    const formId = await newForm();
    for (const extra of [{ id: randomUUID() }, { orgId: otherOrgId }, { secretRef: randomUUID() }, { secretId: randomUUID() }, { filter: { kind: 'group', id: 'g', combinator: 'all', children: [] } }, { rev: 5 }]) {
      const res = await call('POST', base(formId), { body: hook(extra) });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await webhookRows(formId)).toBe(0);
  });

  it('validates the rest of the body: the URL, the events, the key mode, the field keys, the purposes', async () => {
    const formId = await newForm();
    const bad: Array<Record<string, unknown>> = [
      { url: 'ftp://hooks.example.test/in' },
      { url: 'https://user:pw@hooks.example.test/in' },
      { url: 'not a url' },
      { events: [] },
      { events: ['submission.exploded'] },
      { keyBy: 'name' },
      { files: 'attached' },
      { fieldKeys: 'everything' },
      { fieldKeys: ['__proto__'] },
      { purposeIds: ['has space'] },
      { enabled: 'yes' },
    ];
    for (const patch of bad) {
      const res = await call('POST', base(formId), { body: hook(patch) });
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect((await call('POST', base(formId), { body: { events: ['submission.created'], purposeIds: ['pur_1'] } })).statusCode).toBe(400);
    expect(await webhookRows(formId)).toBe(0);
  });

  it('stores every event and purpose once, and the chosen field keys, key mode and file mode', async () => {
    const formId = await newForm();
    const made = await create(
      formId,
      hook({ events: ['submission.created', 'submission.updated', 'submission.created'], fieldKeys: ['name', 'email', 'name'], keyBy: 'id', files: 'signed_urls', enabled: false }),
    );
    expect(made).toMatchObject({ events: ['submission.created', 'submission.updated'], fieldKeys: ['name', 'email'], keyBy: 'id', files: 'signed_urls', enabled: false });
  });

  it('stores a body format and a payload mapping, audits the change, and refuses a mapping that cannot be used (422, nothing written)', async () => {
    const formId = await newForm();
    const mapping = { root: 'order', entries: [{ path: 'customer.name', source: { kind: 'answer', key: 'name' } }, { path: 'lines[].item', source: { kind: 'answer', key: 'items' } }, { path: 'ref', source: { kind: 'meta', name: 'submissionId' } }] };
    const made = await create(formId, hook({ bodyFormat: 'xml', payloadMapping: mapping }));
    expect(made).toMatchObject({ bodyFormat: 'xml', payloadMapping: mapping });
    const saved = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ bodyFormat: 'json', payloadMapping: null }) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ bodyFormat: 'json', payloadMapping: null });
    const events = await auditEvents(orgId, 'webhook.saved', formId);
    expect(JSON.stringify(events.at(-1))).toContain('bodyFormat');
    expect(JSON.stringify(events.at(-1))).toContain('payloadMapping');

    const before = await webhookRows(formId);
    for (const bad of [
      { entries: [{ path: 'a b', source: { kind: 'answer', key: 'x' } }] },
      { entries: [{ path: '__proto__.x', source: { kind: 'answer', key: 'x' } }] },
      { entries: [{ path: 'a', source: { kind: 'answer', key: 'x' } }, { path: 'a.b', source: { kind: 'answer', key: 'y' } }] },
      { root: 'bad root', entries: [] },
    ]) {
      const res = await call('POST', base(formId), { body: hook({ payloadMapping: bad }) });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(res.json()).toMatchObject({ code: 'INVALID_PAYLOAD_MAPPING' });
    }
    // Shape errors are the usual 400.
    expect((await call('POST', base(formId), { body: hook({ bodyFormat: 'yaml' }) })).statusCode).toBe(400);
    expect((await call('POST', base(formId), { body: hook({ payloadMapping: { entries: [{ path: 'a', source: { kind: 'answer', key: 'x', extra: 1 } }] } }) })).statusCode).toBe(400);
    expect(await webhookRows(formId)).toBe(before);
  });

  it('refuses a mapping too big for the column with 422 INVALID_PAYLOAD_MAPPING (not a 500), and stores one just under the cap', async () => {
    const formId = await newForm();
    // 200 entries with 194-character paths: schema-valid at every key size below, so only the serialized size decides.
    const sized = (keyLength: number) => ({
      root: 'r',
      entries: Array.from({ length: 200 }, (_, i) => ({
        path: [`s${i}_`.padEnd(64, 'a'), 'b'.repeat(64), 'c'.repeat(64)].join('.'),
        source: { kind: 'answer', key: `k${i}_`.padEnd(keyLength, 'y') },
      })),
    });
    const before = await webhookRows(formId);
    for (const big of [sized(200), sized(60)]) {
      const res = await call('POST', base(formId), { body: hook({ payloadMapping: big }) });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(422);
      expect(res.json()).toMatchObject({ code: 'INVALID_PAYLOAD_MAPPING' });
    }
    expect(await webhookRows(formId)).toBe(before);

    const fits = sized(40);
    expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThanOrEqual(56 * 1024);
    const made = await create(formId, hook({ payloadMapping: fits }));
    expect(made.payloadMapping?.entries).toHaveLength(200);
    const tooBig = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: String(made.rev), body: hook({ payloadMapping: sized(200) }) });
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json()).toMatchObject({ code: 'INVALID_PAYLOAD_MAPPING' });
  });

  it('keeps the stored body format and mapping when a save leaves those keys out; null still clears the mapping', async () => {
    const formId = await newForm();
    const mapping = { root: 'order', entries: [{ path: 'customer.name', source: { kind: 'answer', key: 'name' } }] };
    const made = await create(formId, hook({ bodyFormat: 'xml', payloadMapping: mapping }));
    // A stale builder tab (or a script) that does not know the new keys edits the URL only.
    const stale = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ url: `${HOOK}?v=2` }) });
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json()).toMatchObject({ url: `${HOOK}?v=2`, bodyFormat: 'xml', payloadMapping: mapping, rev: 2 });
    const events = await auditEvents(orgId, 'webhook.saved', formId);
    expect((events.at(-1)?.metadata as { changedKeys?: string[] } | undefined)?.changedKeys).toEqual(['url']);

    const cleared = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '2', body: hook({ url: `${HOOK}?v=2`, payloadMapping: null }) });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ bodyFormat: 'xml', payloadMapping: null, rev: 3 });
  });

  it('lists a form’s webhooks oldest first, reads one with its ETag, and 404s for a webhook of another form', async () => {
    const formId = await newForm();
    const otherForm = await newForm();
    const first = await create(formId, hook({ url: 'https://hooks.example.test/one' }));
    const second = await create(formId, hook({ url: 'https://hooks.example.test/two' }));
    const elsewhere = await create(otherForm);
    const list = await call('GET', base(formId));
    expect(list.json<{ items: WebhookJson[] }>().items.map((w) => w.id)).toEqual([first.id, second.id]);
    expect(list.headers['cache-control']).toBe('no-store');
    const one = await call('GET', `${base(formId)}/${second.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.headers['etag']).toBe('"1"');
    expect(one.json()).toMatchObject({ id: second.id, url: 'https://hooks.example.test/two', secretHint: second.secretHint });
    expect((await call('GET', `${base(formId)}/${elsewhere.id}`)).statusCode).toBe(404);
    expect((await call('GET', `${base(formId)}/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call('GET', `${base(formId)}/not-a-uuid`)).statusCode).toBe(400);
    expect((await call('GET', `${base(randomUUID())}`)).statusCode).toBe(404);
  });

  it('saves at the current revision, bumps it, and writes one record that names the keys that changed and the host', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const saved = await call('PUT', `${base(formId)}/${made.id}`, {
      ifMatch: '"1"',
      body: hook({ url: 'https://other.example.test/in?k=secretish', events: ['submission.updated', 'submission.created'], purposeIds: ['pur_1', 'pur_2'], keyBy: 'id' }),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.headers['etag']).toBe('"2"');
    expect(saved.json()).toMatchObject({ id: made.id, rev: 2, url: 'https://other.example.test/in?k=secretish', keyBy: 'id', purposeIds: ['pur_1', 'pur_2'] });
    expect(saved.json<WebhookJson>().updatedAt >= made.updatedAt).toBe(true);
    const events = await auditEvents(orgId, 'webhook.saved', formId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ resourceId: made.id, metadata: { change: 'updated', host: 'other.example.test', changedKeys: ['url', 'events', 'keyBy', 'purposeIds'], rev: 2 } });
    expect(JSON.stringify(events[1])).not.toContain('secretish');
    // A save that changes nothing still bumps the revision and says so.
    const same = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '2', body: hook({ url: 'https://other.example.test/in?k=secretish', events: ['submission.created', 'submission.updated'], purposeIds: ['pur_2', 'pur_1'], keyBy: 'id' }) });
    expect(same.statusCode).toBe(200);
    expect((await auditEvents(orgId, 'webhook.saved', formId))[2]).toMatchObject({ metadata: { changedKeys: [], rev: 3 } });
  });

  it('asks for If-Match with 428, refuses a stale one with 409, and writes nothing in either case', async () => {
    const formId = await newForm();
    const made = await create(formId);
    for (const header of [undefined, 'latest', '-1', '1.5']) {
      const res = await call('PUT', `${base(formId)}/${made.id}`, { body: hook({ enabled: false }), ...(header === undefined ? {} : { ifMatch: header }) });
      expect(res.statusCode, String(header)).toBe(428);
      expect(res.json()).toMatchObject({ code: 'WEBHOOK_REV_REQUIRED' });
    }
    for (const header of ['0', '2', '7']) {
      const res = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: header, body: hook({ enabled: false }) });
      expect(res.statusCode, header).toBe(409);
      expect(res.json()).toMatchObject({ code: 'WEBHOOK_REV_CONFLICT' });
    }
    expect((await owner.query('select rev, enabled from webhooks where id = $1', [made.id])).rows[0]).toEqual({ rev: 1, enabled: true });
    expect(await auditEvents(orgId, 'webhook.saved', formId)).toHaveLength(1);
  });

  it('lets exactly one of two saves with the same revision through', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const both = await Promise.all([
      call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ keyBy: 'id' }) }),
      call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ files: 'signed_urls' }) }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await owner.query('select rev from webhooks where id = $1', [made.id])).rows[0]).toEqual({ rev: 2 });
    expect(await auditEvents(orgId, 'webhook.saved', formId)).toHaveLength(2);
  });

  it('switches a webhook the worker turned off back on with a fresh failure count, and keeps the reason while it stays off', async () => {
    const formId = await newForm();
    const made = await create(formId);
    await owner.query(`update webhooks set enabled = false, consecutive_failures = 50, disabled_reason = 'too many failures' where id = $1`, [made.id]);
    const stillOff = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '1', body: hook({ enabled: false, keyBy: 'id' }) });
    expect(stillOff.json()).toMatchObject({ enabled: false, consecutiveFailures: 50, disabledReason: 'too many failures', rev: 2 });
    const on = await call('PUT', `${base(formId)}/${made.id}`, { ifMatch: '2', body: hook({ enabled: true, keyBy: 'id' }) });
    expect(on.json()).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null, rev: 3 });
  });

  it('does not move a webhook to another form, org or secret through a save', async () => {
    const formId = await newForm();
    const otherForm = await newForm();
    const made = await create(formId);
    const res = await call('PUT', `${base(otherForm)}/${made.id}`, { ifMatch: '1', body: hook() });
    expect(res.statusCode).toBe(404);
    expect((await owner.query('select form_id, org_id from webhooks where id = $1', [made.id])).rows[0]).toEqual({ form_id: formId, org_id: orgId });
  });

  it('deletes the webhook, its signing secret and its delivery log, once, and records the host', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const secretId = (await owner.query<{ secret_id: string }>('select secret_id from webhooks where id = $1', [made.id])).rows[0]!.secret_id;
    await seedDelivery(made.id);
    await seedDelivery(made.id, { offsetSeconds: 1 });
    const keep = await create(formId, hook({ url: 'https://other.example.test/keep' }));
    await seedDelivery(keep.id);

    const res = await call('DELETE', `${base(formId)}/${made.id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe('');
    expect(await countOf('select count(*)::int as n from webhooks where id = $1', [made.id])).toBe(0);
    expect(await countOf('select count(*)::int as n from secrets where id = $1', [secretId])).toBe(0);
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [made.id])).toBe(0);
    // The other webhook of the form is untouched.
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [keep.id])).toBe(1);
    expect((await call('GET', `${base(formId)}/${keep.id}`)).statusCode).toBe(200);
    expect(await auditEvents(orgId, 'webhook.deleted', formId)).toEqual([
      expect.objectContaining({ actorId: user.owner, resourceType: 'webhook', resourceId: made.id, outcome: 'success', metadata: { host: 'hooks.example.test' } }),
    ]);
    expect((await call('DELETE', `${base(formId)}/${made.id}`)).statusCode).toBe(404);
    expect((await call('GET', `${base(formId)}/${made.id}`)).statusCode).toBe(404);
  });
});

describe('the delivery log', () => {
  it('lists the newest delivery first with its status, HTTP status, duration, attempt and snippet, and pages by a signed cursor', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const other = await create(formId, hook({ url: 'https://other.example.test/in' }));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedDelivery(made.id, { offsetSeconds: i + 1, status: i === 4 ? 'succeeded' : 'failed', httpStatus: i === 4 ? 200 : 500, snippet: `answer ${i}` }));
    await seedDelivery(other.id, { offsetSeconds: 9 });

    const first = await call('GET', `${base(formId)}/${made.id}/deliveries?limit=2`);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const page1 = first.json<{ items: DeliveryJson[]; nextCursor: string | null }>();
    expect(page1.items.map((d) => d.id)).toEqual([ids[4], ids[3]]);
    expect(page1.items[0]).toMatchObject({
      webhookId: made.id,
      event: 'submission.created',
      status: 'succeeded',
      attempt: 3,
      httpStatus: 200,
      durationMs: 120,
      responseSnippet: 'answer 4',
      replayOf: null,
      nextAttemptAt: null,
    });
    expect(page1.items[0]!.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const second = (await call('GET', `${base(formId)}/${made.id}/deliveries?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)).json<{ items: DeliveryJson[]; nextCursor: string | null }>();
    expect(second.items.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    const third = (await call('GET', `${base(formId)}/${made.id}/deliveries?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`)).json<{ items: DeliveryJson[]; nextCursor: string | null }>();
    expect(third.items.map((d) => d.id)).toEqual([ids[0]]);
    expect(third.nextCursor).toBeNull();

    const failed = (await call('GET', `${base(formId)}/${made.id}/deliveries?status=failed`)).json<{ items: DeliveryJson[] }>();
    expect(failed.items.map((d) => d.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect((await call('GET', `${base(formId)}/${made.id}/deliveries?status=exploded`)).statusCode).toBe(400);
  });

  it('refuses a cursor that was edited, made for another webhook or filter, or is not one, with 400 INVALID_CURSOR', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const other = await create(formId, hook({ url: 'https://other.example.test/in' }));
    for (let i = 0; i < 3; i++) await seedDelivery(made.id, { offsetSeconds: i + 1 });
    for (let i = 0; i < 3; i++) await seedDelivery(other.id, { offsetSeconds: i + 1 });
    const cursor = (await call('GET', `${base(formId)}/${made.id}/deliveries?limit=1`)).json<{ nextCursor: string }>().nextCursor;
    const tried = [
      `${base(formId)}/${made.id}/deliveries?cursor=${encodeURIComponent(cursor.slice(0, -2) + 'xx')}`,
      `${base(formId)}/${other.id}/deliveries?cursor=${encodeURIComponent(cursor)}`,
      `${base(formId)}/${made.id}/deliveries?status=failed&cursor=${encodeURIComponent(cursor)}`,
      `${base(formId)}/${made.id}/deliveries?cursor=garbage`,
    ];
    for (const url of tried) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_CURSOR' });
    }
  });

  it('answers an empty log for a webhook that has had no delivery, and 404 for a webhook of another org', async () => {
    const formId = await newForm();
    const made = await create(formId);
    expect((await call('GET', `${base(formId)}/${made.id}/deliveries`)).json()).toEqual({ items: [], nextCursor: null });
    const res = await call('GET', `${base(formId)}/${made.id}/deliveries`, { as: user.otherOwner, org: otherOrgId });
    expect(res.statusCode).toBe(404);
  });
});

describe('replay', () => {
  it('inserts a delivery with replay_of, the same event and response, queues exactly one webhook.deliver in the same transaction, and audits it', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const original = await seedDelivery(made.id, { event: 'submission.updated', status: 'dead', httpStatus: 503 });
    const originalRow = (await owner.query('select submission_id, submission_received_at from webhook_deliveries where id = $1', [original])).rows[0];

    const res = await call('POST', `${base(formId)}/${made.id}/deliveries/${original}/replay`);
    expect(res.statusCode, res.body).toBe(201);
    const replay = res.json<DeliveryJson>();
    expect(replay).toMatchObject({ webhookId: made.id, event: 'submission.updated', status: 'pending', attempt: 0, httpStatus: null, durationMs: null, responseSnippet: null, replayOf: original, submissionId: originalRow.submission_id });
    expect(replay.id).not.toBe(original);

    const row = (
      await owner.query(
        'select org_id, webhook_id, event, submission_id, submission_received_at, status, attempt, replay_of, http_status, response_snippet, request_hash from webhook_deliveries where id = $1',
        [replay.id],
      )
    ).rows;
    expect(row).toEqual([
      {
        org_id: orgId,
        webhook_id: made.id,
        event: 'submission.updated',
        submission_id: originalRow.submission_id,
        submission_received_at: originalRow.submission_received_at,
        status: 'pending',
        attempt: 0,
        replay_of: original,
        http_status: null,
        response_snippet: null,
        request_hash: null,
      },
    ]);
    // The original is as it was.
    expect((await owner.query('select status, http_status, attempt from webhook_deliveries where id = $1', [original])).rows[0]).toEqual({ status: 'dead', http_status: 503, attempt: 3 });

    // Exactly one job, for the new delivery, named by its resource and its org, sent on the request's transaction: the row was
    // visible through that transaction and not through another connection when the job was sent.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: 'webhook.deliver',
      job: { orgId, resource: { type: 'webhook_delivery', id: replay.id }, data: { deliveryId: replay.id } },
      insideTx: 1,
      outsideTx: 0,
    });
    expect(sent[0]!.options?.tx).toBeDefined();
    expect(JSON.stringify(sent[0]!.job)).not.toContain(original);

    expect(await auditEvents(orgId, 'webhook.replayed', formId)).toEqual([
      expect.objectContaining({ actorId: user.owner, resourceType: 'webhook', resourceId: made.id, outcome: 'success', metadata: { deliveryId: replay.id, replayOf: original, event: 'submission.updated' } }),
    ]);

    // It shows in the log, newest first, with its link to the original.
    const list = (await call('GET', `${base(formId)}/${made.id}/deliveries?limit=1`)).json<{ items: DeliveryJson[] }>();
    expect(list.items[0]).toMatchObject({ id: replay.id, replayOf: original });
  });

  it('names the first delivery when a replay is replayed, and works for a delivery that has no response (a deleted submission’s event)', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const original = await seedDelivery(made.id, { event: 'submission.deleted', submission: false });
    const first = (await call('POST', `${base(formId)}/${made.id}/deliveries/${original}/replay`)).json<DeliveryJson>();
    expect(first).toMatchObject({ replayOf: original, event: 'submission.deleted', submissionId: null });
    const again = await call('POST', `${base(formId)}/${made.id}/deliveries/${first.id}/replay`);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toMatchObject({ replayOf: original });
    expect(sent).toHaveLength(2);
  });

  it('answers 404 for another org’s delivery, and for a delivery of another webhook, and queues and writes nothing', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const sibling = await create(formId, hook({ url: 'https://other.example.test/in' }));
    const delivery = await seedDelivery(made.id);
    const siblingDelivery = await seedDelivery(sibling.id);
    const before = await countOf('select count(*)::int as n from webhook_deliveries', []);

    // Org B, naming its own org and form, with org A's webhook and delivery ids; and with org A's form in the path.
    const otherForm = await newForm({ as: user.otherOwner, org: otherOrgId });
    const attempts: Array<[string, CallOptions]> = [
      [`${base(formId)}/${made.id}/deliveries/${delivery}/replay`, { as: user.otherOwner, org: otherOrgId }],
      [`${base(otherForm)}/${made.id}/deliveries/${delivery}/replay`, { as: user.otherOwner, org: otherOrgId }],
      // Org A's own member, but the delivery belongs to another webhook, or to none.
      [`${base(formId)}/${made.id}/deliveries/${siblingDelivery}/replay`, {}],
      [`${base(formId)}/${made.id}/deliveries/${randomUUID()}/replay`, {}],
      [`${base(formId)}/${randomUUID()}/deliveries/${delivery}/replay`, {}],
    ];
    for (const [url, o] of attempts) {
      const res = await call('POST', url, o);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
    }
    expect((await call('POST', `${base(formId)}/${made.id}/deliveries/not-a-uuid/replay`)).statusCode).toBe(400);
    expect(await countOf('select count(*)::int as n from webhook_deliveries', [])).toBe(before);
    expect(sent).toEqual([]);
  });

  it('refuses a delivery whose response the grid trashed with 409 WEBHOOK_RESPONSE_TRASHED, and writes and queues nothing', async () => {
    const formId = await newForm();
    const made = await create(formId);
    // A stored response of the form (its version written as the owner, as publish would) that the grid then trashed:
    // `trashed_at` set, the status left `complete`.
    const versionId = randomUUID();
    await owner.query(
      `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, '{}', '{"taint":{}}', $5)`,
      [versionId, orgId, formId, user.owner, '0'.repeat(64)],
    );
    const { id: submissionId, receivedAt } = newSubmissionKey(new Date());
    await owner.query(
      `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta, trashed_at)
       values ($1, $2, $3, $4, $5, $6, 0, 'complete', '{}', '{}', '{"locale":"en-IN"}', now())`,
      [submissionId, receivedAt, orgId, formId, versionId, Buffer.alloc(32)],
    );
    const delivery = await seedDelivery(made.id);
    await owner.query('update webhook_deliveries set submission_id = $2, submission_received_at = $3 where id = $1', [delivery, submissionId, receivedAt]);

    const res = await call('POST', `${base(formId)}/${made.id}/deliveries/${delivery}/replay`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'WEBHOOK_RESPONSE_TRASHED' });
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [made.id])).toBe(1);
    expect(sent).toEqual([]);

    // Restored from the trash, it is sent again.
    await owner.query('update submissions set trashed_at = null where id = $1', [submissionId]);
    expect((await call('POST', `${base(formId)}/${made.id}/deliveries/${delivery}/replay`)).statusCode).toBe(201);
  });

  it('refuses a switched-off webhook with 409 WEBHOOK_DISABLED, and writes and queues nothing', async () => {
    const formId = await newForm();
    const made = await create(formId, hook({ enabled: false }));
    const delivery = await seedDelivery(made.id);
    const res = await call('POST', `${base(formId)}/${made.id}/deliveries/${delivery}/replay`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'WEBHOOK_DISABLED' });
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [made.id])).toBe(1);
    expect(sent).toEqual([]);
  });

  it('writes no delivery when the job cannot be stored: the row and the job exist together or not at all', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const delivery = await seedDelivery(made.id);
    queueMode = 'none';
    const res = await call('POST', `${base(formId)}/${made.id}/deliveries/${delivery}/replay`);
    expect(res.statusCode).toBe(500);
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [made.id])).toBe(1);
    expect(await auditEvents(orgId, 'webhook.replayed', formId)).toEqual([]);
  });
});

describe('org isolation', () => {
  it('gives org B a 404 for every route of org A’s webhook, with org A’s form in the path or org B’s own', async () => {
    const formId = await newForm();
    const made = await create(formId);
    const delivery = await seedDelivery(made.id);
    const otherForm = await newForm({ as: user.otherOwner, org: otherOrgId });
    const rows = async () => (await owner.query('select w.rev, w.url, w.enabled, s.enc, s.rotated_at from webhooks w join secrets s on s.id = w.secret_id where w.id = $1', [made.id])).rows[0];
    const before = await rows();
    for (const form of [formId, otherForm]) {
      const as = { as: user.otherOwner, org: otherOrgId };
      const attempts: Array<[Method, string, unknown?]> = [
        ['GET', `${base(form)}/${made.id}`],
        ['PUT', `${base(form)}/${made.id}`, hook({ url: 'https://other.example.test/in' })],
        ['DELETE', `${base(form)}/${made.id}`],
        ['POST', `${base(form)}/${made.id}/rotate-secret`],
        ['GET', `${base(form)}/${made.id}/deliveries`],
        ['POST', `${base(form)}/${made.id}/deliveries/${delivery}/replay`],
      ];
      for (const [method, url, body] of attempts) {
        const res = await call(method, url, { ...as, ifMatch: '1', ...(body === undefined ? {} : { body }) });
        expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(404);
        expect(res.body).not.toContain('hooks.example.test');
      }
    }
    expect(await rows()).toEqual(before);
    expect(await countOf('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [made.id])).toBe(1);
    expect(sent).toEqual([]);
    // Org B's own form lists none of org A's.
    expect((await call('GET', base(otherForm), { as: user.otherOwner, org: otherOrgId })).json()).toEqual({ items: [] });
  });
});
