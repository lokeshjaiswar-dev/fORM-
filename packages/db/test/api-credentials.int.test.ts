import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secretEnc, secretPublicColumns, secrets, withTenant, type TenantCtx, type Tx } from '../src/index.ts';
import { failure, pgCode, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

/**
 * T-LK-10 (migration 0026): org API credentials are `secrets` rows of kind api_credential. A forms.edit author may list the
 * public columns to pick one for a lookup; only org.settings (or a system job) may create, rotate or delete one; `enc` stays
 * unselectable for everyone but a system context; the other kinds keep their own rules.
 */

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

type Ctx = Omit<TenantCtx, 'requestId' | 'orgId'>;
const as = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>, orgId = seed.b.orgId) => withTenant(t.app.db, { orgId, requestId: 'api-cred', ...ctx }, fn);
const run = (ctx: Ctx, statement: ReturnType<typeof sql>) => as(ctx, (tx) => tx.execute(statement));
const user = (perms: string[]): Ctx => ({ actor: 'user', userId: seed.b.editorId, perms });
const system: Ctx = { actor: 'system' };
const respondent: Ctx = { actor: 'respondent' };
const formsEdit = () => user(['forms.read', 'forms.edit']);
const orgSettings = () => user(['forms.read', 'org.settings']);
const dataRoute = () => user(['forms.read', 'data.route']);
const SEALED = { v: 1, alg: 'aes-256-gcm', ct: 'c2VhbGVkLWluLXRoZS1zZWVk' };
const META = JSON.stringify({ name: 'HR API', type: 'bearer', host: 'hr.example', last4: 'abcd' });
const insert = (id: string, kind: string, orgId = seed.b.orgId) => sql`insert into secrets (id, org_id, kind, enc, meta) values (${id}, ${orgId}, ${kind}, ${JSON.stringify({ ...SEALED, n: id })}::jsonb, ${META}::jsonb)`;
const ownerInsert = async (kind: string, orgId = seed.b.orgId) => {
  const id = randomUUID();
  await t.owner.query('insert into secrets (id, org_id, kind, enc, meta) values ($1, $2, $3, $4, $5)', [id, orgId, kind, JSON.stringify(SEALED), META]);
  return id;
};
const kindsSeenBy = (ctx: Ctx) => as(ctx, async (tx) => (await tx.select({ kind: secrets.kind }).from(secrets)).map((s) => s.kind).sort());

describe('secrets of kind api_credential (T-LK-10)', () => {
  it('accepts the kind (the check constraint knows it) and refuses an unknown kind', async () => {
    const id = await ownerInsert('api_credential');
    expect((await t.owner.query('select kind from secrets where id = $1', [id])).rows[0]).toEqual({ kind: 'api_credential' });
    const err = await failure(t.owner.query(`insert into secrets (id, org_id, kind, enc) values ($1, $2, 'made_up', '{}')`, [randomUUID(), seed.b.orgId]));
    expect(pgCode(err)).toBe('23514');
  });

  it('forms.edit lists the public columns of an api_credential and cannot select enc', async () => {
    const id = await ownerInsert('api_credential');
    const rows = await as(formsEdit(), (tx) => tx.select(secretPublicColumns).from(secrets));
    const mine = rows.find((r) => r.id === id);
    expect(mine).toMatchObject({ kind: 'api_credential', orgId: seed.b.orgId, meta: { name: 'HR API', host: 'hr.example', last4: 'abcd' } });
    expect(Object.keys(mine ?? {})).not.toContain('enc');
    for (const statement of [sql`select enc from secrets`, sql`select * from secrets`, sql`select id from secrets where enc is not null`]) {
      expect(pgCode(await failure(run(formsEdit(), statement)))).toBe('42501');
    }
  });

  it('forms.edit cannot create, rotate or delete an api_credential', async () => {
    const id = await ownerInsert('api_credential');
    expect(pgCode(await failure(run(formsEdit(), insert(randomUUID(), 'api_credential'))))).toBe('42501');
    expect((await run(formsEdit(), sql`update secrets set meta = '{"host":"evil.example"}'::jsonb where id = ${id} returning 1`)).rows).toEqual([]);
    expect((await run(formsEdit(), sql`update secrets set enc = '{"v":9}'::jsonb where id = ${id} returning 1`)).rows).toEqual([]);
    expect((await run(formsEdit(), sql`delete from secrets where id = ${id} returning 1`)).rows).toEqual([]);
    expect((await t.owner.query('select meta from secrets where id = $1', [id])).rows[0]?.meta).toMatchObject({ host: 'hr.example' });
  });

  it('org.settings creates, rotates and deletes an api_credential', async () => {
    const id = randomUUID();
    await run(orgSettings(), insert(id, 'api_credential'));
    expect((await run(orgSettings(), sql`update secrets set enc = '{"v":2}'::jsonb, rotated_at = now() where id = ${id} returning 1`)).rows).toHaveLength(1);
    expect((await run(orgSettings(), sql`delete from secrets where id = ${id} returning 1`)).rows).toHaveLength(1);
  });

  it('data.route and a respondent see no api_credential, and cannot write one', async () => {
    const id = await ownerInsert('api_credential');
    expect(await kindsSeenBy(dataRoute())).not.toContain('api_credential');
    expect(await kindsSeenBy(respondent)).toEqual([]);
    expect(pgCode(await failure(run(dataRoute(), insert(randomUUID(), 'api_credential'))))).toBe('42501');
    expect((await run(dataRoute(), sql`delete from secrets where id = ${id} returning 1`)).rows).toEqual([]);
  });

  it('smtp and webhook_hmac stay invisible to forms.edit, and keep their own writers', async () => {
    await ownerInsert('smtp');
    await ownerInsert('webhook_hmac');
    expect(await kindsSeenBy(formsEdit())).not.toContain('smtp');
    expect(await kindsSeenBy(formsEdit())).not.toContain('webhook_hmac');
    expect(pgCode(await failure(run(formsEdit(), insert(randomUUID(), 'smtp'))))).toBe('42501');
    expect(pgCode(await failure(run(formsEdit(), insert(randomUUID(), 'webhook_hmac'))))).toBe('42501');
    expect(pgCode(await failure(run(dataRoute(), insert(randomUUID(), 'smtp'))))).toBe('42501');
    await run(orgSettings(), insert(randomUUID(), 'smtp'));
    await run(dataRoute(), insert(randomUUID(), 'webhook_hmac'));
    expect(pgCode(await failure(run(orgSettings(), insert(randomUUID(), 'webhook_hmac'))))).toBe('42501');
  });

  it("another org's api_credential is invisible and untouchable, whoever asks", async () => {
    const theirs = await ownerInsert('api_credential', seed.a.orgId);
    expect(await as(orgSettings(), (tx) => tx.select({ id: secrets.id }).from(secrets).then((r) => r.map((x) => x.id))).then((ids) => ids.includes(theirs))).toBe(false);
    expect((await run(orgSettings(), sql`delete from secrets where id = ${theirs} returning 1`)).rows).toEqual([]);
    expect(pgCode(await failure(run(orgSettings(), insert(randomUUID(), 'api_credential', seed.a.orgId))))).toBe('42501');
    expect(await as(system, (tx) => secretEnc(tx, theirs))).toBeNull();
  });

  it('only a system context opens the sealed value', async () => {
    const id = await ownerInsert('api_credential');
    expect(await as(system, (tx) => secretEnc(tx, id))).toMatchObject({ v: 1 });
    expect(pgCode(await failure(as(formsEdit(), (tx) => secretEnc(tx, id))))).toBe('42501');
    expect(pgCode(await failure(as(orgSettings(), (tx) => secretEnc(tx, id))))).toBe('42501');
  });
});
