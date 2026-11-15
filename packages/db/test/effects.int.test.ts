import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPartitions,
  PARTITIONED_TABLES,
  partitionsOf,
  secretEnc,
  secretPublicColumns,
  secrets,
  withTenant,
  type PartitionedTable,
  type TenantCtx,
  type Tx,
} from '../src/index.ts';
import { effectsOf, failure, HASH, insertSubmission, newSubmission, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

/**
 * Migration 0023 (WP-1.16 notifications, WP-1.17 exports, WP-1.18 webhooks): the permission each table asks for, the
 * columns fr_app may touch, the constraints that keep a row inside its org, and the ledger that only grows. The generated
 * isolation suite in rls.int.test.ts covers every actor kind against the other org; this file covers the same org.
 */

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

type Ctx = Omit<TenantCtx, 'requestId' | 'orgId'>;
/** Runs `fn` as a context of org B (its own rows are `effectsOf(seed.b)`); org A is the "someone else's" org. */
const as = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>) => withTenant(t.app.db, { orgId: seed.b.orgId, requestId: 'effects', ...ctx }, fn);
const run = (ctx: Ctx, statement: ReturnType<typeof sql>) => as(ctx, (tx) => tx.execute(statement));
const user = (perms: string[], userId = seed.b.editorId): Ctx => ({ actor: 'user', userId, perms });
const system: Ctx = { actor: 'system' };
const respondent: Ctx = { actor: 'respondent' };
const apiKey = (perms: string[]): Ctx => ({ actor: 'api_key', perms });
const fx = () => effectsOf(seed.b);
const fxA = () => effectsOf(seed.a);
const message = (err: unknown) => String((err as { cause?: { message?: string } }).cause?.message ?? err);
const rowsOf = async (query: string, params: unknown[] = []) => (await t.owner.query(query, params)).rows;
const count = async (query: string, params: unknown[] = []) => Number((await rowsOf(query, params))[0]!.n);

/** The name of the constraint a failed statement broke, also when drizzle wraps the pg error. */
function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

const SEALED = { v: 1, alg: 'aes-256-gcm', ct: 'c2VhbGVkLWluLXRoZS1zZWVk' };

const insertSecret = (id: string, kind: 'smtp' | 'webhook_hmac', orgId = seed.b.orgId) =>
  sql`insert into secrets (id, org_id, kind, enc, meta) values (${id}, ${orgId}, ${kind}, ${JSON.stringify({ ...SEALED, n: id })}::jsonb, '{"last4":"abcd"}'::jsonb)`;

/** A secret of org B made by the owner, so a test can point a sender or webhook at its own. */
async function secretOfB(kind: 'smtp' | 'webhook_hmac'): Promise<string> {
  const id = randomUUID();
  await t.owner.query(`insert into secrets (id, org_id, kind, enc, meta) values ($1, $2, $3, $4, '{}')`, [id, seed.b.orgId, kind, JSON.stringify(SEALED)]);
  return id;
}

describe('secrets: the sealed value goes in and a system context takes it out', () => {
  const orgSettings = () => user(['forms.read', 'org.settings']);
  const dataRoute = () => user(['forms.read', 'data.route']);

  it('refuses a member with org.settings every way of reading enc: permission denied, never an empty answer', async () => {
    const statements = [
      sql`select enc from secrets`,
      sql`select * from secrets`,
      sql`select id from secrets where enc is not null`,
      sql`select count(*) from secrets where enc ->> 'v' = '1'`,
      sql`update secrets set meta = '{}'::jsonb where id = ${fx().smtpSecretId} returning enc`,
      sql`${insertSecret(randomUUID(), 'smtp')} returning enc`,
    ];
    for (const statement of statements) {
      const err = await failure(run(orgSettings(), statement));
      expect(pgCode(err)).toBe('42501');
      expect(message(err)).toMatch(/permission denied/);
    }
    // Also through the typed handle: a select that names every column of the table fails, the public columns do not.
    expect(pgCode(await failure(as(orgSettings(), (tx) => tx.select().from(secrets))))).toBe('42501');
    const visible = await as(orgSettings(), (tx) => tx.select(secretPublicColumns).from(secrets));
    expect(visible.map((s) => s.id)).toEqual([fx().smtpSecretId]);
    expect(visible[0]).toMatchObject({ kind: 'smtp', orgId: seed.b.orgId, meta: { host: 'smtp.example.test', user: 'mailer' } });
    expect(Object.keys(visible[0]!).sort()).toEqual(['createdAt', 'id', 'kind', 'meta', 'orgId', 'rotatedAt']);
  });

  it('opens a secret for a system context only, as the stored value, through secret_enc', async () => {
    // A system context is the same database role, so the column grant does not let it select enc either: the definer does.
    expect(pgCode(await failure(run(system, sql`select enc from secrets`)))).toBe('42501');
    const opened = await as(system, (tx) => secretEnc(tx, fx().smtpSecretId));
    expect(opened).toEqual(SEALED);
    expect(await as(system, (tx) => secretEnc(tx, fx().hookSecretId))).toEqual(SEALED);
    // The id of another org's secret, and an id that is no secret, answer the same: nothing.
    expect(await as(system, (tx) => secretEnc(tx, fxA().smtpSecretId))).toBeNull();
    expect(await as(system, (tx) => secretEnc(tx, randomUUID()))).toBeNull();
    // Every other actor kind, and a query outside any tenant context, is refused.
    for (const ctx of [orgSettings(), dataRoute(), user(['org.settings', 'data.route', 'compliance.statutory_access']), apiKey(['org.settings']), respondent, { actor: 'platform' } as Ctx]) {
      const err = await failure(as(ctx, (tx) => secretEnc(tx, fx().smtpSecretId)));
      expect(pgCode(err), ctx.actor).toBe('42501');
      expect(message(err), ctx.actor).toMatch(/only a system context/);
    }
    expect(pgCode(await failure(secretEnc(t.app.db, fx().smtpSecretId)))).toBe('42501');
  });

  it('shows and changes a kind of secret only to the permission that owns it: org.settings for smtp, data.route for webhook_hmac', async () => {
    const kinds = (ctx: Ctx) => as(ctx, async (tx) => (await tx.select({ kind: secrets.kind }).from(secrets)).map((s) => s.kind).sort());
    expect(await kinds(orgSettings())).toEqual(['smtp']);
    expect(await kinds(dataRoute())).toEqual(['webhook_hmac']);
    expect(await kinds(user(['org.settings', 'data.route']))).toEqual(['smtp', 'webhook_hmac']);
    expect(await kinds(system)).toEqual(['smtp', 'webhook_hmac']);
    for (const ctx of [user(['forms.read', 'forms.edit', 'submissions.read']), apiKey(['forms.read']), respondent]) expect(await kinds(ctx), ctx.actor).toEqual([]);

    // Inserts: the right permission for the kind, or a system job.
    const mine = randomUUID();
    const hook = randomUUID();
    await run(orgSettings(), insertSecret(mine, 'smtp'));
    await run(dataRoute(), insertSecret(hook, 'webhook_hmac'));
    await run(system, insertSecret(randomUUID(), 'smtp'));
    expect(pgCode(await failure(run(orgSettings(), insertSecret(randomUUID(), 'webhook_hmac'))))).toBe('42501');
    expect(pgCode(await failure(run(dataRoute(), insertSecret(randomUUID(), 'smtp'))))).toBe('42501');
    for (const ctx of [user(['forms.edit']), apiKey(['forms.read', 'forms.edit']), respondent]) {
      expect(pgCode(await failure(run(ctx, insertSecret(randomUUID(), 'smtp')))), ctx.actor).toBe('42501');
    }

    // Rotation: enc, meta and rotated_at change; the kind, org and id never do.
    const rotated = await run(orgSettings(), sql`update secrets set enc = ${JSON.stringify({ ...SEALED, ct: 'cm90YXRlZA' })}::jsonb, meta = '{"host":"smtp2.example.test"}'::jsonb, rotated_at = now() where id = ${mine} returning id`);
    expect(rotated.rows).toHaveLength(1);
    expect((await rowsOf('select enc, meta, rotated_at is not null as rotated from secrets where id = $1', [mine]))[0]).toMatchObject({
      enc: { ct: 'cm90YXRlZA' },
      meta: { host: 'smtp2.example.test' },
      rotated: true,
    });
    for (const column of ['kind', 'org_id', 'id', 'created_at']) {
      const err = await failure(run(system, sql`update secrets set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${mine}`));
      expect(pgCode(err), column).toBe('42501');
    }
    // The other kind's permission neither updates nor deletes it.
    expect((await run(dataRoute(), sql`update secrets set meta = '{}'::jsonb where id = ${mine} returning 1`)).rows).toEqual([]);
    expect((await run(dataRoute(), sql`delete from secrets where id = ${mine} returning 1`)).rows).toEqual([]);
    expect((await run(orgSettings(), sql`delete from secrets where id = ${mine} returning 1`)).rows).toHaveLength(1);
    expect((await run(dataRoute(), sql`delete from secrets where id = ${hook} returning 1`)).rows).toHaveLength(1);
  });

  it('grants fr_app SELECT on every column but enc, and nothing on enc but INSERT and UPDATE', async () => {
    const privileges = async (type: string) =>
      (
        await t.owner.query<{ column_name: string }>(
          `select column_name from information_schema.column_privileges where grantee = 'fr_app' and table_schema = 'public' and table_name = 'secrets' and privilege_type = $1 order by column_name`,
          [type],
        )
      ).rows.map((r) => r.column_name);
    expect(await privileges('SELECT')).toEqual(['created_at', 'id', 'kind', 'meta', 'org_id', 'rotated_at']);
    expect(await privileges('UPDATE')).toEqual(['enc', 'meta', 'rotated_at']);
    expect(await privileges('INSERT')).toContain('enc');
  });

  it('is an object with a kind from the list, and belongs to an org that exists', async () => {
    const insert = (kind: string, enc: string, orgId = seed.b.orgId) => t.owner.query(`insert into secrets (id, org_id, kind, enc) values ($1, $2, $3, $4::jsonb)`, [randomUUID(), orgId, kind, enc]);
    expect(pgCode(await failure(insert('oauth', '{}')))).toBe('23514');
    expect(pgCode(await failure(insert('smtp', '"just a string"')))).toBe('23514');
    expect(pgCode(await failure(insert('smtp', '{}', randomUUID())))).toBe('23503');
  });
});

describe('email_senders', () => {
  const settings = () => user(['forms.read', 'org.settings']);
  const insertSender = (id: string, secretId: string, over: { isDefault?: boolean; address?: string; name?: string } = {}) =>
    sql`insert into email_senders (id, org_id, name, from_address, from_name, smtp_secret_id, is_default)
        values (${id}, ${seed.b.orgId}, ${over.name ?? 'Support'}, ${over.address ?? 'support@example.test'}, 'Support', ${secretId}, ${over.isDefault ?? false})`;

  it('reads for any context but a respondent, and writes need org.settings or a system job', async () => {
    const readable = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute(sql`select id from email_senders`)).rows.length);
    expect(await readable(user(['forms.read']))).toBe(1);
    expect(await readable(apiKey(['forms.read']))).toBe(1);
    expect(await readable(system)).toBe(1);
    expect(await readable(respondent)).toBe(0);

    const secret = await secretOfB('smtp');
    for (const ctx of [user(['forms.read', 'forms.edit', 'data.route']), apiKey(['forms.read']), respondent]) {
      expect(pgCode(await failure(run(ctx, insertSender(randomUUID(), secret)))), ctx.actor).toBe('42501');
    }
    const id = randomUUID();
    await run(settings(), insertSender(id, secret));
    await run(system, insertSender(randomUUID(), secret));

    // Without org.settings the sender cannot be changed or removed: the statements find nothing.
    const editor = user(['forms.read', 'forms.edit', 'data.route']);
    expect((await run(editor, sql`update email_senders set name = 'Hijacked' where id = ${id} returning 1`)).rows).toEqual([]);
    expect((await run(editor, sql`delete from email_senders where id = ${id} returning 1`)).rows).toEqual([]);
    expect((await run(settings(), sql`update email_senders set name = 'Renamed', verified_at = now(), updated_at = now() where id = ${id} returning 1`)).rows).toHaveLength(1);
    expect((await run(settings(), sql`delete from email_senders where id = ${id} returning 1`)).rows).toHaveLength(1);
  });

  it('allows one default sender per org, and only the columns that change after creation are writable', async () => {
    const secret = await secretOfB('smtp');
    // Org B already has a default (seeded). A second default is refused; a non-default is fine.
    const err = await failure(run(settings(), insertSender(randomUUID(), secret, { isDefault: true })));
    expect(pgCode(err)).toBe('23505');
    expect(constraintOf(err)).toBe('email_senders_default_key');
    await run(settings(), insertSender(randomUUID(), secret, { isDefault: false }));
    // Moving the default is two statements in one transaction: clear, then set.
    const other = randomUUID();
    await run(settings(), insertSender(other, secret));
    await as(settings(), async (tx) => {
      await tx.execute(sql`update email_senders set is_default = false where org_id = ${seed.b.orgId} and is_default`);
      await tx.execute(sql`update email_senders set is_default = true where id = ${other}`);
    });
    expect(await count('select count(*)::int as n from email_senders where org_id = $1 and is_default', [seed.b.orgId])).toBe(1);
    // Org A has its own default: the index is per org.
    expect(await count('select count(*)::int as n from email_senders where org_id = $1 and is_default', [seed.a.orgId])).toBe(1);
    for (const column of ['id', 'org_id', 'created_at']) {
      const bad = await failure(run(settings(), sql`update email_senders set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${other}`));
      expect(pgCode(bad), column).toBe('42501');
    }
  });

  it('uses a secret of its own org only, and cannot lose the secret it uses, or be deleted while a notification names it', async () => {
    // A secret of org A, named by a sender of org B: the foreign key carries the org, so it is refused whoever asks.
    const foreignSecret = await failure(run(system, insertSender(randomUUID(), fxA().smtpSecretId)));
    expect(pgCode(foreignSecret)).toBe('23503');
    expect(constraintOf(foreignSecret)).toBe('email_senders_secret_fkey');
    expect(pgCode(await failure(t.owner.query(`insert into email_senders (id, org_id, name, from_address, smtp_secret_id) values ($1, $2, 'x', 'x@example.test', $3)`, [randomUUID(), seed.b.orgId, fxA().smtpSecretId])))).toBe('23503');
    // The seeded sender uses the seeded secret, and a notification uses the sender.
    expect(pgCode(await failure(run(system, sql`delete from secrets where id = ${fx().smtpSecretId}`)))).toBe('23503');
    expect(pgCode(await failure(run(system, sql`delete from email_senders where id = ${fx().senderId}`)))).toBe('23503');
  });

  it('names an smtp secret and nothing else: a webhook_hmac secret of its own org is refused, on insert and on update', async () => {
    // The foreign key carries the kind (smtp_secret_kind is always 'smtp'), and a foreign-key check bypasses RLS, so this
    // holds for every actor, the table owner included.
    const hookSecret = await secretOfB('webhook_hmac');
    for (const ctx of [settings(), system]) {
      const err = await failure(run(ctx, insertSender(randomUUID(), hookSecret)));
      expect(pgCode(err), ctx.actor).toBe('23503');
      expect(constraintOf(err), ctx.actor).toBe('email_senders_secret_fkey');
    }
    const asOwner = await failure(
      t.owner.query(`insert into email_senders (id, org_id, name, from_address, smtp_secret_id) values ($1, $2, 'x', 'x@example.test', $3)`, [randomUUID(), seed.b.orgId, hookSecret]),
    );
    expect(pgCode(asOwner)).toBe('23503');
    expect(constraintOf(asOwner)).toBe('email_senders_secret_fkey');
    // Nor can the secret be turned into the wrong kind from under the sender that uses it (the key is checked on update too).
    expect(pgCode(await failure(t.owner.query(`update secrets set kind = 'webhook_hmac' where id = $1`, [fx().smtpSecretId])))).toBe('23503');
    // The kind cannot be written to fit: the column is fixed to 'smtp' and is not updatable.
    const smtpSecret = await secretOfB('smtp');
    const forged = await failure(
      run(system, sql`insert into email_senders (id, org_id, name, from_address, smtp_secret_id, smtp_secret_kind) values (${randomUUID()}, ${seed.b.orgId}, 'x', 'x@example.test', ${hookSecret}, 'webhook_hmac')`),
    );
    expect(pgCode(forged)).toBe('23514');

    // The same on update: a sender that uses an smtp secret cannot be pointed at a webhook_hmac one, by a member or a system job.
    const id = randomUUID();
    await run(settings(), insertSender(id, smtpSecret));
    for (const ctx of [settings(), system]) {
      const err = await failure(run(ctx, sql`update email_senders set smtp_secret_id = ${hookSecret} where id = ${id}`));
      expect(pgCode(err), ctx.actor).toBe('23503');
      expect(constraintOf(err), ctx.actor).toBe('email_senders_secret_fkey');
    }
    expect(pgCode(await failure(run(system, sql`update email_senders set smtp_secret_kind = 'webhook_hmac' where id = ${id}`)))).toBe('42501');
    expect(await rowsOf('select smtp_secret_id, smtp_secret_kind from email_senders where id = $1', [id])).toEqual([{ smtp_secret_id: smtpSecret, smtp_secret_kind: 'smtp' }]);
    // Moving it to another smtp secret of the org is fine.
    const otherSmtp = await secretOfB('smtp');
    expect((await run(settings(), sql`update email_senders set smtp_secret_id = ${otherSmtp} where id = ${id} returning 1`)).rows).toHaveLength(1);
    expect(await rowsOf('select smtp_secret_id from email_senders where id = $1', [id])).toEqual([{ smtp_secret_id: otherSmtp }]);
  });

  it('has a real address and a name', async () => {
    const secret = await secretOfB('smtp');
    for (const over of [{ address: 'no-at-sign' }, { address: '@example.test' }, { name: '' }, { name: 'x'.repeat(121) }]) {
      expect(pgCode(await failure(run(system, insertSender(randomUUID(), secret, over)))), JSON.stringify(over)).toBe('23514');
    }
  });
});

describe('notifications', () => {
  const author = () => user(['forms.read', 'forms.edit']);
  const insertNotification = (id: string, over: { form?: string; sender?: string | null; kind?: string; trigger?: string } = {}) =>
    sql`insert into notifications (id, org_id, form_id, kind, trigger, sender_id, config, purpose_ids)
        values (${id}, ${seed.b.orgId}, ${over.form ?? seed.b.formIds[1]}, ${over.kind ?? 'autoresponder'}, ${over.trigger ?? 'submitted'}, ${over.sender ?? null}, '{"name":"Thanks"}'::jsonb, '{contact}')`;

  it('is read by every context but a respondent, and written with forms.edit or by a system job', async () => {
    const readable = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute(sql`select id from notifications`)).rows.length);
    expect(await readable(user(['forms.read']))).toBeGreaterThan(0);
    expect(await readable(apiKey(['forms.read']))).toBeGreaterThan(0);
    expect(await readable(respondent)).toBe(0);

    for (const ctx of [user(['forms.read', 'submissions.read', 'data.route', 'ops.manage']), apiKey(['forms.read', 'submissions.read']), respondent]) {
      const err = await failure(run(ctx, insertNotification(randomUUID())));
      expect(pgCode(err), ctx.actor).toBe('42501');
    }
    const id = randomUUID();
    await run(author(), insertNotification(id));
    await run(system, insertNotification(randomUUID()));
    const viewer = user(['forms.read', 'submissions.read']);
    expect((await run(viewer, sql`update notifications set enabled = false where id = ${id} returning 1`)).rows).toEqual([]);
    expect((await run(viewer, sql`delete from notifications where id = ${id} returning 1`)).rows).toEqual([]);
    expect(await count('select count(*)::int as n from notifications where id = $1 and enabled', [id])).toBe(1);
    expect((await run(author(), sql`update notifications set enabled = false, rev = rev + 1, updated_at = now(), updated_by = ${seed.b.editorId} where id = ${id} returning 1`)).rows).toHaveLength(1);
    expect((await run(author(), sql`delete from notifications where id = ${id} returning 1`)).rows).toHaveLength(1);
  });

  it('keeps the form and org fixed, and the kind, trigger and purposes inside the lists', async () => {
    const id = randomUUID();
    await run(author(), insertNotification(id));
    for (const column of ['id', 'org_id', 'form_id', 'created_at']) {
      const err = await failure(run(author(), sql`update notifications set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${id}`));
      expect(pgCode(err), column).toBe('42501');
    }
    expect(pgCode(await failure(run(author(), insertNotification(randomUUID(), { kind: 'cc' }))))).toBe('23514');
    expect(pgCode(await failure(run(author(), insertNotification(randomUUID(), { trigger: 'on_submit' }))))).toBe('23514');
    expect(pgCode(await failure(run(author(), sql`update notifications set purpose_ids = '{}' where id = ${id}`)))).toBe('23514');
    expect(pgCode(await failure(run(author(), sql`update notifications set rev = 0 where id = ${id}`)))).toBe('23514');
    expect(pgCode(await failure(run(author(), sql`update notifications set config = '[]'::jsonb where id = ${id}`)))).toBe('23514');
    // The six triggers of NotificationConfig are all accepted.
    for (const trigger of ['submitted', 'edited', 'payment_confirmed', 'appointment_reminder', 'workflow_step', 'draft_saved']) {
      await run(author(), insertNotification(randomUUID(), { trigger }));
    }
  });

  it('points at a form and a sender of its own org', async () => {
    const otherForm = await failure(run(system, insertNotification(randomUUID(), { form: seed.a.formIds[0] })));
    expect(pgCode(otherForm)).toBe('23503');
    expect(constraintOf(otherForm)).toBe('notifications_form_fkey');
    const otherSender = await failure(run(system, insertNotification(randomUUID(), { sender: fxA().senderId })));
    expect(pgCode(otherSender)).toBe('23503');
    expect(constraintOf(otherSender)).toBe('notifications_sender_fkey');
    // No sender is fine (the platform mailer sends), and so is the org's own.
    await run(system, insertNotification(randomUUID(), { sender: null }));
    await run(system, insertNotification(randomUUID(), { sender: fx().senderId }));
  });
});

describe('email_messages: the delivery log', () => {
  const reader = () => user(['forms.read', 'submissions.read']);
  const insertMessage = (id: string, over: { submission?: { id: string; receivedAt: Date }; form?: string; masked?: string; status?: string; hash?: Buffer } = {}) =>
    sql`insert into email_messages (id, org_id, form_id, submission_id, submission_received_at, notification_id, role, to_display_masked, subject_hash, message_id, status)
        values (${id}, ${seed.b.orgId}, ${over.form ?? seed.b.formIds[0]}, ${over.submission?.id ?? fx().submissionId},
          ${(over.submission?.receivedAt ?? fx().submissionReceivedAt).toISOString()}::timestamptz, ${fx().notificationId}, 'owner',
          ${over.masked ?? '{a***@example.test}'}, ${over.hash ?? HASH}, ${`<${id}@fr.test>`}, ${over.status ?? 'queued'})`;

  it('is read with submissions.read or by a system job, and written by a system job alone', async () => {
    const visible = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute(sql`select id from email_messages`)).rows.length);
    expect(await visible(reader())).toBeGreaterThan(0);
    expect(await visible(system)).toBeGreaterThan(0);
    expect(await visible(apiKey(['submissions.read']))).toBeGreaterThan(0);
    for (const ctx of [user(['forms.read', 'forms.edit', 'data.route', 'org.settings']), apiKey(['forms.read']), respondent]) expect(await visible(ctx), ctx.actor).toBe(0);

    // Nobody but the worker adds, changes or removes a row of the log, whatever they may read.
    const id = randomUUID();
    for (const ctx of [reader(), user(['submissions.read', 'submissions.edit', 'submissions.delete', 'data.route']), apiKey(['submissions.read']), respondent]) {
      expect(pgCode(await failure(run(ctx, insertMessage(randomUUID())))), ctx.actor).toBe('42501');
    }
    await run(system, insertMessage(id));
    const readerEdit = await run(reader(), sql`update email_messages set status = 'sent', attempts = 9 where id = ${id} returning 1`);
    expect(readerEdit.rows).toEqual([]);
    expect((await run(reader(), sql`delete from email_messages where id = ${id} returning 1`)).rows).toEqual([]);
    expect(await rowsOf('select status, attempts from email_messages where id = $1', [id])).toEqual([{ status: 'queued', attempts: 0 }]);

    // The worker's own writes: the state moves, the identity of the row does not.
    const moved = await run(system, sql`update email_messages set status = 'retrying', attempts = attempts + 1, last_error = 'connect ETIMEDOUT', provider_message_id = null where id = ${id} returning 1`);
    expect(moved.rows).toHaveLength(1);
    expect(await rowsOf('select status, attempts, last_error from email_messages where id = $1', [id])).toEqual([{ status: 'retrying', attempts: 1, last_error: 'connect ETIMEDOUT' }]);
    for (const column of ['id', 'org_id', 'form_id', 'submission_id', 'notification_id', 'message_id', 'created_at', 'role']) {
      const err = await failure(run(system, sql`update email_messages set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${id}`));
      expect(pgCode(err), column).toBe('42501');
    }
  });

  it('holds a masked recipient, a 32-byte subject hash, a known status and a response and form of its own org', async () => {
    const id = () => randomUUID();
    expect(pgCode(await failure(run(system, insertMessage(id(), { masked: '{}' }))))).toBe('23514');
    expect(pgCode(await failure(run(system, insertMessage(id(), { hash: Buffer.alloc(20) }))))).toBe('23514');
    expect(pgCode(await failure(run(system, insertMessage(id(), { status: 'delivered' }))))).toBe('23514');
    for (const status of ['queued', 'sending', 'retrying', 'sent', 'failed']) await run(system, insertMessage(id(), { status }));
    // A response that does not exist, and a form of another org.
    expect(pgCode(await failure(run(system, insertMessage(id(), { submission: { id: randomUUID(), receivedAt: new Date() } }))))).toBe('23503');
    expect(pgCode(await failure(run(system, insertMessage(id(), { form: seed.a.formIds[0] }))))).toBe('23503');
  });

  it('goes with its response, and with nothing else', async () => {
    const submission = await insertSubmission(t.owner, newSubmission(seed.b, 1, { answers: {} }));
    const messageId = randomUUID();
    await run(system, insertMessage(messageId, { submission, form: seed.b.formIds[1] }));
    const before = await count('select count(*)::int as n from email_messages where org_id = $1', [seed.b.orgId]);
    // A member who may delete responses, and holds no delete on the log, deletes the response: the log rows follow.
    const deleter = user(['submissions.read', 'submissions.delete']);
    const removed = await run(deleter, sql`delete from submissions where id = ${submission.id} and received_at = ${submission.receivedAt.toISOString()}::timestamptz returning 1`);
    expect(removed.rows).toHaveLength(1);
    expect(await count('select count(*)::int as n from email_messages where id = $1', [messageId])).toBe(0);
    expect(await count('select count(*)::int as n from email_messages where org_id = $1', [seed.b.orgId])).toBe(before - 1);
  });
});

describe('webhooks', () => {
  const router = () => user(['forms.read', 'data.route']);
  const insertWebhook = (id: string, over: { url?: string; events?: string; secret?: string; form?: string; keyBy?: string; files?: string; fieldKeys?: string } = {}) =>
    sql`insert into webhooks (id, org_id, form_id, url, secret_id, events, key_by, files, field_keys, purpose_ids)
        values (${id}, ${seed.b.orgId}, ${over.form ?? seed.b.formIds[1]}, ${over.url ?? 'https://hooks.example.test/x'}, ${over.secret ?? fx().hookSecretId},
          ${over.events ?? '{submission.created}'}, ${over.keyBy ?? 'key'}, ${over.files ?? 'none'}, ${over.fieldKeys ?? '"all_in_purposes"'}::jsonb, '{contact}')`;

  it('takes the defaults of a new webhook: enabled, no failures, keyed by field key, all fields of its purposes, no files', async () => {
    const id = randomUUID();
    await run(router(), sql`insert into webhooks (id, org_id, form_id, url, secret_id, events, purpose_ids)
      values (${id}, ${seed.b.orgId}, ${seed.b.formIds[1]}, 'https://hooks.example.test/defaults', ${fx().hookSecretId}, '{submission.created,consent.withdrawn}', '{contact}')`);
    expect((await rowsOf('select enabled, consecutive_failures, key_by, field_keys, files, rev, disabled_reason from webhooks where id = $1', [id]))[0]).toEqual({
      enabled: true,
      consecutive_failures: 0,
      key_by: 'key',
      field_keys: 'all_in_purposes',
      files: 'none',
      rev: 1,
      disabled_reason: null,
    });
  });

  it('keeps the url, events, key mode, files and field keys inside their lists', async () => {
    const id = () => randomUUID();
    const refused = async (over: Parameters<typeof insertWebhook>[1]) => pgCode(await failure(run(router(), insertWebhook(id(), over))));
    expect(await refused({ url: 'ftp://hooks.example.test/x' })).toBe('23514');
    expect(await refused({ url: 'hooks.example.test' })).toBe('23514');
    expect(await refused({ events: '{}' })).toBe('23514');
    expect(await refused({ events: '{submission.created,order.created}' })).toBe('23514');
    expect(await refused({ keyBy: 'name' })).toBe('23514');
    expect(await refused({ files: 'attach' })).toBe('23514');
    expect(await refused({ fieldKeys: '"everything"' })).toBe('23514');
    expect(await refused({ fieldKeys: '{"a":1}' })).toBe('23514');
    // Accepted: both url schemes (the API decides which the edition allows), every event, a list of field keys.
    await run(router(), insertWebhook(id(), { url: 'http://hooks.internal.example/x' }));
    await run(router(), insertWebhook(id(), { events: '{submission.created,submission.updated,submission.deleted,payment.succeeded,consent.withdrawn}', keyBy: 'id', files: 'signed_urls' }));
    await run(router(), insertWebhook(id(), { fieldKeys: '["name","email"]' }));
  });

  it('signs with a webhook_hmac secret only: an smtp secret of its own org is refused, on insert and on update', async () => {
    // The path this closes: a user with data.route and no org.settings reads email_senders.smtp_secret_id (a sender is
    // readable by every context but a respondent), then points a webhook at that secret and a URL they control. The worker
    // opens any secret as system, so it would sign each payload with the SMTP credential as the HMAC key. A foreign-key
    // check bypasses RLS, so only the kind in the key stops it; the router needs no right to the secret for it to hold.
    const router = () => user(['forms.read', 'data.route']);
    const exposed = (await as(router(), async (tx) => (await tx.execute<{ smtp_secret_id: string }>(sql`select smtp_secret_id from email_senders where id = ${fx().senderId}`)).rows))[0]!.smtp_secret_id;
    expect(exposed).toBe(fx().smtpSecretId);
    // ... and cannot read the secret row itself (secrets_access gives data.route the webhook_hmac kind only).
    expect(await as(router(), async (tx) => (await tx.execute(sql`select id from secrets where id = ${exposed}`)).rows.length)).toBe(0);
    for (const ctx of [router(), system]) {
      const err = await failure(run(ctx, insertWebhook(randomUUID(), { secret: exposed })));
      expect(pgCode(err), ctx.actor).toBe('23503');
      expect(constraintOf(err), ctx.actor).toBe('webhooks_secret_fkey');
    }
    const asOwner = await failure(
      t.owner.query(
        `insert into webhooks (id, org_id, form_id, url, secret_id, events, purpose_ids) values ($1, $2, $3, 'https://evil.example.test/x', $4, '{submission.created}', '{contact}')`,
        [randomUUID(), seed.b.orgId, seed.b.formIds[1], exposed],
      ),
    );
    expect(pgCode(asOwner)).toBe('23503');
    expect(constraintOf(asOwner)).toBe('webhooks_secret_fkey');
    // The kind cannot be written to fit: the column is fixed to 'webhook_hmac' and is not updatable.
    const forged = await failure(
      run(system, sql`insert into webhooks (id, org_id, form_id, url, secret_id, secret_kind, events, purpose_ids)
        values (${randomUUID()}, ${seed.b.orgId}, ${seed.b.formIds[1]}, 'https://evil.example.test/x', ${exposed}, 'smtp', '{submission.created}', '{contact}')`),
    );
    expect(pgCode(forged)).toBe('23514');

    // The same on update: a webhook that signs with a webhook_hmac secret cannot be moved onto an smtp one.
    const id = randomUUID();
    await run(router(), insertWebhook(id));
    for (const ctx of [router(), system]) {
      const err = await failure(run(ctx, sql`update webhooks set secret_id = ${exposed} where id = ${id}`));
      expect(pgCode(err), ctx.actor).toBe('23503');
      expect(constraintOf(err), ctx.actor).toBe('webhooks_secret_fkey');
    }
    expect(pgCode(await failure(run(system, sql`update webhooks set secret_kind = 'smtp' where id = ${id}`)))).toBe('42501');
    expect(await rowsOf('select secret_id, secret_kind from webhooks where id = $1', [id])).toEqual([{ secret_id: fx().hookSecretId, secret_kind: 'webhook_hmac' }]);
    // Moving it to another webhook_hmac secret of the org (a rotation that makes a new secret) is fine.
    const otherHook = await secretOfB('webhook_hmac');
    expect((await run(router(), sql`update webhooks set secret_id = ${otherHook} where id = ${id} returning 1`)).rows).toHaveLength(1);
    expect(await rowsOf('select secret_id from webhooks where id = $1', [id])).toEqual([{ secret_id: otherHook }]);
  });

  it('signs with a webhook_hmac secret of its own org and belongs to a form of its own org', async () => {
    const foreignSecret = await failure(run(system, insertWebhook(randomUUID(), { secret: fxA().hookSecretId })));
    expect(pgCode(foreignSecret)).toBe('23503');
    expect(constraintOf(foreignSecret)).toBe('webhooks_secret_fkey');
    const foreignForm = await failure(run(system, insertWebhook(randomUUID(), { form: seed.a.formIds[0] })));
    expect(pgCode(foreignForm)).toBe('23503');
    expect(constraintOf(foreignForm)).toBe('webhooks_form_fkey');
    // A secret that a webhook uses cannot be deleted from under it.
    expect(pgCode(await failure(run(system, sql`delete from secrets where id = ${fx().hookSecretId}`)))).toBe('23503');
  });

  it('lets a system job count failures and switch a webhook off, and never move it to another org or form', async () => {
    const id = randomUUID();
    await run(router(), insertWebhook(id));
    const off = await run(system, sql`update webhooks set consecutive_failures = 50, enabled = false, disabled_reason = '50 consecutive failures' where id = ${id} returning 1`);
    expect(off.rows).toHaveLength(1);
    expect(await rowsOf('select enabled, consecutive_failures, disabled_reason from webhooks where id = $1', [id])).toEqual([
      { enabled: false, consecutive_failures: 50, disabled_reason: '50 consecutive failures' },
    ]);
    for (const column of ['id', 'org_id', 'form_id', 'created_at']) {
      const err = await failure(run(system, sql`update webhooks set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${id}`));
      expect(pgCode(err), column).toBe('42501');
    }
    expect(pgCode(await failure(run(router(), sql`update webhooks set consecutive_failures = -1 where id = ${id}`)))).toBe('23514');
    expect(pgCode(await failure(run(router(), sql`update webhooks set purpose_ids = '{}' where id = ${id}`)))).toBe('23514');
  });
});

describe('webhook_deliveries: the delivery log', () => {
  const router = () => user(['forms.read', 'data.route']);
  const insertDelivery = (id: string, over: { webhook?: string; event?: string; status?: string; submission?: boolean; replayOf?: string | null; pair?: 'id-only' } = {}) => {
    const withSubmission = over.submission !== false;
    return sql`insert into webhook_deliveries (id, org_id, webhook_id, event, status, submission_id, submission_received_at, replay_of)
      values (${id}, ${seed.b.orgId}, ${over.webhook ?? fx().webhookId}, ${over.event ?? 'submission.created'}, ${over.status ?? 'pending'},
        ${withSubmission ? fx().submissionId : null}, ${over.pair === 'id-only' ? null : withSubmission ? fx().submissionReceivedAt.toISOString() : null}::timestamptz, ${over.replayOf ?? null})`;
  };

  it('is read, and replayed (a new pending row), by data.route or a system job, and updated only by the worker', async () => {
    const visible = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute(sql`select id from webhook_deliveries`)).rows.length);
    expect(await visible(router())).toBeGreaterThan(0);
    expect(await visible(system)).toBeGreaterThan(0);
    for (const ctx of [user(['forms.read', 'submissions.read', 'org.settings']), apiKey(['forms.read', 'submissions.read']), respondent]) expect(await visible(ctx), ctx.actor).toBe(0);

    const replay = randomUUID();
    await run(router(), insertDelivery(replay, { replayOf: fx().deliveryId }));
    expect(await rowsOf('select replay_of, status, attempt from webhook_deliveries where id = $1', [replay])).toEqual([{ replay_of: fx().deliveryId, status: 'pending', attempt: 0 }]);
    for (const ctx of [user(['forms.read', 'submissions.read']), apiKey(['forms.read']), respondent]) {
      expect(pgCode(await failure(run(ctx, insertDelivery(randomUUID())))), ctx.actor).toBe('42501');
    }
    // A user with data.route cannot rewrite or erase the log; the worker updates the attempt.
    expect((await run(router(), sql`update webhook_deliveries set status = 'succeeded' where id = ${replay} returning 1`)).rows).toEqual([]);
    expect((await run(router(), sql`delete from webhook_deliveries where id = ${replay} returning 1`)).rows).toEqual([]);
    const tried = await run(
      system,
      sql`update webhook_deliveries set attempt = 1, status = 'retrying', http_status = 503, duration_ms = 842, request_hash = ${HASH}, response_snippet = 'service unavailable', next_attempt_at = now() + interval '1 minute' where id = ${replay} returning 1`,
    );
    expect(tried.rows).toHaveLength(1);
    expect(await rowsOf('select attempt, status, http_status from webhook_deliveries where id = $1', [replay])).toEqual([{ attempt: 1, status: 'retrying', http_status: 503 }]);
    for (const column of ['id', 'org_id', 'webhook_id', 'event', 'submission_id', 'replay_of', 'created_at']) {
      const err = await failure(run(system, sql`update webhook_deliveries set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${replay}`));
      expect(pgCode(err), column).toBe('42501');
    }
  });

  it('keeps the status, event, http status, duration, hash and snippet inside their limits', async () => {
    const id = randomUUID();
    await run(system, insertDelivery(id));
    const update = (set: ReturnType<typeof sql>) => run(system, sql`update webhook_deliveries set ${set} where id = ${id}`);
    expect(pgCode(await failure(update(sql`status = 'delivered'`)))).toBe('23514');
    expect(pgCode(await failure(update(sql`http_status = 99`)))).toBe('23514');
    expect(pgCode(await failure(update(sql`http_status = 600`)))).toBe('23514');
    expect(pgCode(await failure(update(sql`duration_ms = -1`)))).toBe('23514');
    expect(pgCode(await failure(update(sql`attempt = -1`)))).toBe('23514');
    expect(pgCode(await failure(update(sql`request_hash = ${Buffer.alloc(8)}`)))).toBe('23514');
    expect(pgCode(await failure(update(sql`response_snippet = ${'x'.repeat(1025)}`)))).toBe('23514');
    await update(sql`response_snippet = ${'x'.repeat(1024)}, http_status = 599, status = 'dead'`);
    for (const status of ['pending', 'retrying', 'succeeded', 'failed', 'dead']) await update(sql`status = ${status}`);
    expect(pgCode(await failure(run(system, insertDelivery(randomUUID(), { event: 'submission.exported' }))))).toBe('23514');
  });

  it('names a webhook of its own org, and a response either by both columns or by neither (a deletion outlives its response)', async () => {
    expect(pgCode(await failure(run(system, insertDelivery(randomUUID(), { webhook: fxA().webhookId }))))).toBe('23503');
    expect(pgCode(await failure(run(system, insertDelivery(randomUUID(), { webhook: randomUUID() }))))).toBe('23503');
    expect(pgCode(await failure(run(system, insertDelivery(randomUUID(), { pair: 'id-only' }))))).toBe('23514');
    await run(system, insertDelivery(randomUUID(), { event: 'submission.deleted', submission: false }));
    // The response is not a foreign key: deleting it leaves the delivery of its own deletion event (and of the older ones) alone.
    const submission = await insertSubmission(t.owner, newSubmission(seed.b, 1, { answers: {} }));
    const id = randomUUID();
    await t.owner.query(
      `insert into webhook_deliveries (id, org_id, webhook_id, event, submission_id, submission_received_at) values ($1, $2, $3, 'submission.deleted', $4, $5)`,
      [id, seed.b.orgId, fx().webhookId, submission.id, submission.receivedAt],
    );
    await t.owner.query('delete from submissions where id = $1 and received_at = $2', [submission.id, submission.receivedAt]);
    expect(await count('select count(*)::int as n from webhook_deliveries where id = $1', [id])).toBe(1);
  });

  it('goes with its webhook', async () => {
    const hook = randomUUID();
    await run(user(['data.route']), sql`insert into webhooks (id, org_id, form_id, url, secret_id, events, purpose_ids)
      values (${hook}, ${seed.b.orgId}, ${seed.b.formIds[1]}, 'https://hooks.example.test/gone', ${fx().hookSecretId}, '{submission.created}', '{contact}')`);
    for (let i = 0; i < 3; i++) await run(system, insertDelivery(randomUUID(), { webhook: hook }));
    expect(await count('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [hook])).toBe(3);
    expect((await run(user(['data.route']), sql`delete from webhooks where id = ${hook} returning 1`)).rows).toHaveLength(1);
    expect(await count('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [hook])).toBe(0);
    // Org A's webhook and its delivery are untouched by any of this.
    expect(await count('select count(*)::int as n from webhook_deliveries where webhook_id = $1', [fxA().webhookId])).toBe(1);
  });
});

describe('exports', () => {
  const exporter = () => user(['forms.read', 'submissions.export']);
  const insertExport = (id: string, over: { key?: string; format?: string; sensitive?: boolean; reason?: string | null; status?: string; objectKey?: string | null; form?: string; org?: string } = {}) =>
    sql`insert into exports (id, org_id, form_id, requested_by, format, scope, include_sensitive, reason, idempotency_key, status, object_key)
        values (${id}, ${over.org ?? seed.b.orgId}, ${over.form ?? seed.b.formIds[0]}, ${seed.b.editorId}, ${over.format ?? 'csv'}, '{"kind":"filtered","from":"2026-01-01"}'::jsonb,
          ${over.sensitive ?? false}, ${over.reason ?? null}, ${over.key ?? `key-${id}`}, ${over.status ?? 'queued'}, ${over.objectKey ?? null})`;

  it('is asked for and read with submissions.export, and a member inserts only a queued row with no file', async () => {
    const visible = (ctx: Ctx) => as(ctx, async (tx) => (await tx.execute(sql`select id from exports`)).rows.length);
    expect(await visible(exporter())).toBeGreaterThan(0);
    expect(await visible(system)).toBeGreaterThan(0);
    for (const ctx of [user(['forms.read', 'submissions.read', 'data.route', 'org.settings']), apiKey(['submissions.read']), respondent]) expect(await visible(ctx), ctx.actor).toBe(0);
    for (const ctx of [user(['forms.read', 'submissions.read']), apiKey(['forms.read']), respondent]) {
      expect(pgCode(await failure(run(ctx, insertExport(randomUUID())))), ctx.actor).toBe('42501');
    }

    const id = randomUUID();
    await run(exporter(), insertExport(id));
    expect(await rowsOf(`select status, object_key, row_count, bytes, format from exports where id = $1`, [id])).toEqual([{ status: 'queued', object_key: null, row_count: null, bytes: null, format: 'csv' }]);
    // The file's state belongs to the worker: a crafted object key or a "ready" row from a member is refused.
    expect(pgCode(await failure(run(exporter(), insertExport(randomUUID(), { status: 'ready' }))))).toBe('42501');
    expect(pgCode(await failure(run(exporter(), insertExport(randomUUID(), { objectKey: `${seed.a.orgId}/stolen.csv` }))))).toBe('42501');
    await run(system, insertExport(randomUUID(), { status: 'ready', objectKey: `${seed.b.orgId}/ok.csv` }));
  });

  it('is changed and removed by a system job only', async () => {
    const id = randomUUID();
    await run(exporter(), insertExport(id));
    const tamper = await run(exporter(), sql`update exports set status = 'ready', object_key = ${`${seed.a.orgId}/other.csv`} where id = ${id} returning 1`);
    expect(tamper.rows).toEqual([]);
    expect((await run(exporter(), sql`delete from exports where id = ${id} returning 1`)).rows).toEqual([]);
    expect(await rowsOf('select status, object_key from exports where id = $1', [id])).toEqual([{ status: 'queued', object_key: null }]);
    const built = await run(
      system,
      sql`update exports set status = 'ready', row_count = 12, object_key = ${`${seed.b.orgId}/${id}.csv`}, bytes = 2048, finished_at = now(), expires_at = now() + interval '24 hours' where id = ${id} returning 1`,
    );
    expect(built.rows).toHaveLength(1);
    for (const column of ['id', 'org_id', 'form_id', 'requested_by', 'format', 'scope', 'include_sensitive', 'reason', 'idempotency_key', 'created_at']) {
      const err = await failure(run(system, sql`update exports set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${id}`));
      expect(pgCode(err), column).toBe('42501');
    }
    expect((await run(system, sql`delete from exports where id = ${id} returning 1`)).rows).toHaveLength(1);
  });

  it('answers a repeated Idempotency-Key of an org with a unique violation, and lets another org use the same key', async () => {
    const key = `idem-${randomUUID()}`;
    await run(exporter(), insertExport(randomUUID(), { key }));
    const again = await failure(run(exporter(), insertExport(randomUUID(), { key })));
    expect(pgCode(again)).toBe('23505');
    expect(constraintOf(again)).toBe('exports_idempotency_key');
    await withTenant(t.app.db, { orgId: seed.a.orgId, requestId: 'effects', actor: 'user', userId: seed.a.editorId, perms: ['submissions.export'] }, (tx) =>
      tx.execute(sql`insert into exports (id, org_id, form_id, requested_by, format, scope, idempotency_key) values (${randomUUID()}, ${seed.a.orgId}, ${seed.a.formIds[0]}, ${seed.a.editorId}, 'csv', '{"kind":"all"}'::jsonb, ${key})`),
    );
  });

  it('needs a reason to include sensitive fields, and holds a known format and status', async () => {
    const id = () => randomUUID();
    for (const reason of [null, '', '   \n']) {
      const err = await failure(run(exporter(), insertExport(id(), { sensitive: true, reason })));
      expect(pgCode(err), String(reason)).toBe('23514');
      expect(constraintOf(err)).toBe('exports_sensitive_reason_check');
    }
    await run(exporter(), insertExport(id(), { sensitive: true, reason: 'DPDP access request 17' }));
    await run(exporter(), insertExport(id(), { sensitive: false, reason: null }));
    await run(exporter(), insertExport(id(), { format: 'xlsx' }));
    expect(pgCode(await failure(run(exporter(), insertExport(id(), { format: 'pdf' }))))).toBe('23514');
    expect(pgCode(await failure(run(system, insertExport(id(), { status: 'cancelled' }))))).toBe('23514');
    for (const status of ['queued', 'running', 'ready', 'failed', 'expired']) await run(system, insertExport(id(), { status }));
    expect(pgCode(await failure(run(exporter(), sql`insert into exports (id, org_id, form_id, requested_by, format, scope, idempotency_key) values (${id()}, ${seed.b.orgId}, ${seed.b.formIds[0]}, ${seed.b.editorId}, 'csv', '[]'::jsonb, ${`k-${id()}`})`)))).toBe('23514');
  });

  it('is an export of a form of its own org', async () => {
    const err = await failure(run(exporter(), insertExport(randomUUID(), { form: seed.a.formIds[0] })));
    expect(pgCode(err)).toBe('23503');
    expect(constraintOf(err)).toBe('exports_form_fkey');
  });
});

describe('disclosures: the ledger that only grows', () => {
  const append = (id: string, over: { kind?: string; name?: string; submissionId?: string } = {}) =>
    sql`insert into disclosures (id, org_id, submission_id, submission_received_at, recipient_kind, recipient_id, display_name, field_keys)
        values (${id}, ${seed.b.orgId}, ${over.submissionId ?? fx().submissionId}, ${fx().submissionReceivedAt.toISOString()}::timestamptz, ${over.kind ?? 'webhook'}, ${fx().webhookId}, ${over.name ?? 'hooks.example.test'}, '{name}')`;

  it('grants fr_app SELECT and INSERT on the ledger and no other privilege, on the table or on any column', async () => {
    const table = (await rowsOf(`select privilege_type from information_schema.role_table_grants where grantee = 'fr_app' and table_schema = 'public' and table_name = 'disclosures' order by 1`)).map((r) => r.privilege_type);
    expect(table).toEqual(['INSERT', 'SELECT']);
    const columns = (
      await rowsOf(`select distinct privilege_type from information_schema.column_privileges where grantee = 'fr_app' and table_schema = 'public' and table_name = 'disclosures' order by 1`)
    ).map((r) => r.privilege_type);
    expect(columns).toEqual(['INSERT', 'SELECT']);
  });

  it('names a recipient kind from the list, a display name, and a response that exists', async () => {
    const reader = user(['submissions.read']);
    for (const kind of ['notification', 'webhook', 'export']) await run(system, append(randomUUID(), { kind }));
    expect(pgCode(await failure(run(system, append(randomUUID(), { kind: 'integration' }))))).toBe('23514');
    expect(pgCode(await failure(run(system, append(randomUUID(), { name: '' }))))).toBe('23514');
    const err = await failure(run(system, append(randomUUID(), { submissionId: randomUUID() })));
    expect(pgCode(err)).toBe('23503');
    expect(constraintOf(err)).toBe('disclosures_submission_fkey');
    const listed = await as(reader, async (tx) => (await tx.execute<{ n: string }>(sql`select count(*)::text as n from disclosures`)).rows[0]!.n);
    expect(Number(listed)).toBe(await count('select count(*)::int as n from disclosures where org_id = $1', [seed.b.orgId]));
  });

  it('lives as long as the response: deleting it deletes its rows, though fr_app cannot delete a ledger row itself', async () => {
    const submission = await insertSubmission(t.owner, newSubmission(seed.b, 1, { answers: {} }));
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      await t.owner.query(
        `insert into disclosures (id, org_id, submission_id, submission_received_at, recipient_kind, recipient_id, display_name, field_keys) values ($1, $2, $3, $4, 'export', $5, 'CSV export', '{a,b}')`,
        [id, seed.b.orgId, submission.id, submission.receivedAt, fx().exportId],
      );
    }
    expect(pgCode(await failure(run(system, sql`delete from disclosures where id = ${ids[0]}`)))).toBe('42501');
    const deleter = user(['submissions.read', 'submissions.delete']);
    const removed = await run(deleter, sql`delete from submissions where id = ${submission.id} and received_at = ${submission.receivedAt.toISOString()}::timestamptz returning 1`);
    expect(removed.rows).toHaveLength(1);
    expect(await count('select count(*)::int as n from disclosures where id = any($1)', [ids])).toBe(0);
    // The other responses' rows are still there.
    expect(await count('select count(*)::int as n from disclosures where id = $1', [fx().disclosureId])).toBe(1);
  });
});

describe('the monthly partitions of email_messages and webhook_deliveries', () => {
  const PARTITIONED = ['email_messages', 'webhook_deliveries'] as const;

  it('are kept up by partitions.maintain: both are in PARTITIONED_TABLES', () => {
    for (const table of PARTITIONED) expect(PARTITIONED_TABLES).toContain(table);
  });

  it.each(PARTITIONED)('%s has the current month and three more in schema parts, forced RLS and no grants, and no default partition', async (table) => {
    const { rows: months } = await t.owner.query<{ name: string }>(
      `select 'parts.${table}_' || to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => i), 'YYYY_MM') as name from generate_series(0, 3) i order by i`,
    );
    const partitions = await partitionsOf(t.owner, table);
    expect(partitions.map((p) => p.name)).toEqual(expect.arrayContaining(months.map((m) => m.name)));
    for (const p of partitions) {
      expect(p, p.name).toMatchObject({ name: expect.stringMatching(new RegExp(`^parts\\.${table}_\\d{4}_\\d{2}$`)), forced: true, owner: 'fr_migrator', grantees: ['fr_migrator'] });
    }
    // No partition catches a row outside the months that exist: it fails loudly instead of landing in a default.
    const hook = fx().webhookId;
    const err =
      table === 'email_messages'
        ? await failure(
            t.owner.query(
              `insert into email_messages (id, created_at, org_id, form_id, submission_id, submission_received_at, notification_id, role, to_display_masked, subject_hash, message_id)
               values ($1, '2001-01-01', $2, $3, $4, $5, $6, 'owner', '{a}', $7, 'x')`,
              [randomUUID(), seed.b.orgId, seed.b.formIds[0], fx().submissionId, fx().submissionReceivedAt, fx().notificationId, HASH],
            ),
          )
        : await failure(t.owner.query(`insert into webhook_deliveries (id, created_at, org_id, webhook_id, event) values ($1, '2001-01-01', $2, $3, 'submission.created')`, [randomUUID(), seed.b.orgId, hook]));
    expect(pgCode(err)).toBe('23514');
    expect(message(err)).toMatch(/no partition of relation/);
    // The partition is reachable only through its parent: fr_app has no usage on schema parts.
    const direct = await failure(t.app.pool.query(`select * from ${partitions[0]!.name}`));
    expect(pgCode(direct)).toBe('42501');
  });

  it.each(PARTITIONED)('%s gets its next months from create_partitions, once', async (table) => {
    const created = await createPartitions(t.app.db, table as PartitionedTable, 5);
    expect(created.length).toBe(2);
    expect(await createPartitions(t.app.db, table as PartitionedTable, 5)).toEqual([]);
    expect(created.every((name) => name.startsWith(`${table}_`))).toBe(true);
  });
});
