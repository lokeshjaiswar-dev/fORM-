import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createPgBossQueue, installQueueSchema, parseJobKeyring, type PgBossQueue } from '@form/adapters/queue';
import { createSmtpMailer } from '@form/adapters/mailer';
import { createDb, newSubmissionKey, provision, withTenant, type DbHandle } from '@form/db';
import { JOB_POLICIES, MailDeliveryError, PortError, toIsoInstant, type JobData, type JobName, type JobResource, type MailMessage, type Mailer, type ReceivedJob } from '@form/ports';
import { createTestDatabase, startMailpit, type MailpitServer } from '@form/testkit';
import { unavailableOrgSecrets, type EffectDeps } from '../src/effects/deps.ts';
import { resolveRecipients } from '../src/effects/email/recipients.ts';
import { jobGuard } from '../src/guard.ts';
import { createEffectFanout, createEffectJobs, createSubmissionFanout, type JobDefinition } from '../src/jobs/index.ts';
import { MAIL_ADDRESS_REFUSED, MAIL_ADDRESS_UNRESOLVED, notificationsConsumer } from '../src/jobs/notifications.ts';
import { runJob, startWorker } from '../src/runtime.ts';
import { answered, compiledOf, definitionOf, emailDoc, maskedField, MARKETING, notificationConfig, omittedField, para, personal, pipe, RESPOND, table, text } from './email-fixtures.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.16 (NOT-01..05): the notifications consumer, `notification.dispatch` and `email.send` against a real Postgres with RLS
 * and the real pg-boss queue. The Mailer is a fake that throws what the port says it throws (PortError `unavailable`,
 * `rejected`, a temporary MailDeliveryError) except in the last describe, which sends through a real SMTP server (Mailpit
 * in Testcontainers, local Docker: this worker's egress allowlist is localhost).
 */

const PAN = 'ABCDE1234F';
const SSN = '123-45-6789';
const DOMAIN = 'mail.acme.example';
const log = pino({ level: 'silent' });
const secret = () => randomBytes(32).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface Org {
  id: string;
  /** Active owner, verified. */
  ownerUser: string;
  /** Active admin, verified. */
  adminUser: string;
  /** Active editor whose email is not verified. */
  unverifiedUser: string;
  /** An admin whose membership is suspended. */
  suspendedUser: string;
  /** A user who belongs to nobody. */
  strangerUser: string;
  form: string;
  other: string;
  version: string;
}

let owner: pg.Pool;
let app: DbHandle;
let producer: PgBossQueue;
const queues: PgBossQueue[] = [];
let url: string;
let keySecret: string;
let a: Org;
let b: Org;

/** The form of the tests: a plain name, the respondent's email, a masked PAN, an omitted SSN and a marketing-only phone. */
const blocks = [
  personal('name'),
  personal('mail', {}, { type: 'email' }),
  maskedField('pan', 'PAN'),
  omittedField('ssn', 'SSN'),
  personal('promo_phone', { purposeIds: [MARKETING] }, { label: 'Promo phone' }),
];
const definition = definitionOf(blocks, 'Contact us');
const compiled = compiledOf(definition);
const ANSWERS = answered({
  name: ['short_text', 'Asha'],
  mail: ['email', { address: 'asha@respondent.test' }],
  pan: ['short_text', PAN],
  ssn: ['short_text', SSN],
  promo_phone: ['short_text', '9876543210'],
});

async function insertUser(email: string, o: { verified?: boolean; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await owner.query(`insert into users (id, email, email_norm, email_verified_at, name) values ($1, $2, $2, $3, $4)`, [id, email, o.verified === false ? null : new Date(), o.name ?? null]);
  return id;
}

async function seedOrg(slug: string): Promise<Org> {
  const org: Org = { id: randomUUID(), ownerUser: '', adminUser: '', unverifiedUser: '', suspendedUser: '', strangerUser: '', form: randomUUID(), other: randomUUID(), version: randomUUID() };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  org.ownerUser = await insertUser(`owner@${slug}.test`, { name: 'Olive Owner' });
  org.adminUser = await insertUser(`admin@${slug}.test`);
  org.unverifiedUser = await insertUser(`unverified@${slug}.test`, { verified: false });
  org.suspendedUser = await insertUser(`suspended@${slug}.test`);
  org.strangerUser = await insertUser(`stranger@${slug}.test`);
  for (const [user, role, status] of [
    [org.ownerUser, 'owner', 'active'],
    [org.adminUser, 'admin', 'active'],
    [org.unverifiedUser, 'editor', 'active'],
    [org.suspendedUser, 'admin', 'suspended'],
  ] as const) {
    await owner.query('insert into memberships (org_id, user_id, role, status) values ($1, $2, $3, $4)', [org.id, user, role, status]);
  }
  for (const form of [org.form, org.other]) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [form, org.id, randomUUID(), org.ownerUser, form === org.form ? 'Contact us' : 'Other form']);
  }
  await owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, $5, $6, $7)`,
    [org.version, org.id, org.form, org.ownerUser, JSON.stringify(definition), JSON.stringify(compiled), '0'.repeat(64)],
  );
  return org;
}

interface Stored {
  id: string;
  receivedAt: Date;
}

async function store(org: Org, o: { status?: string; answers?: unknown; locale?: string } = {}): Promise<Stored> {
  const { id, receivedAt } = newSubmissionKey(new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
     values ($1, $2, $3, $4, $5, $6, 0, $7, $8, '{}', $9)`,
    [id, receivedAt, org.id, org.form, org.version, Buffer.alloc(32), o.status ?? 'complete', JSON.stringify(o.answers ?? ANSWERS), JSON.stringify({ locale: o.locale ?? 'en-IN' })],
  );
  return { id, receivedAt };
}

/** A smtp secret and the sender that names it. The secret's bytes are never opened here: `mailerFor` is a fake. */
async function seedSender(org: Org): Promise<{ senderId: string; secretId: string }> {
  const secretId = randomUUID();
  await owner.query(`insert into secrets (id, org_id, kind, enc, meta) values ($1, $2, 'smtp', '{}', '{}')`, [secretId, org.id]);
  const senderId = randomUUID();
  await owner.query(`insert into email_senders (id, org_id, name, from_address, from_name, smtp_secret_id) values ($1, $2, 'Acme forms', 'forms@acme.example', 'Acme Forms', $3)`, [senderId, org.id, secretId]);
  return { senderId, secretId };
}

interface NotificationOptions {
  kind?: 'owner' | 'autoresponder';
  trigger?: 'submitted' | 'edited';
  enabled?: boolean;
  senderId?: string;
  form?: string;
  /** Overrides of the `NotificationConfig` (the columns the worker queries follow `kind`, `trigger`, `enabled`, `senderId`, `purposeIds`). */
  config?: Record<string, unknown>;
}

/** A notification: the columns the worker queries and the `config` jsonb the API validated, kept in step as the API keeps them. */
async function seedNotification(org: Org, o: NotificationOptions = {}): Promise<string> {
  const id = randomUUID();
  const kind = o.kind ?? 'owner';
  const purposeIds = (o.config?.purposeIds as string[] | undefined) ?? [RESPOND];
  const config = notificationConfig({
    id,
    kind,
    ...(o.trigger ? { trigger: o.trigger } : {}),
    enabled: o.enabled ?? true,
    to: [{ kind: 'role', role: 'org_admins' }] as never,
    subject: ['New response from ', { pipe: pipe('name').attrs }],
    body: emailDoc(para(text('PAN '), pipe('pan'), text(' SSN '), pipe('ssn')), table(), { type: 'button', attrs: { label: 'View', action: 'view_submission' } }),
    ...(o.senderId ? { senderId: o.senderId } : {}),
    ...(o.config ?? {}),
  } as never);
  await owner.query(
    `insert into notifications (id, org_id, form_id, kind, enabled, trigger, sender_id, config, purpose_ids) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, org.id, o.form ?? org.form, kind, o.enabled ?? true, o.trigger ?? 'submitted', o.senderId ?? null, JSON.stringify(config), purposeIds],
  );
  return id;
}

async function updateConfig(id: string, patch: Record<string, unknown>): Promise<void> {
  await owner.query(`update notifications set config = config || $2::jsonb where id = $1`, [id, JSON.stringify(patch)]);
}

// ─── what the tests look at ───────────────────────────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  created_at: Date;
  org_id: string;
  form_id: string;
  submission_id: string;
  notification_id: string;
  role: string;
  to_display_masked: string[];
  subject_hash: Buffer;
  message_id: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  sent_at: Date | null;
}

const messagesOf = async (submissionId: string, notificationId?: string): Promise<MessageRow[]> =>
  (
    await owner.query<MessageRow>(`select * from email_messages where submission_id = $1 and ($2::uuid is null or notification_id = $2) order by created_at, id`, [submissionId, notificationId ?? null])
  ).rows;

const messageById = async (id: string): Promise<MessageRow> => (await owner.query<MessageRow>('select * from email_messages where id = $1', [id])).rows[0]!;

interface DisclosureRow {
  recipient_kind: string;
  recipient_id: string;
  display_name: string;
  field_keys: string[];
}

const disclosuresOf = async (submissionId: string): Promise<DisclosureRow[]> =>
  (await owner.query<DisclosureRow>('select recipient_kind, recipient_id, display_name, field_keys from disclosures where submission_id = $1 order by at, id', [submissionId])).rows;

/** The jobs a queue holds for one response, by envelope. */
async function queuedJobs(name: JobName, o: { orgId?: string; submissionId?: string; messageId?: string } = {}): Promise<Array<{ resource: JobResource; data: Record<string, unknown>; orgId: string | null }>> {
  const { rows } = await owner.query<{ envelope: { orgId: string | null; resource: JobResource; data: Record<string, unknown> } }>(
    `select data as envelope from pgboss.job where name = $1
       and ($2::text is null or data->>'orgId' = $2)
       and ($3::text is null or data->'data'->>'submissionId' = $3)
       and ($4::text is null or data->'resource'->>'id' = $4)
     order by created_on`,
    [name, o.orgId ?? null, o.submissionId ?? null, o.messageId ?? null],
  );
  return rows.map((r) => ({ resource: r.envelope.resource, data: r.envelope.data, orgId: r.envelope.orgId }));
}

// ─── the effect deps and a job runner ─────────────────────────────────────────────────────────────────────────

interface FakeMailer {
  mailer: Mailer;
  /** Every message `send` was given, in order. */
  sent: MailMessage[];
  /** What the next calls do: `ok`, or an error to throw. Past the end it is `ok`. */
  script: Array<'ok' | Error>;
  /** `mailerFor` calls: the org and sender the job asked for. */
  asked: Array<{ orgId: string; senderId: string | null }>;
}

function fakeMailer(): FakeMailer {
  const f: FakeMailer = {
    sent: [],
    script: [],
    asked: [],
    mailer: {
      async send(m) {
        f.sent.push(m);
        const next = f.script.shift() ?? 'ok';
        if (next !== 'ok') throw next;
        return { messageId: m.messageId ?? '<no-id@test>', refused: [] };
      },
      async verify() {
        return { ok: true };
      },
    },
  };
  return f;
}

function makeDeps(queue: PgBossQueue, mail: Pick<FakeMailer, 'mailer' | 'asked'>): EffectDeps {
  return {
    db: app.db,
    queue,
    orgSecrets: unavailableOrgSecrets,
    mailerFor: (orgId, senderId) => {
      mail.asked.push({ orgId, senderId: senderId ?? null });
      return mail.mailer;
    },
    tenantEgress: { assertAllowed: async () => ({ pinnedIp: '127.0.0.1' }) },
    // An email job makes no HTTP request to a tenant's address; one that tried would be a leak, so the fake fails loudly.
    tenantHttp: async () => {
      throw new Error('a notification job must not call tenantHttp');
    },
    config: { publicBuilderUrl: 'https://forms.acme.example', mailFrom: { address: 'noreply@acme.example', name: 'fORM-' }, messageIdDomain: DOMAIN, webhookUserAgent: 'fORM-test' },
    now: () => new Date(),
  };
}

const mail = fakeMailer();
let deps: EffectDeps;
let effectJobs: ReturnType<typeof createEffectJobs>;

const definitionFor = <N extends JobName>(name: N): JobDefinition<N> => effectJobs.find((j) => j.name === name) as unknown as JobDefinition<N>;

function received<N extends JobName>(name: N, orgId: string | null, resource: JobResource, data: JobData[N], attempt: number): ReceivedJob<N> {
  return { id: randomUUID(), name, attempt, envelope: { v: 1, orgId, resource, data, sig: 'test' } as never, signal: new AbortController().signal };
}

/** Runs a handler the way the worker does (tenant, actor system), on the attempt number the test chooses. */
const run = <N extends JobName>(name: N, orgId: string | null, resource: JobResource, data: JobData[N], attempt = 1) =>
  runJob(definitionFor(name), received(name, orgId, resource, data, attempt), { db: app.db, log });

const dispatch = (org: Org, s: Stored, notificationId: string, o: { form?: string } = {}) =>
  run('notification.dispatch', org.id, { type: 'form', id: o.form ?? org.form }, { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), notificationId });

const send = (org: Org, messageId: string, attempt = 1) => run('email.send', org.id, { type: 'email_message', id: messageId }, { emailMessageId: messageId }, attempt);

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker_notifications');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  url = urls.fr_app;
  await installQueueSchema({ connectionString: urls.fr_migrator, appRole: 'fr_app' });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 8, applicationName: 'fr-worker-notifications-test' });
  keySecret = secret();
  producer = createPgBossQueue({ connectionString: url, keyring: parseJobKeyring(`t1:${keySecret}`), mode: 'producer' });
  queues.push(producer);
  await producer.start();
  deps = makeDeps(producer, mail);
  effectJobs = createEffectJobs(deps);
  a = await seedOrg('notify-a');
  b = await seedOrg('notify-b');
});

afterAll(async () => {
  for (const q of queues) await q.stop({ graceMs: 1000 });
  await app?.close();
  await owner?.end();
});

// ─── the consumer of submission.fanout ────────────────────────────────────────────────────────────────────────

describe('notificationsConsumer: submission.fanout of a complete response', () => {
  async function fanOut(org: Org, s: Stored, event: 'created' | 'updated' | 'released' = 'created'): Promise<void> {
    const def = createSubmissionFanout([notificationsConsumer(deps)]);
    await runJob(def, received('submission.fanout', org.id, { type: 'form', id: org.form }, { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), event }, 1), { db: app.db, log });
  }

  it('enqueues one notification.dispatch per enabled notification: 2 enabled and 1 disabled give 2 jobs, naming the form, the response and the notification and no answer', async () => {
    const first = await seedNotification(a);
    const second = await seedNotification(a, { kind: 'autoresponder' });
    const off = await seedNotification(a, { enabled: false });
    const s = await store(a);
    await fanOut(a, s);
    const jobs = await queuedJobs('notification.dispatch', { submissionId: s.id });
    expect(jobs.map((j) => j.data.notificationId).sort()).toEqual([first, second].sort());
    expect(jobs.map((j) => j.data.notificationId)).not.toContain(off);
    for (const j of jobs) {
      expect(j.orgId).toBe(a.id);
      expect(j.resource).toEqual({ type: 'form', id: a.form });
      expect(j.data).toEqual({ submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), notificationId: expect.any(String) });
    }
    expect(JSON.stringify(jobs)).not.toContain('Asha');
  });

  it('does not dispatch a notification of the other trigger, a delayed one, one of another form, or any for a held response', async () => {
    const [x, y] = await Promise.all([seedOrg('consumer-x'), seedOrg('consumer-y')]);
    const now = await seedNotification(x);
    await seedNotification(x, { trigger: 'edited' });
    await seedNotification(x, { config: { delay: { kind: 'after', minutes: 5 } } });
    await seedNotification(x, { form: x.other });
    const noDelay = await seedNotification(x, { config: { delay: { kind: 'none' } } });
    await seedNotification(y);
    const s = await store(x);
    await fanOut(x, s);
    expect((await queuedJobs('notification.dispatch', { submissionId: s.id })).map((j) => j.data.notificationId).sort()).toEqual([now, noDelay].sort());

    const held = await store(x, { status: 'pending_review' });
    await fanOut(x, held);
    expect(await queuedJobs('notification.dispatch', { submissionId: held.id })).toEqual([]);
  });

  it('maps released to the submitted trigger and updated to the edited one', async () => {
    const c = await seedOrg('consumer-events');
    const submitted = await seedNotification(c);
    const edited = await seedNotification(c, { trigger: 'edited' });
    const s = await store(c);
    await fanOut(c, s, 'released');
    expect((await queuedJobs('notification.dispatch', { submissionId: s.id })).map((j) => j.data.notificationId)).toEqual([submitted]);
    const t = await store(c);
    await fanOut(c, t, 'updated');
    expect((await queuedJobs('notification.dispatch', { submissionId: t.id })).map((j) => j.data.notificationId)).toEqual([edited]);
  });

  it('enqueues in the fan-out transaction: when the fan-out fails after the consumer, no dispatch is left behind', async () => {
    const c = await seedOrg('consumer-rollback');
    await seedNotification(c);
    const s = await store(c);
    const consumer = notificationsConsumer(deps);
    const def = createSubmissionFanout([
      consumer,
      async () => {
        throw new Error('a later consumer failed');
      },
    ]);
    await expect(runJob(def, received('submission.fanout', c.id, { type: 'form', id: c.form }, { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), event: 'created' }, 1), { db: app.db, log })).rejects.toThrow('a later consumer failed');
    expect(await queuedJobs('notification.dispatch', { submissionId: s.id })).toEqual([]);
  });
});

// ─── notification.dispatch ────────────────────────────────────────────────────────────────────────────────────

describe('notification.dispatch', () => {
  it('inserts one email_messages row and one disclosures row, without the out-of-purpose, omitted or masked fields, and enqueues email.send', async () => {
    const n = await seedNotification(a, { config: { to: [{ kind: 'member', userId: a.adminUser }, { kind: 'field', blockId: 'mail' }] } });
    const s = await store(a);
    await dispatch(a, s, n);

    const messages = await messagesOf(s.id);
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m).toMatchObject({ org_id: a.id, form_id: a.form, notification_id: n, role: 'owner', status: 'queued', attempts: 0, provider_message_id: null, last_error: null, sent_at: null });
    expect(m.message_id).toBe(`<${m.id}@${DOMAIN}>`);
    expect(m.to_display_masked).toEqual(['a***@notify-a.test', 'a***@respondent.test']);
    // The subject hash is the sha256 of the rendered subject; the log keeps no subject, no body and no address.
    expect(m.subject_hash.toString('hex')).toBe(sha256('New response from Asha'));
    expect(JSON.stringify(m)).not.toContain('admin@notify-a.test');
    expect(JSON.stringify(m)).not.toContain('asha@respondent.test');

    const ledger = await disclosuresOf(s.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ recipient_kind: 'notification', recipient_id: n, display_name: 'a***@notify-a.test, a***@respondent.test' });
    // name and mail were disclosed in the clear. pan was masked (its value did not leave), ssn omitted and promo_phone is another purpose's.
    expect([...ledger[0]!.field_keys].sort()).toEqual(['mail', 'name']);

    const jobs = await queuedJobs('email.send', { messageId: m.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ orgId: a.id, resource: { type: 'email_message', id: m.id }, data: { emailMessageId: m.id } });
  });

  it('the whole flow: a fan-out of a complete response with 2 enabled and 1 disabled notification ends in 2 messages, 2 ledger rows and 2 send jobs', async () => {
    const c = await seedOrg('flow');
    const first = await seedNotification(c);
    const second = await seedNotification(c, { kind: 'autoresponder', config: { to: [{ kind: 'field', blockId: 'mail' }] } });
    await seedNotification(c, { enabled: false });
    const s = await store(c);
    const def = createSubmissionFanout([notificationsConsumer(deps)]);
    await runJob(def, received('submission.fanout', c.id, { type: 'form', id: c.form }, { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), event: 'created' }, 1), { db: app.db, log });
    const dispatches = await queuedJobs('notification.dispatch', { submissionId: s.id });
    expect(dispatches).toHaveLength(2);
    for (const d of dispatches) await run('notification.dispatch', c.id, d.resource, d.data as unknown as JobData['notification.dispatch']);
    expect((await messagesOf(s.id)).map((m) => [m.notification_id, m.role]).sort()).toEqual([[first, 'owner'], [second, 'autoresponder']].sort());
    expect(await disclosuresOf(s.id)).toHaveLength(2);
    for (const m of await messagesOf(s.id)) expect(await queuedJobs('email.send', { messageId: m.id })).toHaveLength(1);
  });

  it('writes the message once per response and notification: a fan-out delivered twice, or two dispatches at the same time, make one message', async () => {
    const n = await seedNotification(a);
    const s = await store(a);
    await Promise.all([dispatch(a, s, n), dispatch(a, s, n)]);
    await dispatch(a, s, n);
    expect(await messagesOf(s.id, n)).toHaveLength(1);
    expect(await disclosuresOf(s.id)).toHaveLength(1);
    expect(await queuedJobs('email.send', { messageId: (await messagesOf(s.id, n))[0]!.id })).toHaveLength(1);
  });

  it('makes a message for each notification of the response, each to its own people', async () => {
    const owners = await seedNotification(a, { config: { to: [{ kind: 'role', role: 'form_owner' }] } });
    const respondent = await seedNotification(a, { kind: 'autoresponder', config: { to: [{ kind: 'field', blockId: 'mail' }], replyTo: { kind: 'role', role: 'form_owner' } } });
    const s = await store(a);
    await dispatch(a, s, owners);
    await dispatch(a, s, respondent);
    expect((await messagesOf(s.id, owners))[0]!.to_display_masked).toEqual(['o***@notify-a.test']);
    expect((await messagesOf(s.id, respondent))[0]!.to_display_masked).toEqual(['a***@respondent.test']);
  });

  it('sends nothing for a response that is held, a notification that is off or gone, a respondent who gave no address, or an id that is not a uuid', async () => {
    const on = await seedNotification(a);
    const off = await seedNotification(a, { enabled: false });
    const auto = await seedNotification(a, { kind: 'autoresponder', config: { to: [{ kind: 'field', blockId: 'mail' }] } });
    const held = await store(a, { status: 'pending_review' });
    await dispatch(a, held, on);
    expect(await messagesOf(held.id)).toEqual([]);

    const s = await store(a);
    await dispatch(a, s, off);
    await dispatch(a, s, randomUUID());
    await dispatch(a, s, 'not-a-uuid');
    expect(await messagesOf(s.id)).toEqual([]);

    const noAddress = await store(a, { answers: { ...ANSWERS, mail: { type: 'email', value: { address: '' } } } });
    await dispatch(a, noAddress, auto);
    expect(await messagesOf(noAddress.id)).toEqual([]);
    expect(await disclosuresOf(noAddress.id)).toEqual([]);
  });

  it('honours a notification that is off in its config even when the column the worker queries still says on', async () => {
    const n = await seedNotification(a, { config: { enabled: false } });
    await owner.query('update notifications set enabled = true where id = $1', [n]);
    const s = await store(a);
    await dispatch(a, s, n);
    expect(await messagesOf(s.id)).toEqual([]);
  });

  it('an autoresponder reads the respondent’s address only from a field in the notification’s purposes', async () => {
    const outside = await seedNotification(a, { kind: 'autoresponder', config: { purposeIds: [MARKETING], to: [{ kind: 'field', blockId: 'mail' }] } });
    const s = await store(a);
    await dispatch(a, s, outside);
    expect(await messagesOf(s.id)).toEqual([]);
  });

  it('is scoped to the org and the form the job names: another org’s notification or response, and another form’s, are not found', async () => {
    const mine = await seedNotification(a);
    const theirs = await seedNotification(b);
    const s = await store(a);
    const t = await store(b);
    await dispatch(b, s, mine, { form: b.form });
    await dispatch(a, t, theirs, { form: a.form });
    await dispatch(a, s, theirs);
    await dispatch(a, s, mine, { form: a.other });
    expect(await messagesOf(s.id)).toEqual([]);
    expect(await messagesOf(t.id)).toEqual([]);
  });

  it('fails the job, with the paths and no values, when the stored config is not a NotificationConfig', async () => {
    const n = await seedNotification(a);
    await owner.query(`update notifications set config = config || '{"subject": "not a template"}'::jsonb where id = $1`, [n]);
    const s = await store(a);
    await expect(dispatch(a, s, n)).rejects.toThrow(/not a valid NotificationConfig \(subject\)/);
    expect(await messagesOf(s.id)).toEqual([]);
  });

  it('follows the respondent’s language to a locale variant', async () => {
    const hindi = { id: 'v_hi', name: 'Hindi', locale: 'hi-IN', subject: ['नई प्रतिक्रिया'], body: emailDoc(para(text('नमस्ते'))) };
    const n = await seedNotification(a, { config: { variants: [hindi] } });
    const s = await store(a, { locale: 'hi-IN' });
    const t = await store(a, { locale: 'en-IN' });
    await dispatch(a, s, n);
    await dispatch(a, t, n);
    expect((await messagesOf(s.id, n))[0]!.subject_hash.toString('hex')).toBe(sha256('नई प्रतिक्रिया'));
    expect((await messagesOf(t.id, n))[0]!.subject_hash.toString('hex')).toBe(sha256('New response from Asha'));
  });
});

// ─── recipients that need the database ────────────────────────────────────────────────────────────────────────

describe('resolveRecipients: members and roles of the org', () => {
  const resolve = (org: Org, lists: Record<string, unknown>) =>
    withTenant(app.db, { orgId: org.id, actor: 'system', requestId: 'test:recipients', perms: [] }, (tx) => resolveRecipients(tx, { to: [], ...lists } as never, { orgId: org.id, formId: org.form, fields: [] }));

  it('names an active member with a verified email, and nobody for an unverified one, a suspended one, a stranger or another org’s member', async () => {
    const r = await resolve(a, {
      to: [
        { kind: 'member', userId: a.adminUser },
        { kind: 'member', userId: a.unverifiedUser },
        { kind: 'member', userId: a.suspendedUser },
        { kind: 'member', userId: a.strangerUser },
        { kind: 'member', userId: b.adminUser },
        { kind: 'member', userId: randomUUID() },
      ],
    });
    expect(r.to).toEqual([{ address: 'admin@notify-a.test' }]);
    expect(r.skipped).toBe(5);
  });

  it('org_admins is the active owners and admins of this org only, and form_owner is the form’s owner while they are an active member', async () => {
    const admins = await resolve(a, { to: [{ kind: 'role', role: 'org_admins' }] });
    expect(admins.to.map((x) => x.address).sort()).toEqual(['admin@notify-a.test', 'owner@notify-a.test']);
    expect(admins.to.find((x) => x.address === 'owner@notify-a.test')).toEqual({ address: 'owner@notify-a.test', name: 'Olive Owner' });
    expect((await resolve(a, { to: [{ kind: 'role', role: 'form_owner' }] })).to).toEqual([{ address: 'owner@notify-a.test', name: 'Olive Owner' }]);
    // team_admins has no model yet.
    expect((await resolve(a, { to: [{ kind: 'role', role: 'team_admins' }] })).to).toEqual([]);
    // The form's owner who has since left the org gets nothing.
    const c = await seedOrg('left-the-org');
    await owner.query('update forms set owner_user_id = $2 where id = $1', [c.form, c.suspendedUser]);
    expect((await resolve(c, { to: [{ kind: 'role', role: 'form_owner' }] })).to).toEqual([]);
  });

  it('keeps a person once when they are named by id and by role, and lists a mix of kinds in the order written', async () => {
    const r = await resolve(a, { to: [{ kind: 'member', userId: a.adminUser }, { kind: 'role', role: 'org_admins' }, { kind: 'email', address: 'extra@acme.example' }], cc: [{ kind: 'role', role: 'form_owner' }] });
    expect(r.to.map((x) => x.address)).toEqual(['admin@notify-a.test', 'owner@notify-a.test', 'extra@acme.example']);
    expect(r.cc).toEqual([]);
  });
});

// ─── email.send ───────────────────────────────────────────────────────────────────────────────────────────────

describe('email.send', () => {
  /** A queued message for a fresh response, as the dispatch leaves it. */
  async function queued(o: NotificationOptions = {}, answers?: unknown): Promise<{ org: Org; id: string; message: MessageRow; notification: string; s: Stored }> {
    const notification = await seedNotification(a, o);
    const s = await store(a, answers === undefined ? {} : { answers });
    await dispatch(a, s, notification);
    const message = (await messagesOf(s.id, notification))[0]!;
    mail.sent.length = 0;
    mail.asked.length = 0;
    mail.script.length = 0;
    return { org: a, id: message.id, message, notification, s };
  }

  it('a server that is unavailable leaves the row retrying with attempts 1 and a scrubbed last_error, and the job throws', async () => {
    const m = await queued();
    mail.script.push(new PortError('unavailable', 'connect ECONNREFUSED smtp://relay-user:s3cret@smtp.acme.example:587 for admin@notify-a.test'));
    await expect(send(a, m.id)).rejects.toThrow(/unavailable/);
    const row = await messageById(m.id);
    expect(row).toMatchObject({ status: 'retrying', attempts: 1, provider_message_id: null, sent_at: null });
    expect(row.last_error).toMatch(/^unavailable: /);
    expect(row.last_error).not.toContain('s3cret');
    expect(row.last_error).not.toContain('relay-user');
    expect(row.last_error).not.toContain('admin@notify-a.test');
    expect(row.last_error).toContain('[url]');
  });

  it('a later success sends it: the same Message-ID on both tries, sent with the provider id and time, the old error cleared; a sent row is not sent again', async () => {
    const m = await queued();
    mail.script.push(new PortError('unavailable', 'try later'));
    await expect(send(a, m.id, 1)).rejects.toThrow();
    await send(a, m.id, 2);
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent.map((x) => x.messageId)).toEqual([m.message.message_id, m.message.message_id]);
    expect(mail.sent[0]!.messageId).toBe(`<${m.id}@${DOMAIN}>`);
    const row = await messageById(m.id);
    expect(row).toMatchObject({ status: 'sent', attempts: 2, provider_message_id: m.message.message_id, last_error: null });
    expect(row.sent_at).toBeInstanceOf(Date);

    // The queue delivering the job again, or a second worker taking it, sends nothing more.
    await send(a, m.id, 3);
    await send(a, m.id, 1);
    expect(mail.sent).toHaveLength(2);
    expect(await messageById(m.id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('the last attempt of the queue’s policy marks the row failed (and the job still throws, for the dead-letter queue)', async () => {
    const m = await queued();
    const last = JOB_POLICIES['email.send'].retryLimit + 1;
    mail.script.push(new PortError('unavailable', 'still down'));
    await expect(send(a, m.id, last - 1)).rejects.toThrow();
    expect(await messageById(m.id)).toMatchObject({ status: 'retrying', attempts: 1 });
    mail.script.push(new PortError('unavailable', 'still down'));
    await expect(send(a, m.id, last)).rejects.toThrow();
    expect(await messageById(m.id)).toMatchObject({ status: 'failed', attempts: 2 });
    // A failed row is final: nothing is sent for it again.
    await send(a, m.id, 1);
    expect(mail.sent).toHaveLength(2);
  });

  it('a temporary refusal (MailDeliveryError unavailable) is retried, a permanent one (rejected) fails the row at once and does not throw', async () => {
    const temporary = await queued();
    mail.script.push(new MailDeliveryError('unavailable', 'recipients', [{ address: 'admin@notify-a.test', permanent: false, response: '451 4.2.1 mailbox busy' }], 'recipient admin@notify-a.test deferred: 451'));
    await expect(send(a, temporary.id)).rejects.toThrow();
    expect(await messageById(temporary.id)).toMatchObject({ status: 'retrying', attempts: 1 });

    const permanent = await queued();
    mail.script.push(new MailDeliveryError('rejected', 'message', [], '554 5.6.0 message refused'));
    await send(a, permanent.id);
    expect(await messageById(permanent.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'rejected: 554 5.6.0 message refused' });
    // Tried once (the helper clears the log at the start of each message), and not again.
    expect(mail.sent).toHaveLength(1);
  });

  it.each([
    ['invalid_argument', new PortError('invalid_argument', 'a header contains CR or LF')],
    ['egress_denied', new PortError('egress_denied', 'smtp.acme.example is not on the allowlist')],
    ['not_found', new PortError('not_found', 'no such SMTP sender')],
  ])('%s fails the row without a retry', async (_code, error) => {
    const m = await queued();
    mail.script.push(error);
    await send(a, m.id);
    expect(await messageById(m.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(mail.sent).toHaveLength(1);
  });

  it('keeps no address the egress guard resolved the relay to in last_error, which every reader of the Email log sees (no DNS oracle)', async () => {
    const refused = await queued();
    mail.script.push(new PortError('egress_denied', 'egress to smtp://mail.internal:25 denied: 10.42.7.13 is not a public address'));
    await send(a, refused.id);
    const row = await messageById(refused.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: `egress_denied: ${MAIL_ADDRESS_REFUSED}` });
    expect(row.last_error).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}|mail\.internal/);

    const v6 = await queued();
    mail.script.push(new PortError('egress_denied', 'egress to smtp://mail.internal:25 denied: fd00:7:13::25 is not a public address'));
    await send(a, v6.id);
    expect((await messageById(v6.id)).last_error).toBe(`egress_denied: ${MAIL_ADDRESS_REFUSED}`);

    // A name that did not resolve (the guard keeps the resolver's error as the cause) may be a DNS blip: retried, and still no guard text.
    const unresolved = await queued();
    mail.script.push(new PortError('egress_denied', 'egress to mail.internal denied: it does not resolve', { cause: new Error('getaddrinfo ENOTFOUND mail.internal') }));
    await expect(send(a, unresolved.id)).rejects.toThrow();
    expect(await messageById(unresolved.id)).toMatchObject({ status: 'retrying', attempts: 1, last_error: `egress_denied: ${MAIL_ADDRESS_UNRESOLVED}` });
  });

  it('an unexpected error is treated as temporary and retried', async () => {
    const m = await queued();
    mail.script.push(new TypeError('socket hang up'));
    await expect(send(a, m.id)).rejects.toThrow();
    expect(await messageById(m.id)).toMatchObject({ status: 'retrying', attempts: 1, last_error: 'error: socket hang up' });
  });

  it('sends the rendered message: subject from the answers, MASK for the masked field, nothing of the omitted or out-of-purpose ones, the platform sender by default', async () => {
    const m = await queued({ config: { to: [{ kind: 'role', role: 'org_admins' }], cc: [{ kind: 'email', address: 'cc@acme.example' }], bcc: [{ kind: 'member', userId: a.ownerUser }], replyTo: { kind: 'field', blockId: 'mail' } } });
    await send(a, m.id);
    expect(mail.asked).toEqual([{ orgId: a.id, senderId: null }]);
    const sent = mail.sent[0]!;
    expect(sent.from).toEqual({ address: 'noreply@acme.example', name: 'fORM-' });
    expect(sent.to.map((x) => x.address)).toEqual(['admin@notify-a.test', 'owner@notify-a.test']);
    expect(sent.cc).toEqual([{ address: 'cc@acme.example' }]);
    // The owner is already in To, so the bcc names nobody new.
    expect(sent.bcc).toBeUndefined();
    expect(sent.replyTo).toEqual({ address: 'asha@respondent.test' });
    expect(sent.subject).toBe('New response from Asha');
    expect(sent.text).toContain('PAN ••••••');
    expect(sent.text).toContain('Label of name: Asha');
    expect(sent.html).toContain('https://forms.acme.example/forms/');
    for (const out of [sent.text, sent.html, sent.subject]) {
      expect(out).not.toContain(PAN);
      expect(out).not.toContain(SSN);
      expect(out).not.toContain('9876543210');
      expect(out).not.toContain('Promo phone');
    }
  });

  it('sends through the org’s own sender with its address, name and secret', async () => {
    const { senderId, secretId } = await seedSender(a);
    const m = await queued({ senderId });
    await send(a, m.id);
    expect(mail.asked).toEqual([{ orgId: a.id, senderId }]);
    expect(mail.sent[0]).toMatchObject({ from: { address: 'forms@acme.example', name: 'Acme Forms' }, senderSecretRef: secretId });
  });

  it('uses the notification’s fromName, with merge tags and no line breaks', async () => {
    const m = await queued({ config: { fromName: ['Team of ', { pipe: pipe('name').attrs }, '\r\nBcc: x@y.test'] } });
    await send(a, m.id);
    expect(mail.sent[0]!.from).toEqual({ address: 'noreply@acme.example', name: 'Team of Asha Bcc: x@y.test' });
  });

  it('renders again at send time: a notification edited since the dispatch decides what goes out and what the log says', async () => {
    const m = await queued();
    // The owner makes it stricter after the dispatch: sensitive fields are omitted.
    await updateConfig(m.notification, { sensitiveOverride: 'omit', subject: ['Changed: ', { pipe: pipe('name').attrs }] });
    await send(a, m.id);
    expect(mail.sent[0]!.subject).toBe('Changed: Asha');
    expect(mail.sent[0]!.text).not.toContain('••••••');
    expect((await messageById(m.id)).subject_hash.toString('hex')).toBe(sha256('Changed: Asha'));
  });

  it('records a field in the ledger before it is sent when the notification was widened after the dispatch', async () => {
    const m = await queued();
    expect((await disclosuresOf(m.s.id))[0]!.field_keys.sort()).toEqual(['mail', 'name']);
    // The notification now also has the marketing purpose: the render at send time includes the promo phone.
    await owner.query(`update notifications set purpose_ids = $2 where id = $1`, [m.notification, [RESPOND, MARKETING]]);
    await updateConfig(m.notification, { purposeIds: [RESPOND, MARKETING] });
    await send(a, m.id);
    expect(mail.sent[0]!.text).toContain('Promo phone: 9876543210');
    const ledger = await disclosuresOf(m.s.id);
    expect(ledger.map((l) => [...l.field_keys].sort())).toEqual([['mail', 'name'], ['promo_phone']]);
    // A retry names nothing new.
    await owner.query(`update email_messages set status = 'retrying' where id = $1`, [m.id]);
    await send(a, m.id, 2);
    expect(await disclosuresOf(m.s.id)).toHaveLength(2);
  });

  it('fails the row, without sending, when the notification was deleted or turned off, the response was trashed, or nobody can be mailed any more', async () => {
    const gone = await queued();
    await owner.query('delete from notifications where id = $1', [gone.notification]);
    await send(a, gone.id);
    expect(await messageById(gone.id)).toMatchObject({ status: 'failed', attempts: 0, last_error: 'The notification was deleted before this message was sent.' });

    const off = await queued();
    await owner.query('update notifications set enabled = false where id = $1', [off.notification]);
    await send(a, off.id);
    expect((await messageById(off.id)).last_error).toBe('The notification was turned off before this message was sent.');

    const configOff = await queued();
    await updateConfig(configOff.notification, { enabled: false });
    await send(a, configOff.id);
    expect((await messageById(configOff.id)).last_error).toBe('The notification was turned off before this message was sent.');

    const trashed = await queued();
    await owner.query(`update submissions set status = 'trashed' where id = $1`, [trashed.s.id]);
    await send(a, trashed.id);
    expect((await messageById(trashed.id)).last_error).toBe('The response was moved to trashed before this message was sent.');

    const nobody = await queued({ kind: 'autoresponder', config: { to: [{ kind: 'field', blockId: 'mail' }] } });
    await owner.query(`update submissions set answers = jsonb_set(answers, '{mail,value,address}', '""') where id = $1`, [nobody.s.id]);
    await send(a, nobody.id);
    expect((await messageById(nobody.id)).last_error).toBe('The notification has no recipient who can be mailed now.');

    expect(mail.sent).toHaveLength(0);
  });

  it('is a no-op for a message that is not in the org the job runs for, and for one that was deleted with its response', async () => {
    const m = await queued();
    await send(b, m.id);
    expect(mail.sent).toHaveLength(0);
    expect(await messageById(m.id)).toMatchObject({ status: 'queued', attempts: 0 });

    await owner.query('delete from submissions where id = $1', [m.s.id]);
    await send(a, m.id);
    expect(await owner.query('select 1 from email_messages where id = $1', [m.id]).then((r) => r.rowCount)).toBe(0);
    expect(mail.sent).toHaveLength(0);
    // And an id that is not a uuid.
    await run('email.send', a.id, { type: 'email_message', id: 'nope' }, { emailMessageId: 'nope' });
  });

  it('refuses a job without an org: auth emails are another work package', async () => {
    const id = randomUUID();
    await expect(run('email.send', null, { type: 'system', id: 'email.send' }, { emailMessageId: id })).rejects.toThrow(/without an org/);
  });

  it('does not log an address, a subject or a body', async () => {
    const lines: string[] = [];
    const loud = pino({ level: 'debug' }, { write: (chunk: string) => void lines.push(chunk) });
    const m = await queued();
    mail.script.push(new PortError('unavailable', 'try later for admin@notify-a.test'));
    await expect(runJob(definitionFor('email.send'), received('email.send', a.id, { type: 'email_message', id: m.id }, { emailMessageId: m.id }, 1), { db: app.db, log: loud })).rejects.toThrow();
    const logged = lines.join('\n');
    expect(logged).toContain('email.send');
    for (const needle of ['admin@notify-a.test', 'asha@respondent.test', 'New response from Asha', PAN, 'Asha']) expect(logged).not.toContain(needle);
  });
});

// ─── a real SMTP server ───────────────────────────────────────────────────────────────────────────────────────

describe('a real SMTP delivery (Mailpit in Testcontainers)', () => {
  let mailpit: MailpitServer;
  let worker: PgBossQueue;
  let stopWorker: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    mailpit = await startMailpit();
    // Jobs the tests above left in the queue are not this test's to deliver.
    await owner.query(`delete from pgboss.job where name in ('notification.dispatch', 'email.send', 'submission.fanout')`);
    worker = createPgBossQueue({ connectionString: url, keyring: parseJobKeyring(`t1:${keySecret}`), mode: 'worker', pollingIntervalSeconds: 0.5, ...jobGuard(app.db, log) });
    queues.push(worker);
    await worker.start();
    const smtp = createSmtpMailer({ url: mailpit.smtpUrl });
    const real: EffectDeps = { ...makeDeps(worker, { mailer: smtp, asked: [] }) };
    const started = await startWorker({ db: app.db, log, queue: worker, jobs: [createEffectFanout(real), ...createEffectJobs(real)] });
    stopWorker = () => started.stop();
  }, 180_000);

  afterAll(async () => {
    await stopWorker?.();
    await mailpit?.stop();
  });

  /** Mailpit's own view of a message, by Message-ID: the subject and the decoded text and html parts. */
  async function delivered(messageId: string): Promise<{ Subject: string; Text: string; HTML: string; To: Array<{ Address: string }>; MessageID: string } | undefined> {
    const id = messageId.replace(/^<|>$/g, '');
    return vi.waitFor(
      async () => {
        const search = (await (await fetch(`${mailpit.apiUrl}/api/v1/search?query=${encodeURIComponent(`message-id:"${id}"`)}`)).json()) as { messages: Array<{ ID: string }> };
        expect(search.messages.length).toBeGreaterThan(0);
        return (await (await fetch(`${mailpit.apiUrl}/api/v1/message/${search.messages[0]!.ID}`)).json()) as never;
      },
      { timeout: 20_000, interval: 250 },
    );
  }

  it('a fan-out of a complete response arrives in the inbox with the expected subject and a masked body', async () => {
    const c = await seedOrg('mailpit');
    await seedNotification(c, { config: { to: [{ kind: 'role', role: 'org_admins' }, { kind: 'field', blockId: 'mail' }] } });
    const s = await store(c);
    await worker.send(
      'submission.fanout',
      { orgId: c.id, resource: { type: 'form', id: c.form }, data: { submissionId: s.id, receivedAt: toIsoInstant(s.receivedAt), event: 'created' } },
    );
    const message = await vi.waitFor(
      async () => {
        const rows = await messagesOf(s.id);
        expect(rows[0]?.status).toBe('sent');
        return rows[0]!;
      },
      { timeout: 30_000, interval: 250 },
    );
    const mailed = await delivered(message.message_id);
    expect(mailed).toBeDefined();
    expect(mailed!.Subject).toBe('New response from Asha');
    expect(mailed!.MessageID.replace(/^<|>$/g, '')).toBe(message.message_id.replace(/^<|>$/g, ''));
    expect(mailed!.To.map((t) => t.Address).sort()).toEqual(['admin@mailpit.test', 'asha@respondent.test', 'owner@mailpit.test']);
    expect(mailed!.Text).toContain('PAN ••••••');
    expect(mailed!.Text).toContain('Label of name: Asha');
    expect(mailed!.HTML).toContain('PAN ••••••');
    for (const out of [mailed!.Text, mailed!.HTML, mailed!.Subject]) {
      expect(out).not.toContain(PAN);
      expect(out).not.toContain(SSN);
      expect(out).not.toContain('9876543210');
    }
    expect(message.provider_message_id).not.toBeNull();
    expect((await disclosuresOf(s.id))[0]!.field_keys.sort()).toEqual(['mail', 'name']);
  });
});
