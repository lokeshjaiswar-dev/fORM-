import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createEgressGuard, egressHttp } from '@form/adapters/egress';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createDb, newSubmissionKey, provision, withTenant, type DbHandle } from '@form/db';
import { PortError, toIsoInstant, type JobRequest, type OrgSecrets, type Queue, type ReceivedJob } from '@form/ports';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { FieldCompliance, ValueFieldType } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import type { EffectDeps } from '../src/effects/deps.ts';
import { MASK } from '../src/effects/disclosure.ts';
import { verifyWebhook } from '../src/effects/webhook/verify-recipe.ts';
import { jobGuard } from '../src/guard.ts';
import { createSubmissionFanout, type AnyJobDefinition, type FanoutTarget } from '../src/jobs/index.ts';
import { AUTO_DISABLED_REASON, MAX_CONSECUTIVE_FAILURES, webhookJobs, webhooksConsumer } from '../src/jobs/webhooks.ts';
import { runJob, startWorker } from '../src/runtime.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.18: webhooks, from the fan-out of a response to the signed request and what is recorded. Real Postgres with RLS, real
 * pg-boss for one run through the queue, and a receiver that is a local HTTP server. The local receiver sits on a loopback
 * address, which the egress guard refuses everywhere but here: only THIS test's guard lists it as a trusted host, the guard a
 * worker builds trusts none.
 */

/**
 * The signing secret as the API makes and shows it (apps/api/src/routes/webhooks.ts `newSecret()`): 32 random bytes, which are
 * what is SEALED, and `whsec_<base64url of the bytes>`, which is what the owner is shown once and a receiver keys the HMAC with.
 * Written out here on purpose and not imported from the worker, so a change in the worker's rebuilding of the text fails a test.
 */
function issueSecret(): { key: Buffer; shown: string } {
  const key = randomBytes(32);
  return { key, shown: `whsec_${key.toString('base64url')}` };
}
const RECEIVER_HOST = 'hooks.example.test';
/** What the fake DNS answers. A name that is not here does not resolve. */
const DNS: Record<string, string> = { [RECEIVER_HOST]: '127.0.0.1', 'metadata.example.test': '169.254.169.254', 'internal.example.test': '10.0.0.1' };

/** The worker's log, kept in memory at `info`: a test reads it to see what an operator would be told. Cleared by the tests that read it. */
const logLines: string[] = [];
const log = pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) });
const keys = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
const orgSecrets = createOrgSecrets(keys);

interface Hit {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const hits: Hit[] = [];
let receiver: http.Server;
let port: number;

let owner: pg.Pool;
let app: DbHandle;
let urls: Record<'fr_app' | 'fr_migrator', string>;
let clock = new Date();
let a: Org;
let b: Org;
let deps: EffectDeps;
const sent: Array<{ name: string; request: JobRequest<never>; options: { tx?: unknown } | undefined }> = [];

interface Org {
  id: string;
  form: string;
  version: string;
}

const RESPOND = 'respond';
const MARKETING = 'marketing';
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function field(id: string, key: string, compliance: Partial<Omit<FieldCompliance, 'purposeIds'>> & { purposeIds?: string[] } = {}, type: ValueFieldType = 'short_text') {
  const defaults = DEFAULT_COMPLIANCE[type];
  return {
    id,
    type,
    key,
    label: doc(key),
    required: false,
    compliance: { ...defaults, classification: 'personal', purposeIds: [RESPOND], inNotifications: 'include', inExports: 'include', ...compliance },
    config: REGISTRY[type].defaultConfig('en-IN' as never),
  };
}

/** The form every response here is filed under: a name for the webhook, a protected value, an out-of-purpose value, and a plain one. */
const BLOCKS = [
  field('blk_name', 'full_name'),
  field('blk_pan', 'pan', { classification: 'sensitive', inNotifications: 'mask' }),
  field('blk_promo', 'promo_email', { purposeIds: [MARKETING] }),
  field('blk_note', 'note', { classification: 'none', purposeIds: [] }),
];
const DEFINITION = {
  schemaVersion: 2,
  formId: 'form_1',
  blocks: Object.fromEntries(BLOCKS.map((f) => [f.id, f])),
  pages: [{ id: 'page_1', children: BLOCKS.map((f) => f.id) }],
  privacy: { purposes: [{ id: RESPOND }, { id: MARKETING }] },
};
const ANSWERS = {
  blk_name: { type: 'short_text', value: 'Asha' },
  blk_pan: { type: 'short_text', value: 'ABCDE1234F' },
  blk_promo: { type: 'short_text', value: 'asha@marketing.example' },
  blk_note: { type: 'short_text', value: 'plain' },
};

async function seedOrg(slug: string): Promise<Org> {
  const org: Org = { id: randomUUID(), form: randomUUID(), version: randomUUID() };
  const user = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [user, `owner@${slug}.test`]);
  await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [org.form, org.id, randomUUID(), user, `${slug} form`]);
  await owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, $5, $6, $7)`,
    [org.version, org.id, org.form, user, JSON.stringify(DEFINITION), JSON.stringify({ taint: {} }), '0'.repeat(64)],
  );
  return org;
}

async function store(org: Org, status = 'complete'): Promise<{ id: string; receivedAt: Date }> {
  const { id, receivedAt } = newSubmissionKey(new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
     values ($1, $2, $3, $4, $5, $6, 0, $7, $8, '{}', '{"locale":"en-IN"}')`,
    [id, receivedAt, org.id, org.form, org.version, Buffer.alloc(32), status, JSON.stringify(ANSWERS)],
  );
  return { id, receivedAt };
}

interface HookOptions {
  url?: string;
  enabled?: boolean;
  events?: string[];
  purposeIds?: string[];
  fieldKeys?: string[] | 'all_in_purposes';
  keyBy?: 'key' | 'id';
  failures?: number;
  /** Seal the secret as this one: a value that does not open for this row, org and kind. */
  sealedFor?: { secretId: string };
}

/** `secret` is the text the owner was shown for this webhook: what a receiver verifies with. */
async function seedWebhook(org: Org, o: HookOptions = {}): Promise<{ id: string; secretId: string; secret: string }> {
  const secretId = randomUUID();
  // What the API seals: the 32 raw bytes, not the text shown to the owner.
  const { key, shown } = issueSecret();
  const enc = await orgSecrets.seal({ orgId: org.id, secretId: o.sealedFor?.secretId ?? secretId, kind: 'webhook_hmac' }, new Uint8Array(key));
  await owner.query(`insert into secrets (id, org_id, kind, enc, meta) values ($1, $2, 'webhook_hmac', $3, '{}')`, [secretId, org.id, JSON.stringify(enc)]);
  const id = randomUUID();
  await owner.query(
    `insert into webhooks (id, org_id, form_id, url, enabled, secret_id, events, key_by, field_keys, purpose_ids, consecutive_failures)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      org.id,
      org.form,
      o.url ?? `http://${RECEIVER_HOST}:${port}/ok`,
      o.enabled ?? true,
      secretId,
      o.events ?? ['submission.created'],
      o.keyBy ?? 'key',
      JSON.stringify(o.fieldKeys ?? 'all_in_purposes'),
      o.purposeIds ?? [RESPOND],
      o.failures ?? 0,
    ],
  );
  return { id, secretId, secret: shown };
}

async function seedDelivery(org: Org, webhookId: string, s: { id: string; receivedAt: Date }, o: { replayOf?: string; event?: string } = {}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into webhook_deliveries (id, org_id, webhook_id, event, submission_id, submission_received_at, status, replay_of) values ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [id, org.id, webhookId, o.event ?? 'submission.created', s.id, s.receivedAt, o.replayOf ?? null],
  );
  return id;
}

interface DeliveryRow {
  id: string;
  created_at: Date;
  attempt: number;
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  request_hash: Buffer | null;
  response_snippet: string | null;
  next_attempt_at: Date | null;
}

async function deliveryRow(id: string): Promise<DeliveryRow> {
  const { rows } = await owner.query<DeliveryRow>('select * from webhook_deliveries where id = $1', [id]);
  return rows[0]!;
}

async function hookRow(id: string) {
  const { rows } = await owner.query<{ enabled: boolean; consecutive_failures: number; disabled_reason: string | null; rev: number }>(
    'select enabled, consecutive_failures, disabled_reason, rev from webhooks where id = $1',
    [id],
  );
  return rows[0]!;
}

async function disclosuresOf(webhookId: string) {
  const { rows } = await owner.query<{ submission_id: string; recipient_kind: string; display_name: string; field_keys: string[] }>(
    `select submission_id, recipient_kind, display_name, field_keys from disclosures where recipient_id = $1 order by at, id`,
    [webhookId],
  );
  return rows;
}

async function auditOf(action: string, orgId: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = $2 order by id`, [orgId, action]);
  return rows.map((r) => r.event);
}

const hitsOf = (deliveryId: string): Hit[] => hits.filter((h) => h.headers['form-delivery-id'] === deliveryId);
const secondsOf = (hit: Hit): number => Number(/t=(\d+)/.exec(String(hit.headers['form-signature']))![1]);

function effectDeps(o: Partial<EffectDeps> = {}): EffectDeps {
  // The one guard of this test: loopback is reachable for the receiver's own host and port, and for nothing else.
  const guard = createEgressGuard({
    policy: 'open',
    trusted: [`${RECEIVER_HOST}:${port}`],
    resolve: async (host) => {
      const address = DNS[host];
      if (!address) throw new Error(`ENOTFOUND ${host}`);
      return [{ address, family: 4 }];
    },
  });
  return {
    db: app.db,
    queue: {
      async send(name: string, request: unknown, options: { tx?: unknown } | undefined) {
        sent.push({ name, request: request as JobRequest<never>, options });
        return randomUUID();
      },
    } as unknown as Queue,
    orgSecrets,
    mailerFor: () => {
      throw new Error('no mail in a webhook test');
    },
    tenantEgress: guard,
    tenantHttp: (url, request) => egressHttp(guard, url, request),
    config: { publicBuilderUrl: 'https://builder.example.test', mailFrom: { address: 'forms@example.test' }, messageIdDomain: 'example.test', webhookUserAgent: 'fORM-Webhooks/1' },
    now: () => clock,
    ...o,
  };
}

const definitionOf = (d: EffectDeps, name: 'webhook.deliver' | 'webhook.fanout'): AnyJobDefinition => webhookJobs(d).find((j) => j.name === name)!;

function receivedJob(name: 'webhook.deliver', orgId: string, deliveryId: string, attempt: number): ReceivedJob<'webhook.deliver'>;
function receivedJob(name: 'webhook.fanout', orgId: string, deliveryId: string, attempt: number, data: { submissionId: string; receivedAt: string; formId: string; event: 'submission.created' }): ReceivedJob<'webhook.fanout'>;
function receivedJob(name: string, orgId: string, id: string, attempt: number, data?: Record<string, unknown>): ReceivedJob<never> {
  return {
    id: randomUUID(),
    name,
    attempt,
    signal: new AbortController().signal,
    envelope: { v: 1, orgId, resource: { type: name === 'webhook.deliver' ? 'webhook_delivery' : 'form', id }, data: data ?? { deliveryId: id }, sig: 'k.x' },
  } as unknown as ReceivedJob<never>;
}

/** One attempt at a delivery as the worker runs it (a tenant transaction per step, actor `system`). Resolves with the error a failed attempt throws, or null. */
async function attempt(org: Org, deliveryId: string, n = 1, d: EffectDeps = deps): Promise<Error | null> {
  const def = definitionOf(d, 'webhook.deliver') as Parameters<typeof runJob>[0];
  return runJob(def, receivedJob('webhook.deliver', org.id, deliveryId, n) as never, { db: app.db, log }).then(
    () => null,
    (e: Error) => e,
  );
}

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      switch (req.url) {
        case '/ok':
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"saved":"asha.kumar@example.com","phone":"9876543210"}');
          break;
        case '/fail':
          res.writeHead(500).end('upstream exploded\u0000 for asha.kumar@example.com');
          break;
        case '/redirect':
          res.writeHead(302, { location: '/landing' }).end();
          break;
        case '/big':
          res.writeHead(200).end('x'.repeat(100 * 1024));
          break;
        default:
          res.writeHead(200).end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  port = (receiver.address() as AddressInfo).port;

  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker_webhooks');
  const provisioned = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  urls = provisioned.urls as typeof urls;
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 6, applicationName: 'fr-worker-webhooks-test' });
  a = await seedOrg('hooks-a');
  b = await seedOrg('hooks-b');
  deps = effectDeps();
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  await app?.close();
  await owner?.end();
});

describe('webhook.deliver', () => {
  it('delivers to a local receiver that verifies it with the published recipe: succeeded, a disclosures row, answers filtered by purpose', async () => {
    const hook = await seedWebhook(a);
    const s = await store(a);
    const delivery = await seedDelivery(a, hook.id, s);
    clock = new Date();

    expect(await attempt(a, delivery)).toBeNull();

    const [hit, ...others] = hitsOf(delivery);
    expect(others).toEqual([]);
    expect(hit!.path).toBe('/ok');
    expect(hit!.headers).toMatchObject({ 'content-type': 'application/json', 'user-agent': 'fORM-Webhooks/1', 'form-delivery-id': delivery, 'form-event': 'submission.created' });
    // The receiver does what docs/platform/webhook-signatures.md says: the raw body, the header, its own copy of the secret.
    expect(verifyWebhook(hit!.body, String(hit!.headers['form-signature']), hook.secret, Math.floor(clock.getTime() / 1000))).toBe(true);
    expect(verifyWebhook(`${hit!.body} `, String(hit!.headers['form-signature']), hook.secret, Math.floor(clock.getTime() / 1000))).toBe(false);

    const body = JSON.parse(hit!.body);
    expect(body).toEqual({
      id: delivery,
      event: 'submission.created',
      createdAt: (await deliveryRow(delivery)).created_at.toISOString(),
      form: { id: a.form },
      submission: { id: s.id, submittedAt: s.receivedAt.toISOString(), answers: { full_name: 'Asha', pan: MASK, note: 'plain' } },
    });
    // The marketing field is outside the webhook's purposes: not in the body, whatever its value.
    expect(hit!.body).not.toContain('marketing.example');
    expect(hit!.body).not.toContain('ABCDE1234F');

    const row = await deliveryRow(delivery);
    expect(row).toMatchObject({ attempt: 1, status: 'succeeded', http_status: 200, next_attempt_at: null });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.request_hash!.toString('hex')).toBe(createHash('sha256').update(hit!.body).digest('hex'));
    // What the receiver answered is kept scrubbed: no address, no long number.
    expect(row.response_snippet).toBe('{"ok":true,"saved":"[email]","phone":"[number]"}');

    // The ledger names the host and the keys that were sent: not the masked field, not the out-of-purpose one, never a value.
    expect(await disclosuresOf(hook.id)).toEqual([{ submission_id: s.id, recipient_kind: 'webhook', display_name: `${RECEIVER_HOST}:${port}`, field_keys: ['full_name', 'note'] }]);
    expect(await hookRow(hook.id)).toMatchObject({ enabled: true, consecutive_failures: 0 });
  });

  it('signs with the secret the API shows the owner (`whsec_` and the base64url of the sealed bytes), so a receiver that follows the doc verifies it', async () => {
    const hook = await seedWebhook(a);
    const delivery = await seedDelivery(a, hook.id, await store(a));
    clock = new Date();
    expect(await attempt(a, delivery)).toBeNull();
    const [hit] = hitsOf(delivery);
    const header = String(hit!.headers['form-signature']);
    const now = Math.floor(clock.getTime() / 1000);

    // The sealed value is the 32 raw bytes; the owner was shown their text. The doc says: key the HMAC with the text as shown.
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(verifyWebhook(hit!.body, header, hook.secret, now)).toBe(true);
    // The readings of the doc that are wrong must not verify: the prefix cut off, the rest decoded to bytes, or another webhook's secret.
    const bytes = Buffer.from(hook.secret.slice('whsec_'.length), 'base64url');
    expect(bytes).toHaveLength(32);
    expect(verifyWebhook(hit!.body, header, hook.secret.slice('whsec_'.length), now)).toBe(false);
    expect(verifyWebhook(hit!.body, header, bytes.toString('latin1'), now)).toBe(false);
    expect(verifyWebhook(hit!.body, header, bytes.toString('hex'), now)).toBe(false);
    expect(verifyWebhook(hit!.body, header, issueSecret().shown, now)).toBe(false);
  });

  it('names the answers by block id when the webhook says keyBy id, and narrows to the listed keys, never past the purposes', async () => {
    const byId = await seedWebhook(a, { keyBy: 'id' });
    const narrow = await seedWebhook(a, { fieldKeys: ['full_name', 'promo_email', 'pan'] });
    const s = await store(a);
    const d1 = await seedDelivery(a, byId.id, s);
    const d2 = await seedDelivery(a, narrow.id, s);
    expect(await attempt(a, d1)).toBeNull();
    expect(await attempt(a, d2)).toBeNull();
    expect(JSON.parse(hitsOf(d1)[0]!.body).submission.answers).toEqual({ blk_name: 'Asha', blk_pan: MASK, blk_note: 'plain' });
    expect(JSON.parse(hitsOf(d2)[0]!.body).submission.answers).toEqual({ full_name: 'Asha', pan: MASK });
    expect((await disclosuresOf(narrow.id))[0]!.field_keys).toEqual(['full_name']);
  });

  it.each([
    ['a host that resolves to the cloud metadata address', 'http://metadata.example.test/latest/meta-data', '169.254.169.254', '/latest/meta-data'],
    ['the metadata address as a literal', 'http://169.254.169.254/latest/meta-data', '169.254.169.254', '/latest/meta-data'],
    ['a host that resolves to a private address', 'http://internal.example.test/admin', '10.0.0.1', '/admin'],
    ['a private address as a literal', 'http://10.0.0.1/admin', '10.0.0.1', '/admin'],
  ])('is dead at once, with no request and no retry, for %s', async (_name, url, address, path) => {
    const hook = await seedWebhook(a, { url });
    const s = await store(a);
    const delivery = await seedDelivery(a, hook.id, s);
    const before = hits.length;
    logLines.length = 0;

    // Not an error: a refusal is final, so the queue is not asked to try again.
    expect(await attempt(a, delivery)).toBeNull();

    expect(hits.length).toBe(before);
    const row = await deliveryRow(delivery);
    expect(row).toMatchObject({ attempt: 1, status: 'dead', http_status: null, duration_ms: null, request_hash: null, next_attempt_at: null });
    // The log of the delivery is read by every member with data.route, so the reason is a fixed sentence: no address the resolver
    // returned (that would map the platform's own network for a tenant), no host, no scheme, no path.
    expect(row.response_snippet).toBe('not sent: the address is not allowed (private, internal or not permitted)');
    const stored = JSON.stringify(row);
    for (const leak of [address, '169.254', '10.0.0', 'metadata.example.test', 'internal.example.test', 'not a public address', 'never reachable', path]) expect(stored).not.toContain(leak);
    // The detail is not lost: an operator reads it in the worker's log, which holds the guard's message but not the path.
    const logged = logLines.filter((l) => l.includes('the egress guard refused the address'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(address);
    expect(logged[0]).toContain(delivery);
    expect(logged[0]).not.toContain(path);
    // Nothing left the system, so nothing is in the ledger; the refusal still counts as a failure of the webhook.
    expect(await disclosuresOf(hook.id)).toEqual([]);
    expect((await hookRow(hook.id)).consecutive_failures).toBe(1);
  });

  it('does not tell the log a policy refusal either: a host the installation does not allow gets the same fixed sentence', async () => {
    // `none`/`allowlist` refusals ("not in EGRESS_ALLOWLIST (EGRESS_POLICY=allowlist)", "scheme ftp: is not allowed") name the
    // installation's policy; the member is told only that the address is not allowed.
    const strict = createEgressGuard({ policy: 'allowlist', allowlist: ['only.example.test'], resolve: async () => [{ address: '203.0.113.7', family: 4 }] });
    const hook = await seedWebhook(a, { url: 'http://elsewhere.example.test/x' });
    const delivery = await seedDelivery(a, hook.id, await store(a));
    expect(await attempt(a, delivery, 1, effectDeps({ tenantEgress: strict, tenantHttp: (url, request) => egressHttp(strict, url, request) }))).toBeNull();
    const row = await deliveryRow(delivery);
    expect(row).toMatchObject({ status: 'dead', http_status: null });
    expect(row.response_snippet).toBe('not sent: the address is not allowed (private, internal or not permitted)');
    expect(JSON.stringify(row)).not.toMatch(/EGRESS_|allowlist|elsewhere\.example\.test/);
  });

  it('retries a name that does not resolve (it may be a DNS blip) instead of calling it a refusal, and sends nothing', async () => {
    const hook = await seedWebhook(a, { url: 'http://nowhere.example.test/' });
    const delivery = await seedDelivery(a, hook.id, await store(a));
    const before = hits.length;
    expect(await attempt(a, delivery)).toBeInstanceOf(Error);
    expect(hits.length).toBe(before);
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'retrying', http_status: null });
    // Fixed text again: the resolver's own error (and the guard's message) go to the worker's log, not to the member's delivery log.
    expect((await deliveryRow(delivery)).response_snippet).toBe('no answer: the address did not resolve');
    expect(JSON.stringify(await deliveryRow(delivery))).not.toMatch(/ENOTFOUND|nowhere\.example\.test|denied/);
    expect(await disclosuresOf(hook.id)).toEqual([]);
    // On the last attempt it is dead like any other failure.
    expect(await attempt(a, delivery, 4)).toBeNull();
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'dead', attempt: 4 });
  });

  it('is retrying after a 500 and dead on the last attempt, signing each attempt afresh and writing one disclosures row for the delivery', async () => {
    const hook = await seedWebhook(a, { url: `http://${RECEIVER_HOST}:${port}/fail` });
    const s = await store(a);
    const delivery = await seedDelivery(a, hook.id, s);
    clock = new Date('2026-11-16T10:00:00.000Z');

    const first = await attempt(a, delivery, 1);
    expect(first).toBeInstanceOf(Error);
    expect(first!.message).toContain(delivery);
    expect(first!.message).not.toContain(RECEIVER_HOST);
    let row = await deliveryRow(delivery);
    expect(row).toMatchObject({ attempt: 1, status: 'retrying', http_status: 500 });
    // About a minute on (the queue adds jitter): the log can show when it will try again.
    expect(row.next_attempt_at!.getTime()).toBe(clock.getTime() + 60_000);
    // A body of the receiver with a NUL and an address is stored without either.
    expect(row.response_snippet).toBe('upstream exploded for [email]');

    clock = new Date(clock.getTime() + 61_000);
    expect(await attempt(a, delivery, 2)).toBeInstanceOf(Error);
    row = await deliveryRow(delivery);
    expect(row).toMatchObject({ attempt: 2, status: 'retrying' });
    expect(row.next_attempt_at!.getTime()).toBe(clock.getTime() + 120_000);

    clock = new Date(clock.getTime() + 121_000);
    expect(await attempt(a, delivery, 3)).toBeInstanceOf(Error);

    // retryLimit is 3 retries, so the 4th attempt is the last: dead, and nothing more is thrown.
    clock = new Date(clock.getTime() + 241_000);
    expect(await attempt(a, delivery, 4)).toBeNull();
    row = await deliveryRow(delivery);
    expect(row).toMatchObject({ attempt: 4, status: 'dead', http_status: 500, next_attempt_at: null });

    const sentHits = hitsOf(delivery);
    expect(sentHits).toHaveLength(4);
    expect(new Set(sentHits.map((h) => h.headers['form-delivery-id']))).toEqual(new Set([delivery]));
    expect(new Set(sentHits.map((h) => secondsOf(h))).size).toBe(4);
    expect(new Set(sentHits.map((h) => h.body)).size).toBe(1);
    expect((await hookRow(hook.id)).consecutive_failures).toBe(4);
    // The answers left on every attempt, and the ledger says so once.
    expect(await disclosuresOf(hook.id)).toHaveLength(1);
  });

  it('does not follow a 302: the redirect target is never requested, and the delivery is retried', async () => {
    const hook = await seedWebhook(a, { url: `http://${RECEIVER_HOST}:${port}/redirect` });
    const s = await store(a);
    const delivery = await seedDelivery(a, hook.id, s);
    const landing = hits.filter((h) => h.path === '/landing').length;

    expect(await attempt(a, delivery)).toBeInstanceOf(Error);

    expect(hits.filter((h) => h.path === '/landing').length).toBe(landing);
    expect(hitsOf(delivery)).toHaveLength(1);
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'retrying', http_status: 302 });
  });

  it('treats an answer over 64 KB as no usable answer and retries', async () => {
    const hook = await seedWebhook(a, { url: `http://${RECEIVER_HOST}:${port}/big` });
    const delivery = await seedDelivery(a, hook.id, await store(a));
    expect(await attempt(a, delivery)).toBeInstanceOf(Error);
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'retrying', http_status: null });
    expect((await deliveryRow(delivery)).response_snippet).toMatch(/^no answer: the request failed: .*exceeds 65536 bytes/);
    // The request did go out, so the ledger has it.
    expect(await disclosuresOf(hook.id)).toHaveLength(1);
  });

  it('replay: delivers again with a fresh t= and the same answers, as the same event, and adds its own ledger row', async () => {
    const hook = await seedWebhook(a);
    const s = await store(a);
    const original = await seedDelivery(a, hook.id, s);
    clock = new Date('2026-11-16T12:00:00.000Z');
    expect(await attempt(a, original)).toBeNull();

    // The replay route inserts a pending row that names the original; the worker does the rest.
    const replay = await seedDelivery(a, hook.id, s, { replayOf: original });
    clock = new Date('2026-11-16T12:30:00.000Z');
    expect(await attempt(a, replay)).toBeNull();

    const [first] = hitsOf(original);
    const [again] = hitsOf(replay);
    expect(secondsOf(again!)).toBe(Math.floor(clock.getTime() / 1000));
    expect(secondsOf(again!)).toBeGreaterThan(secondsOf(first!));
    expect(verifyWebhook(again!.body, String(again!.headers['form-signature']), hook.secret, Math.floor(clock.getTime() / 1000))).toBe(true);
    expect(again!.headers['form-delivery-id']).toBe(replay);
    // The same event: the same id, creation time and answers, so the same bytes and the same hash.
    expect(JSON.parse(again!.body).submission.answers).toEqual(JSON.parse(first!.body).submission.answers);
    expect(JSON.parse(again!.body).id).toBe(original);
    expect(again!.body).toBe(first!.body);
    expect((await deliveryRow(replay)).request_hash).toEqual((await deliveryRow(original)).request_hash);
    expect(await deliveryRow(replay)).toMatchObject({ status: 'succeeded', http_status: 200 });
    expect(await disclosuresOf(hook.id)).toHaveLength(2);
  });

  it('turns the webhook off at the 50th failure in a row, with an audit record, and a success before that starts the count again', async () => {
    const hook = await seedWebhook(a, { url: 'http://metadata.example.test/' });
    const s = await store(a);
    expect(MAX_CONSECUTIVE_FAILURES).toBe(50);
    for (let n = 1; n <= MAX_CONSECUTIVE_FAILURES - 1; n++) {
      expect(await attempt(a, await seedDelivery(a, hook.id, s))).toBeNull();
    }
    expect(await hookRow(hook.id)).toMatchObject({ enabled: true, consecutive_failures: 49, disabled_reason: null, rev: 1 });
    expect(await auditOf('webhook.disabled', a.id)).toEqual([]);

    const last = await seedDelivery(a, hook.id, s);
    expect(await attempt(a, last)).toBeNull();

    expect(await hookRow(hook.id)).toMatchObject({ enabled: false, consecutive_failures: 50, disabled_reason: AUTO_DISABLED_REASON, rev: 2 });
    const records = (await auditOf('webhook.disabled', a.id)).filter((e) => e['resourceId'] === hook.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actorKind: 'system',
      action: 'webhook.disabled',
      resourceType: 'webhook',
      resourceId: hook.id,
      formId: a.form,
      outcome: 'success',
      metadata: { consecutiveFailures: 50, deliveryId: last, status: 'dead' },
    });
    // The record holds no address, no secret and no answer.
    expect(JSON.stringify(records[0])).not.toContain('metadata.example.test');
    expect(JSON.stringify(records[0])).not.toContain(hook.secret);

    // A later delivery of the same webhook is not sent: it is off.
    const before = hits.length;
    const after = await seedDelivery(a, hook.id, s);
    expect(await attempt(a, after)).toBeNull();
    expect(hits.length).toBe(before);
    expect(await deliveryRow(after)).toMatchObject({ status: 'failed', http_status: null });
    expect((await deliveryRow(after)).response_snippet).toBe('not sent: the webhook is turned off');
    expect(await auditOf('webhook.disabled', a.id)).toHaveLength(records.length);

    // And a success resets the count, so failures that are not in a row never add up to 50.
    const healthy = await seedWebhook(a, { failures: 49 });
    expect(await attempt(a, await seedDelivery(a, healthy.id, s))).toBeNull();
    expect(await hookRow(healthy.id)).toMatchObject({ enabled: true, consecutive_failures: 0 });
  });

  it('sends nothing for a webhook that is off, a response that is gone, trashed or set aside, or a delivery already settled', async () => {
    const off = await seedWebhook(a, { enabled: false });
    const on = await seedWebhook(a);
    const live = await store(a);
    const before = hits.length;

    const offDelivery = await seedDelivery(a, off.id, live);
    const goneDelivery = await seedDelivery(a, on.id, newSubmissionKey(new Date()));
    const trashed = await seedDelivery(a, on.id, await store(a, 'trashed'));
    const spam = await seedDelivery(a, on.id, await store(a, 'spam'));
    const review = await seedDelivery(a, on.id, await store(a, 'pending_review'));
    for (const d of [offDelivery, goneDelivery, trashed, spam, review]) expect(await attempt(a, d)).toBeNull();

    expect(hits.length).toBe(before);
    expect((await deliveryRow(offDelivery)).response_snippet).toBe('not sent: the webhook is turned off');
    expect((await deliveryRow(goneDelivery)).response_snippet).toBe('not sent: the response no longer exists');
    expect((await deliveryRow(trashed)).response_snippet).toBe('not sent: the response is trashed');
    expect((await deliveryRow(spam)).response_snippet).toBe('not sent: the response is spam');
    expect((await deliveryRow(review)).response_snippet).toBe('not sent: the response is pending_review');
    for (const d of [offDelivery, goneDelivery, trashed, spam, review]) expect((await deliveryRow(d)).status).toBe('failed');
    // None of it is a failure of the receiver, and none of it left the system.
    expect((await hookRow(on.id)).consecutive_failures).toBe(0);
    expect(await disclosuresOf(on.id)).toEqual([]);

    // An archived response is still a complete one: it is sent.
    const archived = await seedDelivery(a, on.id, await store(a, 'archived'));
    expect(await attempt(a, archived)).toBeNull();
    expect(await deliveryRow(archived)).toMatchObject({ status: 'succeeded' });

    // The queue handing the same job over again (a crash after the result was recorded) does not send it twice.
    const count = hits.length;
    expect(await attempt(a, archived, 2)).toBeNull();
    expect(hits.length).toBe(count);
    expect(await deliveryRow(archived)).toMatchObject({ attempt: 1, status: 'succeeded' });
  });

  it('finds nothing of another org: a job of org B naming org A’s delivery sends nothing and changes nothing', async () => {
    const hook = await seedWebhook(a);
    const delivery = await seedDelivery(a, hook.id, await store(a));
    const before = hits.length;
    expect(await attempt(b, delivery)).toBeNull();
    expect(hits.length).toBe(before);
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'pending', attempt: 0 });
  });

  it('is dead without a request when the secret does not open (bound to another row), and retried when the key service is down', async () => {
    const wrong = await seedWebhook(a, { sealedFor: { secretId: randomUUID() } });
    const wrongDelivery = await seedDelivery(a, wrong.id, await store(a));
    const before = hits.length;
    expect(await attempt(a, wrongDelivery)).toBeNull();
    expect(await deliveryRow(wrongDelivery)).toMatchObject({ status: 'dead', http_status: null });
    expect((await deliveryRow(wrongDelivery)).response_snippet).toBe('not sent: the signing secret cannot be opened');

    const down: OrgSecrets = {
      seal: orgSecrets.seal,
      async open() {
        throw new PortError('unavailable', 'KMS is down');
      },
    };
    const hook = await seedWebhook(a);
    const delivery = await seedDelivery(a, hook.id, await store(a));
    expect(await attempt(a, delivery, 1, effectDeps({ orgSecrets: down }))).toBeInstanceOf(Error);
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'retrying' });
    expect(hits.length).toBe(before);
    // The answers did not leave, so the ledger is empty; the retry, once the key service is back, sends and records.
    expect(await disclosuresOf(hook.id)).toEqual([]);
    // The platform's own outage is not the receiver's failure: it never counts toward turning the webhook off.
    expect((await hookRow(hook.id)).consecutive_failures).toBe(0);
    expect(await attempt(a, delivery, 2)).toBeNull();
    expect(await deliveryRow(delivery)).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(await disclosuresOf(hook.id)).toHaveLength(1);
  });

  it('never puts the secret, the address’s path or the body in the error a failed attempt throws', async () => {
    const hook = await seedWebhook(a, { url: `http://${RECEIVER_HOST}:${port}/fail?token=hunter2` });
    const delivery = await seedDelivery(a, hook.id, await store(a));
    const err = await attempt(a, delivery);
    const text = `${err?.message} ${err?.stack}`;
    for (const secret of [hook.secret, hook.secret.slice('whsec_'.length), 'hunter2', '/fail', 'Asha']) expect(text).not.toContain(secret);
  });
});

describe('webhook.fanout and the consumer', () => {
  const target = (org: Org, s: { id: string }, event: FanoutTarget['event']): FanoutTarget => ({ orgId: org.id, formId: org.form, formVersionId: org.version, submissionId: s.id, status: 'complete', event });
  const consume = (org: Org, t: FanoutTarget) => withTenant(app.db, { orgId: org.id, actor: 'system', requestId: 'test:consumer', perms: [] }, (tx) => webhooksConsumer(deps)(t, { tx, log, signal: new AbortController().signal }));

  it('enqueues one webhook.fanout, through the job’s transaction, when an enabled webhook subscribes; created and released are both submission.created', async () => {
    await seedWebhook(b, { events: ['submission.created'] });
    const s = await store(b);
    sent.length = 0;
    await consume(b, target(b, s, 'created'));
    await consume(b, target(b, s, 'released'));
    expect(sent.map((x) => x.name)).toEqual(['webhook.fanout', 'webhook.fanout']);
    expect(sent[0]!.request).toEqual({
      orgId: b.id,
      resource: { type: 'form', id: b.form },
      data: { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), formId: b.form, event: 'submission.created' },
    });
    expect(sent[0]!.options?.tx).toBeDefined();
  });

  it('enqueues nothing when no enabled webhook of the form subscribes to the event', async () => {
    const quiet = await seedOrg('hooks-quiet');
    const s = await store(quiet);
    sent.length = 0;
    await consume(quiet, target(quiet, s, 'created'));
    await seedWebhook(quiet, { enabled: false });
    await consume(quiet, target(quiet, s, 'created'));
    await seedWebhook(quiet, { events: ['submission.updated'] });
    await consume(quiet, target(quiet, s, 'created'));
    expect(sent).toEqual([]);
    await consume(quiet, target(quiet, s, 'updated'));
    expect(sent.map((x) => x.name)).toEqual(['webhook.fanout']);
    expect(sent[0]!.request).toMatchObject({ data: { event: 'submission.updated' } });
  });

  it('makes one pending delivery and one webhook.deliver per subscribed, enabled webhook, and none for the others', async () => {
    const org = await seedOrg('hooks-fanout');
    const one = await seedWebhook(org);
    const two = await seedWebhook(org, { events: ['submission.created', 'submission.updated'] });
    const updatesOnly = await seedWebhook(org, { events: ['submission.updated'] });
    const off = await seedWebhook(org, { enabled: false });
    const s = await store(org);
    sent.length = 0;
    const def = definitionOf(deps, 'webhook.fanout') as Parameters<typeof runJob>[0];
    const job = receivedJob('webhook.fanout', org.id, org.form, 1, { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), formId: org.form, event: 'submission.created' });
    await runJob(def, job as never, { db: app.db, log });

    const { rows } = await owner.query<{ id: string; webhook_id: string; status: string; event: string; submission_id: string }>(
      'select id, webhook_id, status, event, submission_id from webhook_deliveries where org_id = $1 order by webhook_id',
      [org.id],
    );
    expect(rows.map((r) => r.webhook_id).sort()).toEqual([one.id, two.id].sort());
    expect(rows.map((r) => [r.status, r.event, r.submission_id])).toEqual(rows.map(() => ['pending', 'submission.created', s.id]));
    expect(rows.map((r) => r.webhook_id)).not.toContain(updatesOnly.id);
    expect(rows.map((r) => r.webhook_id)).not.toContain(off.id);
    expect(sent.map((x) => x.name)).toEqual(['webhook.deliver', 'webhook.deliver']);
    expect(sent.map((x) => x.request.resource).sort((x, y) => x.id.localeCompare(y.id))).toEqual(rows.map((r) => ({ type: 'webhook_delivery', id: r.id })).sort((x, y) => x.id.localeCompare(y.id)));
    expect(sent.every((x) => x.options?.tx !== undefined)).toBe(true);
    // The delivery ids are UUIDv7s the server made.
    expect(rows.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(r.id))).toBe(true);
  });

  it('fires exactly once per webhook when the queue hands a fan-out over again: submission.fanout twice, each webhook.fanout twice, two at once', async () => {
    const org = await seedOrg('hooks-once');
    const one = await seedWebhook(org);
    const two = await seedWebhook(org);
    const s = await store(org);
    const fanout = createSubmissionFanout([webhooksConsumer(deps)]) as unknown as Parameters<typeof runJob>[0];
    const fanoutJob = {
      id: randomUUID(),
      name: 'submission.fanout',
      attempt: 1,
      signal: new AbortController().signal,
      envelope: { v: 1, orgId: org.id, resource: { type: 'form', id: org.form }, data: { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), event: 'created' }, sig: 'k.x' },
    };
    sent.length = 0;
    // submission.fanout committed but was not marked complete (the worker died in between), so the queue runs it again.
    await runJob(fanout, fanoutJob as never, { db: app.db, log });
    await runJob(fanout, { ...fanoutJob, attempt: 2 } as never, { db: app.db, log });
    const fanouts = sent.filter((x) => x.name === 'webhook.fanout');
    expect(fanouts).toHaveLength(2);

    sent.length = 0;
    const def = definitionOf(deps, 'webhook.fanout') as Parameters<typeof runJob>[0];
    const jobOf = (x: (typeof fanouts)[number]) => receivedJob('webhook.fanout', org.id, org.form, 1, x.request.data as never);
    // The two copies at the same moment (two workers), then the first one again (its own ack was lost).
    await Promise.all(fanouts.map((x) => runJob(def, jobOf(x) as never, { db: app.db, log })));
    await runJob(def, jobOf(fanouts[0]!) as never, { db: app.db, log });

    const { rows } = await owner.query<{ webhook_id: string }>('select webhook_id from webhook_deliveries where org_id = $1', [org.id]);
    expect(rows.map((r) => r.webhook_id).sort()).toEqual([one.id, two.id].sort());
    expect(sent.map((x) => x.name)).toEqual(['webhook.deliver', 'webhook.deliver']);

    // An owner's replay is a deliberate resend: it neither counts as the delivery nor is stopped by it.
    const other = await store(org);
    await seedDelivery(org, one.id, other, { replayOf: randomUUID() });
    sent.length = 0;
    await runJob(def, receivedJob('webhook.fanout', org.id, org.form, 1, { submissionId: other.id, receivedAt: toIsoInstant(other.receivedAt), formId: org.form, event: 'submission.created' }) as never, { db: app.db, log });
    expect(sent.map((x) => x.name)).toEqual(['webhook.deliver', 'webhook.deliver']);
  });

  it('ignores a job whose response id is not a UUIDv7 or whose form is not its resource', async () => {
    const org = await seedOrg('hooks-forged');
    await seedWebhook(org);
    const s = await store(org);
    sent.length = 0;
    const def = definitionOf(deps, 'webhook.fanout') as Parameters<typeof runJob>[0];
    const bad = { submissionId: randomUUID(), receivedAt: new Date().toISOString(), formId: org.form, event: 'submission.created' as const };
    await runJob(def, receivedJob('webhook.fanout', org.id, org.form, 1, bad) as never, { db: app.db, log });
    const wrongForm = { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), formId: randomUUID(), event: 'submission.created' as const };
    await runJob(def, receivedJob('webhook.fanout', org.id, org.form, 1, wrongForm) as never, { db: app.db, log });
    const { rows } = await owner.query('select 1 from webhook_deliveries where org_id = $1', [org.id]);
    expect(rows).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('through the queue', () => {
  const queues: PgBossQueue[] = [];
  const errors: Error[] = [];

  afterAll(async () => {
    for (const q of queues) await q.stop({ graceMs: 1000 });
  });

  it('a complete response reaches an enabled webhook: submission.fanout, webhook.fanout, webhook.deliver, signed and recorded', async () => {
    await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
    const keyring = parseJobKeyring(`t1:${randomBytes(32).toString('base64url')}`);
    const worker = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'worker', applicationName: 'fr-worker-webhooks-test', pollingIntervalSeconds: 0.5, ...jobGuard(app.db, log), onError: (e) => errors.push(e) });
    const producer = createPgBossQueue({ connectionString: urls.fr_app, keyring, mode: 'producer', onError: (e) => errors.push(e) });
    queues.push(worker, producer);
    await worker.start();
    await producer.start();
    // The worker's own deps: the real queue, so the fan-out and the deliveries are enqueued in the job's transaction.
    const live = effectDeps({ queue: worker, now: () => new Date() });
    await startWorker({ db: app.db, log, queue: worker, jobs: [createSubmissionFanout([webhooksConsumer(live)]), ...webhookJobs(live)] });

    const org = await seedOrg('hooks-queue');
    const hook = await seedWebhook(org);
    const s = await store(org);
    await producer.send('submission.fanout', {
      orgId: org.id,
      resource: { type: 'form', id: org.form },
      data: { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), event: 'created' },
    });

    const delivery = await vi.waitFor(
      async () => {
        const { rows } = await owner.query<{ id: string; status: string }>('select id, status from webhook_deliveries where webhook_id = $1', [hook.id]);
        expect(rows.map((r) => r.status)).toEqual(['succeeded']);
        return rows[0]!.id;
      },
      { timeout: 30_000, interval: 250 },
    );
    const [hit, ...rest] = hitsOf(delivery);
    expect(rest).toEqual([]);
    expect(verifyWebhook(hit!.body, String(hit!.headers['form-signature']), hook.secret)).toBe(true);
    expect(JSON.parse(hit!.body).submission).toMatchObject({ id: s.id, answers: { full_name: 'Asha', pan: MASK, note: 'plain' } });
    expect((await disclosuresOf(hook.id)).map((d) => d.field_keys)).toEqual([['full_name', 'note']]);
    expect(errors).toEqual([]);
  });
});
