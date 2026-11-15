import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createOrgSecrets, createKeyfileKeyProvider } from '@form/adapters/kms';
import { createDb, newSubmissionKey, provision, withTenant, type DbHandle, type Tx } from '@form/db';
import { PortError, type MailMessage, type Mailer, type OrgSecrets } from '@form/ports';
import { createTestDatabase } from '@form/testkit';
import { createLogMailer, createMailerFor, unavailableOrgSecrets, type SmtpSecretReader } from '../src/effects/deps.ts';
import { recordDisclosure } from '../src/effects/disclosure.ts';
import { loadSubmission } from '../src/effects/submission.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * The pieces every effect job stands on (WP-1.16, WP-1.17, WP-1.18), against a real Postgres with RLS: loading a response and
 * the version it was received on, the disclosures ledger, and the org's SMTP secret that `mailerFor` opens.
 */

interface Org {
  id: string;
  user: string;
  form: string;
  other: string;
  version: string;
}

let owner: pg.Pool;
let app: DbHandle;
let a: Org;
let b: Org;
const SMTP_URL = 'smtps://mailer:hunter2-correct-horse@smtp.example.test:465';

const keys = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
const orgSecrets = createOrgSecrets(keys);

async function seedOrg(slug: string): Promise<Org> {
  const org: Org = { id: randomUUID(), user: randomUUID(), form: randomUUID(), other: randomUUID(), version: randomUUID() };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [org.user, `owner@${slug}.test`]);
  for (const form of [org.form, org.other]) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [form, org.id, randomUUID(), org.user, `${slug} form`]);
  }
  // The version of `form`; `other` has none of its own, which is why a response is never filed under it here.
  await owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash)
     values ($1, $2, $3, 1, 2, $4, $5, $6, $7)`,
    [org.version, org.id, org.form, org.user, JSON.stringify({ marker: `definition-of-${slug}` }), JSON.stringify({ taint: { 'value:copy': { classification: 'sensitive', purposeIds: [] } } }), '0'.repeat(64)],
  );
  return org;
}

async function store(org: Org, status = 'complete'): Promise<{ id: string; receivedAt: Date }> {
  const { id, receivedAt } = newSubmissionKey(new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
     values ($1, $2, $3, $4, $5, $6, 0, $7, '{"name":{"type":"short_text","value":"Asha"}}', '{"v":1}', '{"locale":"en-IN"}')`,
    [id, receivedAt, org.id, org.form, org.version, Buffer.alloc(32), status],
  );
  return { id, receivedAt };
}

const asSystem = <T>(org: Org, fn: (tx: Tx) => Promise<T>, perms: string[] = []): Promise<T> =>
  withTenant(app.db, { orgId: org.id, actor: 'system', requestId: 'test:effects', perms }, fn);

/** A sealed SMTP URL as a row of `secrets`, plus a sender that names it. */
async function seedSender(org: Org, o: { kind?: 'smtp' | 'webhook_hmac'; url?: string } = {}): Promise<{ secretId: string; senderId: string }> {
  const secretId = randomUUID();
  const kind = o.kind ?? 'smtp';
  const enc = await orgSecrets.seal({ orgId: org.id, secretId, kind }, o.url ?? SMTP_URL);
  await owner.query(`insert into secrets (id, org_id, kind, enc, meta) values ($1, $2, $3, $4, '{}')`, [secretId, org.id, kind, JSON.stringify(enc)]);
  const senderId = randomUUID();
  if (kind === 'smtp') {
    await owner.query(`insert into email_senders (id, org_id, name, from_address, smtp_secret_id) values ($1, $2, 'Forms', $3, $4)`, [senderId, org.id, 'forms@acme.example', secretId]);
  }
  return { secretId, senderId };
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker_effects');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  app = createDb(urls.fr_app, { max: 4, applicationName: 'fr-worker-effects-test' });
  a = await seedOrg('effects-a');
  b = await seedOrg('effects-b');
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

describe('loadSubmission', () => {
  it('returns the response with the version it was received on, read as the org that owns it', async () => {
    const s = await store(a);
    const loaded = await asSystem(a, (tx) => loadSubmission(tx, { formId: a.form, submissionId: s.id }));
    expect(loaded).not.toBeNull();
    expect(loaded!.row).toEqual({
      id: s.id,
      receivedAt: s.receivedAt,
      orgId: a.id,
      formId: a.form,
      formVersionId: a.version,
      status: 'complete',
      trashedAt: null,
      answerCodecVersion: 0,
      answers: { name: { type: 'short_text', value: 'Asha' } },
      computed: { v: 1 },
      meta: { locale: 'en-IN' },
    });
    expect(loaded!.definition).toEqual({ marker: 'definition-of-effects-a' });
    expect(loaded!.compiled.taint).toEqual({ 'value:copy': { classification: 'sensitive', purposeIds: [] } });
  });

  it('reads the columns an effect needs and no retention, hold or inbox column but the trash, which every effect must refuse on', async () => {
    const s = await store(a);
    const loaded = await asSystem(a, (tx) => loadSubmission(tx, { formId: a.form, submissionId: s.id }));
    expect(Object.keys(loaded!.row).sort()).toEqual(['answerCodecVersion', 'answers', 'computed', 'formId', 'formVersionId', 'id', 'meta', 'orgId', 'receivedAt', 'status', 'trashedAt']);
    // The grid trashes by setting `trashed_at` and leaves the status alone: the effect sees it.
    const at = new Date('2026-11-16T03:00:00.000Z');
    await owner.query('update submissions set trashed_at = $2 where id = $1', [s.id, at]);
    expect((await asSystem(a, (tx) => loadSubmission(tx, { formId: a.form, submissionId: s.id })))!.row).toMatchObject({ status: 'complete', trashedAt: at });
  });

  it('hands a held response back with its status, so the caller decides', async () => {
    const s = await store(a, 'pending_review');
    expect((await asSystem(a, (tx) => loadSubmission(tx, { formId: a.form, submissionId: s.id })))!.row.status).toBe('pending_review');
  });

  it('finds nothing for an unknown id, an id that is not a UUIDv7, another form’s response or another org’s', async () => {
    const mine = await store(a);
    const theirs = await store(b);
    const find = (org: Org, formId: string, submissionId: string) => asSystem(org, (tx) => loadSubmission(tx, { formId, submissionId }));
    expect(await find(a, a.form, newSubmissionKey(new Date()).id)).toBeNull();
    expect(await find(a, a.form, randomUUID())).toBeNull();
    // The response of this org, asked for under another form of the same org.
    expect(await find(a, a.other, mine.id)).toBeNull();
    // Another org's response, under its own form and under ours: RLS answers for the tenant the job runs in.
    expect(await find(a, b.form, theirs.id)).toBeNull();
    expect(await find(a, a.form, theirs.id)).toBeNull();
    expect(await find(b, b.form, theirs.id)).not.toBeNull();
  });
});

describe('recordDisclosure', () => {
  it('appends one ledger row naming the fields, never values, and returns its id', async () => {
    const s = await store(a);
    const id = await asSystem(a, (tx) =>
      recordDisclosure(tx, {
        orgId: a.id,
        submissionId: s.id,
        submissionReceivedAt: s.receivedAt,
        recipient: { kind: 'notification', id: randomUUID() },
        displayName: 'a***@example.com',
        fieldKeys: ['name', 'phone', 'name'],
      }),
    );
    const { rows } = await owner.query<{ org_id: string; recipient_kind: string; display_name: string; field_keys: string[]; submission_id: string }>(
      'select org_id, recipient_kind, display_name, field_keys, submission_id from disclosures where id = $1',
      [id],
    );
    expect(rows).toEqual([{ org_id: a.id, recipient_kind: 'notification', display_name: 'a***@example.com', field_keys: ['name', 'phone'], submission_id: s.id }]);
  });

  it('is invisible to another org and refused for another org’s id: RLS holds the row to the transaction’s org', async () => {
    const s = await store(a);
    const record = { submissionId: s.id, submissionReceivedAt: s.receivedAt, recipient: { kind: 'export' as const, id: randomUUID() }, displayName: 'CSV export', fieldKeys: ['name'] };
    const id = await asSystem(a, (tx) => recordDisclosure(tx, { ...record, orgId: a.id }));
    const seenByB = await asSystem(b, async (tx) => (await tx.execute(sql`select id from disclosures where id = ${id}`)).rows);
    expect(seenByB).toEqual([]);
    await expect(asSystem(b, (tx) => recordDisclosure(tx, { ...record, orgId: a.id }))).rejects.toThrow();
    await expect(asSystem(a, (tx) => recordDisclosure(tx, { ...record, orgId: b.id }))).rejects.toThrow();
  });

  it('refuses an empty display name before it reaches the database, and cuts a long one to what the column allows', async () => {
    const s = await store(a);
    const base = { orgId: a.id, submissionId: s.id, submissionReceivedAt: s.receivedAt, recipient: { kind: 'webhook' as const, id: randomUUID() }, fieldKeys: [] };
    await expect(asSystem(a, (tx) => recordDisclosure(tx, { ...base, displayName: '   ' }))).rejects.toThrow(/display name/);
    const id = await asSystem(a, (tx) => recordDisclosure(tx, { ...base, displayName: 'h'.repeat(500) }));
    const { rows } = await owner.query<{ n: number }>('select char_length(display_name) as n from disclosures where id = $1', [id]);
    expect(rows[0]!.n).toBe(320);
  });

  it('is append-only for the worker: it can neither change nor delete a row', async () => {
    const s = await store(a);
    const id = await asSystem(a, (tx) =>
      recordDisclosure(tx, { orgId: a.id, submissionId: s.id, submissionReceivedAt: s.receivedAt, recipient: { kind: 'webhook', id: randomUUID() }, displayName: 'hooks.example.org', fieldKeys: ['name'] }),
    );
    await expect(asSystem(a, (tx) => tx.execute(sql`update disclosures set field_keys = '{}' where id = ${id}`))).rejects.toThrow();
    await expect(asSystem(a, (tx) => tx.execute(sql`delete from disclosures where id = ${id}`))).rejects.toThrow();
  });
});

describe('mailerFor', () => {
  const log = pino({ level: 'silent' });
  const message = (o: Partial<MailMessage> = {}): MailMessage => ({ from: { address: 'forms@acme.example' }, to: [{ address: 'asha@example.com' }], subject: 'New response', text: 'hello', ...o });

  /** An org mailer stand-in: reads its SMTP URL through the same `resolve` the real adapter calls, and records what it found. */
  function harness() {
    const platform: Mailer = { send: vi.fn(async () => ({ messageId: '<platform@acme.example>', refused: [] })), verify: vi.fn(async () => ({ ok: true })) };
    const resolved: Array<{ ref: string | undefined; url: string | undefined }> = [];
    const makeOrgMailer = (senders: SmtpSecretReader): Mailer => ({
      async send(m) {
        const url = m.senderSecretRef === undefined ? undefined : await senders.resolve(m.senderSecretRef);
        resolved.push({ ref: m.senderSecretRef, url });
        if (url === undefined) throw new PortError('not_found', 'no such SMTP sender');
        return { messageId: m.messageId ?? '<org@acme.example>', refused: [] };
      },
      async verify(ref) {
        const url = ref === undefined ? undefined : await senders.resolve(ref);
        return url === undefined ? { ok: false, error: 'no such SMTP sender' } : { ok: true };
      },
    });
    const mailerFor = createMailerFor({ db: app.db, orgSecrets, platform, makeOrgMailer });
    return { platform, resolved, mailerFor };
  }

  it('sends through the platform mailer when the message names no sender', async () => {
    const h = harness();
    expect(h.mailerFor(a.id)).toBe(h.platform);
    expect(h.mailerFor(a.id, null)).toBe(h.platform);
    expect(h.resolved).toEqual([]);
  });

  it('opens the org’s own SMTP secret for a sender, with the sender’s secret id filled in when the message has none', async () => {
    const h = harness();
    const { secretId, senderId } = await seedSender(a);
    await h.mailerFor(a.id, senderId).send(message());
    expect(h.resolved).toEqual([{ ref: secretId, url: SMTP_URL }]);
    // A caller that already holds the sender’s secret id may pass it; the same org still has to own it.
    await h.mailerFor(a.id, senderId).send(message({ senderSecretRef: secretId }));
    expect(h.resolved.at(-1)).toEqual({ ref: secretId, url: SMTP_URL });
    expect(await h.mailerFor(a.id, senderId).verify()).toEqual({ ok: true });
    expect(h.platform.send).not.toHaveBeenCalled();
  });

  it('never opens another org’s secret, by the sender’s id or by the secret’s id, and never opens a secret of the wrong kind', async () => {
    const h = harness();
    const mine = await seedSender(a);
    const theirs = await seedSender(b, { url: 'smtp://other:other-secret@smtp.other.test:25' });
    const hook = await seedSender(a, { kind: 'webhook_hmac', url: 'whsec_not_an_smtp_url' });
    // Org B’s worker context asking for org A’s sender: there is no such sender in B.
    await expect(h.mailerFor(b.id, mine.senderId).send(message())).rejects.toMatchObject({ code: 'not_found' });
    // Org A asking for B’s secret by id, or for its own webhook key as if it were an SMTP URL: refused, nothing resolved.
    await expect(h.mailerFor(a.id, mine.senderId).send(message({ senderSecretRef: theirs.secretId }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.mailerFor(a.id, mine.senderId).send(message({ senderSecretRef: hook.secretId }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.mailerFor(a.id, mine.senderId).send(message({ senderSecretRef: 'not-a-uuid' }))).rejects.toMatchObject({ code: 'not_found' });
    expect(h.resolved.every((r) => r.url === undefined)).toBe(true);
    expect(await h.mailerFor(a.id, mine.senderId).verify(theirs.secretId)).toMatchObject({ ok: false });
  });

  it('opens a secret with the context of the org that owns it: a KMS that names the org refuses a secret sealed for another', async () => {
    const h = harness();
    const { senderId } = await seedSender(a);
    // Rewrite the stored value as one sealed for org B’s context: opening it as org A fails authentication, never returns a URL.
    const foreign = await orgSecrets.seal({ orgId: b.id, secretId: randomUUID(), kind: 'smtp' }, 'smtp://stolen:stolen@smtp.b.test:25');
    await owner.query(`update secrets set enc = $1 where org_id = $2 and id = (select smtp_secret_id from email_senders where id = $3)`, [JSON.stringify(foreign), a.id, senderId]);
    const err = await h.mailerFor(a.id, senderId).send(message()).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(PortError);
    expect(String(err)).not.toContain('stolen');
  });

  it('puts no part of the URL or the credentials into an error', async () => {
    const failing: OrgSecrets = { seal: orgSecrets.seal, open: async () => Promise.reject(new PortError('unavailable', 'the KMS is unreachable')) };
    const { senderId } = await seedSender(a);
    const mailerFor = createMailerFor({ db: app.db, orgSecrets: failing, platform: harness().platform, makeOrgMailer: (senders) => ({
      send: async (m) => {
        await senders.resolve(m.senderSecretRef!);
        return { messageId: '<x@y.z>', refused: [] };
      },
      verify: async () => ({ ok: true }),
    }) });
    const err = await mailerFor(a.id, senderId).send(message()).then(() => null, (e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'unavailable' });
    expect(String(err)).not.toContain('hunter2');
  });

  it('leaves no transaction open once it has read the secret (the KMS is asked after the read, with no connection pinned)', async () => {
    // A connection that is idle in a transaction is a pinned pool connection: none may be left behind by a resolve.
    const h = harness();
    const { senderId } = await seedSender(a);
    await h.mailerFor(a.id, senderId).send(message());
    const { rows } = await owner.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where application_name = 'fr-worker-effects-test' and state like 'idle in transaction%'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('has a log mailer that sends nothing and names neither an address, a subject nor a body', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const sink = pino({ level: 'info' }, { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) });
    const sent = await createLogMailer(sink).send(message({ messageId: '<abc@acme.example>', cc: [{ address: 'cc@example.com' }] }));
    expect(sent).toEqual({ messageId: '<abc@acme.example>', refused: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ messageId: '<abc@acme.example>', recipients: 2 });
    const text = JSON.stringify(lines);
    for (const secret of ['asha@example.com', 'cc@example.com', 'New response', 'hello']) expect(text).not.toContain(secret);
    expect(await createLogMailer(log).verify()).toEqual({ ok: true });
  });

  it('has an OrgSecrets for a worker with no KMS that refuses, as unavailable, so a job retries instead of pretending', async () => {
    await expect(unavailableOrgSecrets.open({ orgId: a.id, secretId: randomUUID(), kind: 'smtp' }, {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(unavailableOrgSecrets.seal({ orgId: a.id, secretId: randomUUID(), kind: 'smtp' }, 'x')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
