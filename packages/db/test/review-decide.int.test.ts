import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newSubmissionKey,
  REVIEW_DECIDE_OUTCOMES,
  reviewDecide,
  reviewerScope,
  reviewOpen,
  uuidV7,
  withTenant,
  type ReviewDecideInput,
  type ReviewOpenUnit,
  type TenantCtx,
  type Tx,
} from '../src/index.ts';
import { failure, insertSubmission, newSubmission, pgCode, seedTwoOrgs, setupTestDb, type Seed, type SubmissionSeed, type TestDb } from './harness.ts';

/**
 * Section-level maker-checker review, the two functions (WP-2.33, migration 0024): review_open() writes the round-1 rows
 * of a held response, review_decide() is the only way a checker's decision is written and the only way the response leaves
 * 'pending_review'. These tests call them as fr_app inside a tenant transaction, the way the API does. The tables
 * (who may write them, append-only) are reviews.int.test.ts; the cross-org isolation of every table is rls.int.test.ts.
 */

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

type Ctx = Omit<TenantCtx, 'requestId' | 'orgId'>;
const as = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>, orgId: string = seed.b.orgId) => withTenant(t.app.db, { ...ctx, orgId, requestId: 'review-decide-test' }, fn);

const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Everything the review function needs a checker to hold: the permission only (the group and the second factor are data, below). */
const REVIEW_PERMS = ['submissions.review'];
const system: Ctx = { actor: 'system' };
const respondent: Ctx = { actor: 'respondent' };

interface Person {
  id: string;
  email: string;
}

/** A member of org B (an editor), who may be in a group, have two-factor sign-in on, and have a verified address. */
async function person(
  opts: { group?: string; totp?: boolean; verified?: boolean; email?: string; memberStatus?: 'active' | 'suspended'; org?: Seed['b'] } = {},
): Promise<Person> {
  const org = opts.org ?? seed.b;
  const id = randomUUID();
  const email = opts.email ?? `p-${id}@checkers.test`;
  await t.owner.query(
    `insert into users (id, email, email_norm, password_hash, email_verified_at, totp_enabled_at) values ($1, $2, $3, 'x', $4, $5)`,
    [id, email, email.trim().toLowerCase(), opts.verified === false ? null : new Date(), opts.totp === false ? null : new Date()],
  );
  await t.owner.query(`insert into memberships (org_id, user_id, role, status) values ($1, $2, 'editor', $3)`, [org.orgId, id, opts.memberStatus ?? 'active']);
  if (opts.group) await t.owner.query(`insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)`, [org.orgId, opts.group, id, org.ownerId]);
  return { id, email };
}

async function newGroup(org: Seed['b'] = seed.b): Promise<string> {
  const id = randomUUID();
  await t.owner.query(`insert into review_groups (id, org_id, name, created_by) values ($1, $2, $3, $4)`, [id, org.orgId, `Group ${id.slice(0, 8)}`, org.ownerId]);
  return id;
}

interface FormFixture {
  id: string;
  versionId: string;
}

/** A form of org B with a published version and review settings (only `distinctCheckers` is read by review_decide()). */
async function newForm(opts: { distinctCheckers?: boolean; org?: Seed['b'] } = {}): Promise<FormFixture> {
  const org = opts.org ?? seed.b;
  const form = { id: randomUUID(), versionId: randomUUID() };
  await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [form.id, org.orgId, org.teamId, org.ownerId, 'Reviewed form']);
  await t.owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash) values ($1, $2, $3, 1, 2, $4, '{}', '{}', '0')`,
    [form.versionId, org.orgId, form.id, org.ownerId],
  );
  await t.owner.query(`insert into form_review_settings (form_id, org_id, enabled, settings, updated_by) values ($1, $2, true, $3, $4)`, [
    form.id,
    org.orgId,
    JSON.stringify({ distinctCheckers: opts.distinctCheckers ?? false, units: [] }),
    org.ownerId,
  ]);
  return form;
}

interface UnitSpec {
  id: string;
  group: string;
  order?: number;
  required?: boolean;
  applicable?: boolean;
}

interface Held {
  sub: Pick<SubmissionSeed, 'id' | 'receivedAt'>;
  form: FormFixture;
  hash(unit: string): Buffer;
}

/** A response held for review: stored 'pending_review' as the submit transaction would, then opened with review_open(). */
async function held(units: readonly UnitSpec[], opts: { form?: FormFixture; emails?: string[]; opener?: Ctx } = {}): Promise<Held> {
  const form = opts.form ?? (await newForm());
  const sub = await insertSubmission(t.owner, newSubmission({ orgId: seed.b.orgId, formIds: [form.id, form.id], versionIds: [form.versionId, form.versionId] }, 0, { status: 'pending_review', answers: {} }));
  const hashes = new Map(units.map((u) => [u.id, sha(`${sub.id}:${u.id}`)]));
  const hash = (unit: string) => hashes.get(unit) ?? sha('unknown');
  await as(opts.opener ?? respondent, (tx) =>
    reviewOpen(tx, {
      submissionId: sub.id,
      receivedAt: sub.receivedAt,
      formVersionId: form.versionId,
      units: units.map<ReviewOpenUnit>((u) => ({
        unitId: u.id,
        groupId: u.group,
        order: u.order ?? 1,
        required: u.required ?? true,
        visibility: 'own_unit',
        applicable: u.applicable ?? true,
        answersHash: hash(u.id),
      })),
      respondentEmails: opts.emails,
    }),
  );
  return { sub, form, hash };
}

const checker = (p: Person, perms: string[] = REVIEW_PERMS): Ctx => ({ actor: 'user', userId: p.id, perms });

type DecideOver = Partial<ReviewDecideInput>;
const input = (h: Held, unit: string, over: DecideOver = {}): ReviewDecideInput => ({
  submissionId: h.sub.id,
  receivedAt: h.sub.receivedAt,
  unitId: unit,
  decision: 'approve',
  answersHash: h.hash(unit),
  idempotencyKey: `k-${randomUUID()}`,
  decisionId: uuidV7(new Date()),
  ...over,
});
const decide = (who: Person, h: Held, unit: string, over: DecideOver = {}) => as(checker(who), (tx) => reviewDecide(tx, input(h, unit, over)));

interface Stored {
  status: string;
  revision: number;
  decisions: number;
  units: Record<string, { state: string; rev: number }>;
}

/** What the tables hold of one response, read as the schema owner: a refusal must leave this exactly as it was. */
async function stored(h: Held): Promise<Stored> {
  const s = (await t.owner.query<{ status: string; revision: number }>('select status, revision from submissions where id = $1 and received_at = $2', [h.sub.id, h.sub.receivedAt])).rows[0]!;
  const decisions = (await t.owner.query<{ n: number }>('select count(*)::int as n from review_decisions where submission_id = $1', [h.sub.id])).rows[0]!.n;
  const units = (await t.owner.query<{ unit_id: string; state: string; rev: number }>('select unit_id, state, rev from submission_reviews where submission_id = $1 order by unit_id', [h.sub.id])).rows;
  return { status: s.status, revision: s.revision, decisions, units: Object.fromEntries(units.map((u) => [u.unit_id, { state: u.state, rev: u.rev }])) };
}

/** A refusal: its outcome, and nothing written. */
async function refused(h: Held, run: () => Promise<{ outcome: string; decisionId: string | null; replayed: boolean }>, outcome: string) {
  const before = await stored(h);
  const result = await run();
  expect(result).toMatchObject({ outcome, decisionId: null, replayed: false });
  expect(await stored(h)).toEqual(before);
}

describe('the four-eyes rule (WP-2.33: the maker, the last editor, the respondent)', () => {
  it('refuses the maker, the last editor and a member whose verified address matches the respondent, called directly as fr_app, and writes no decision', async () => {
    const group = await newGroup();
    const maker = await person({ group });
    const editor = await person({ group });
    const applicant = await person({ group, email: 'Applicant@Corp.test' });
    const other = await person({ group });
    const h = await held([{ id: 'u1', group }], { opener: checker(maker, []), emails: ['  applicant@CORP.test ', 'someone-else@elsewhere.test'] });
    // Nothing sets last_editor_id yet (SUB-09, owner edits): the owner's connection stands in for that path.
    await t.owner.query(`update submission_reviews set last_editor_id = $1 where submission_id = $2 and unit_id = 'u1'`, [editor.id, h.sub.id]);
    const before = await stored(h);

    // The function itself, without the TypeScript wrapper: this is what a route that forgot its own check would reach.
    const direct = (who: Person) =>
      as(checker(who), async (tx) => {
        const { rows } = await tx.execute<{ outcome: string; decision_id: string | null }>(
          sql`select * from review_decide(${h.sub.id}::uuid, ${h.sub.receivedAt.toISOString()}::timestamptz, 'u1', 'approve', null, ${h.hash('u1')}, ${`direct-${randomUUID()}`}, ${uuidV7(new Date())}::uuid)`,
        );
        return rows[0]!;
      });
    for (const who of [maker, editor, applicant]) expect(await direct(who), who.email).toMatchObject({ outcome: 'four_eyes_violation', decision_id: null });
    expect(await stored(h)).toEqual(before);
    expect(before.decisions).toBe(0);

    // The same three through the wrapper, and the control: a checker who is none of them decides.
    for (const who of [maker, editor, applicant]) expect(await decide(who, h, 'u1'), who.email).toMatchObject({ outcome: 'four_eyes_violation', decisionId: null });
    expect(await stored(h)).toEqual(before);
    expect(await decide(other, h, 'u1')).toMatchObject({ outcome: 'decided', unitState: 'approved', submissionStatus: 'complete' });
  });

  it('records who the maker is: the signed-in user for a user context, nobody for a respondent or a job; and stores no address', async () => {
    const group = await newGroup();
    const maker = await person({ group });
    const asUser = await held([{ id: 'u1', group }], { opener: checker(maker, []), emails: ['applicant@kept-out.test'] });
    const asRespondent = await held([{ id: 'u1', group }], { opener: respondent });
    const asJob = await held([{ id: 'u1', group }], { opener: system });
    const makers = async (h: Held) => (await t.owner.query<{ maker: string | null }>('select maker_user_id as maker from submission_reviews where submission_id = $1', [h.sub.id])).rows[0]!.maker;
    expect(await makers(asUser)).toBe(maker.id);
    expect(await makers(asRespondent)).toBeNull();
    expect(await makers(asJob)).toBeNull();
    // The address the respondent gave is in no column of the review rows.
    const { rows } = await t.owner.query('select 1 from submission_reviews r where r::text ilike $1', ['%kept-out%']);
    expect(rows).toEqual([]);
  });

  it('excludes every member of this org with a verified address, whatever their status, matched case-insensitively', async () => {
    const group = await newGroup();
    const verified = await person({ group, email: 'Mixed.Case@Corp.test' });
    const unverified = await person({ group, email: 'unverified@corp.test', verified: false });
    const suspended = await person({ group, email: 'suspended@corp.test', memberStatus: 'suspended' });
    const disabled = await person({ group, email: 'disabled@corp.test' });
    await t.owner.query(`update users set status = 'disabled' where id = $1`, [disabled.id]);
    // Same address in the other org: an account of org A is not a member of org B.
    const elsewhere = await person({ org: seed.a, email: 'elsewhere@corp.test' });
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }], {
      emails: ['mixed.case@corp.test', 'UNVERIFIED@corp.test', 'suspended@corp.test', 'disabled@corp.test', 'elsewhere@corp.test', 'nobody@corp.test'],
    });
    const rows = (await t.owner.query<{ unit_id: string; excluded: string[] }>('select unit_id, excluded_user_ids as excluded from submission_reviews where submission_id = $1 order by unit_id', [h.sub.id])).rows;
    const expected = [verified.id, suspended.id, disabled.id].sort();
    expect(rows.map((r) => ({ unit_id: r.unit_id, excluded: [...r.excluded].sort() }))).toEqual([
      { unit_id: 'u1', excluded: expected },
      { unit_id: 'u2', excluded: expected },
    ]);
    expect(rows.flatMap((r) => r.excluded)).not.toContain(unverified.id);
    expect(rows.flatMap((r) => r.excluded)).not.toContain(elsewhere.id);
    // The unverified member is not excluded (their address proves nothing yet): they may check.
    expect(await decide(unverified, h, 'u1')).toMatchObject({ outcome: 'decided' });
    expect(await decide(verified, h, 'u2')).toMatchObject({ outcome: 'four_eyes_violation' });
  });

  it('keeps a member who was suspended or disabled when the review opened excluded after they are reactivated, and writes no decision', async () => {
    const group = await newGroup();
    const onLeave = await person({ group, email: 'on-leave@corp.test', memberStatus: 'suspended' });
    const locked = await person({ group, email: 'locked@corp.test' });
    await t.owner.query(`update users set status = 'disabled' where id = $1`, [locked.id]);
    const other = await person({ group });
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }], { emails: ['On-Leave@corp.test', 'locked@corp.test'] });
    // While suspended or disabled they cannot decide at all.
    await refused(h, () => decide(onLeave, h, 'u1'), 'not_in_group');
    await refused(h, () => decide(locked, h, 'u1'), 'not_in_group');
    // An admin brings them back: every other check passes now, and only the exclusion stands between them and their own response.
    await t.owner.query(`update memberships set status = 'active' where org_id = $1 and user_id = $2`, [seed.b.orgId, onLeave.id]);
    await t.owner.query(`update users set status = 'active' where id = $1`, [locked.id]);
    await refused(h, () => decide(onLeave, h, 'u1'), 'four_eyes_violation');
    await refused(h, () => decide(locked, h, 'u2'), 'four_eyes_violation');
    expect((await t.owner.query('select 1 from review_decisions where submission_id = $1', [h.sub.id])).rows).toEqual([]);
    // Someone else can still check both units.
    expect(await decide(other, h, 'u1')).toMatchObject({ outcome: 'decided' });
    expect(await decide(other, h, 'u2')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('counts how many members the match excluded, for the audit event', async () => {
    const group = await newGroup();
    await person({ group, email: 'one@counted.test' });
    await person({ group, email: 'two@counted.test' });
    const form = await newForm();
    const sub = await insertSubmission(t.owner, newSubmission({ orgId: seed.b.orgId, formIds: [form.id, form.id], versionIds: [form.versionId, form.versionId] }, 0, { status: 'pending_review', answers: {} }));
    const opened = await as(system, (tx) =>
      reviewOpen(tx, {
        submissionId: sub.id,
        receivedAt: sub.receivedAt,
        formVersionId: form.versionId,
        units: [
          { unitId: 'a', groupId: group, order: 1, required: true, visibility: 'own_unit', applicable: true, answersHash: sha('a') },
          { unitId: 'b', groupId: group, order: 1, required: false, visibility: 'whole_submission', applicable: false, answersHash: sha('b') },
        ],
        respondentEmails: ['ONE@counted.test', 'two@counted.test', 'one@counted.test'],
      }),
    );
    expect(opened).toEqual({ units: 2, pending: 1, excluded: 2 });
  });
});

describe('who may decide: permission, group and two-factor sign-in', () => {
  it('answers permission_denied to a user without submissions.review and to every other kind of actor, and writes nothing', async () => {
    const group = await newGroup();
    const member = await person({ group });
    const h = await held([{ id: 'u1', group }]);
    const run = (ctx: Ctx) => () => as(ctx, (tx) => reviewDecide(tx, input(h, 'u1')));
    await refused(h, run(checker(member, ['forms.read', 'submissions.read', 'submissions.edit', 'members.manage', 'ops.manage'])), 'permission_denied');
    await refused(h, run({ actor: 'api_key', perms: REVIEW_PERMS }), 'permission_denied');
    await refused(h, run({ ...respondent, perms: REVIEW_PERMS }), 'permission_denied');
    await refused(h, run({ ...system, perms: REVIEW_PERMS }), 'permission_denied');
    // The permission is not enough for a response of another org: it does not exist there.
    await refused(h, () => as(checker(member), (tx) => reviewDecide(tx, input(h, 'u1')), seed.a.orgId), 'not_found');
    // With the permission and the group it is decided.
    expect(await decide(member, h, 'u1')).toMatchObject({ outcome: 'decided' });
  });

  it('answers not_in_group to a member outside the unit\'s group, including one whose membership is suspended, and writes nothing', async () => {
    const [g1, g2] = [await newGroup(), await newGroup()];
    const outsider = await person();
    const otherGroup = await person({ group: g2 });
    const suspended = await person({ group: g1, memberStatus: 'suspended' });
    const insider = await person({ group: g1 });
    const h = await held([{ id: 'u1', group: g1 }]);
    for (const who of [outsider, otherGroup, suspended]) await refused(h, () => decide(who, h, 'u1'), 'not_in_group');
    // A member of the org with every role-based permission is still not a checker of a group they are not in.
    await refused(h, () => as({ actor: 'user', userId: seed.b.ownerId, perms: [...REVIEW_PERMS, 'members.manage', 'ops.manage'] }, (tx) => reviewDecide(tx, input(h, 'u1'))), 'not_in_group');
    expect(await decide(insider, h, 'u1')).toMatchObject({ outcome: 'decided' });
  });

  it('answers mfa_required to a checker without two-factor sign-in while the org requires it, and lets them decide once it does not', async () => {
    const group = await newGroup();
    const noTotp = await person({ group, totp: false });
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }]);
    await refused(h, () => decide(noTotp, h, 'u1'), 'mfa_required');
    // The org's setting is read at decision time: switched off, the same checker decides. Restored after.
    await t.owner.query('update org_settings set review_checkers_mfa = false where org_id = $1', [seed.b.orgId]);
    try {
      expect(await decide(noTotp, h, 'u1')).toMatchObject({ outcome: 'decided' });
    } finally {
      await t.owner.query('update org_settings set review_checkers_mfa = true where org_id = $1', [seed.b.orgId]);
    }
    await refused(h, () => decide(noTotp, h, 'u2'), 'mfa_required');
  });

  it('answers not_found for a unit or a response that does not exist, and raises for arguments no API would send', async () => {
    const group = await newGroup();
    const member = await person({ group });
    const h = await held([{ id: 'u1', group }]);
    await refused(h, () => decide(member, h, 'nope'), 'not_found');
    const ghost = newSubmissionKey(new Date());
    await refused(h, () => as(checker(member), (tx) => reviewDecide(tx, { ...input(h, 'u1'), submissionId: ghost.id, receivedAt: ghost.receivedAt })), 'not_found');
    // Malformed arguments raise 22023 and write nothing.
    const bad = async (over: DecideOver | Record<string, unknown>) => pgCode(await failure(decide(member, h, 'u1', over as DecideOver)));
    expect(await bad({ decision: 'maybe' as 'approve' })).toBe('22023');
    expect(await bad({ decision: 'reject' })).toBe('22023');
    expect(await bad({ decision: 'reject', reasonCode: 'because' as 'other' })).toBe('22023');
    expect(await bad({ decision: 'approve', reasonCode: 'other' })).toBe('22023');
    expect(await bad({ idempotencyKey: '' })).toBe('22023');
    expect(await bad({ idempotencyKey: 'x'.repeat(256) })).toBe('22023');
    expect((await stored(h)).decisions).toBe(0);
    // The wrapper refuses a hash that is not a sha256 before it asks the database.
    await expect(decide(member, h, 'u1', { answersHash: Buffer.alloc(31) })).rejects.toThrow(/sha256/);
    expect(REVIEW_DECIDE_OUTCOMES).toContain('decided');
  });
});

describe('two checkers at once', () => {
  it('lets exactly one of two concurrent decisions on a unit win and tells the other review_closed', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'u1', group }]);
    // The first transaction decides and then keeps its transaction open; the second starts meanwhile, so it has to wait
    // for the lock on the response and then find the unit decided.
    const first = as(checker(a), async (tx) => {
      const result = await reviewDecide(tx, input(h, 'u1'));
      await tx.execute(sql`select pg_sleep(0.6)`);
      return result;
    });
    await sleep(200);
    const started = Date.now();
    const second = await as(checker(b), (tx) => reviewDecide(tx, input(h, 'u1')));
    const waited = Date.now() - started;
    const results = [await first, second];
    expect(results.filter((r) => r.outcome === 'decided')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'review_stale' || r.outcome === 'review_closed')).toHaveLength(1);
    expect(second).toMatchObject({ outcome: 'review_closed', decisionId: null });
    expect(waited).toBeGreaterThan(250);
    const state = await stored(h);
    expect(state.decisions).toBe(1);
    expect(state.units.u1).toEqual({ state: 'approved', rev: 2 });
  });

  it('completes the response when the last two required units are approved at once (the second sees the first)', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }]);
    const first = as(checker(a), async (tx) => {
      const result = await reviewDecide(tx, input(h, 'u1'));
      await tx.execute(sql`select pg_sleep(0.6)`);
      return result;
    });
    await sleep(200);
    const second = await as(checker(b), (tx) => reviewDecide(tx, input(h, 'u2')));
    const firstResult = await first;
    expect(firstResult).toMatchObject({ outcome: 'decided', submissionStatus: 'pending_review' });
    // Without the lock on the response each would have seen the other's unit still pending and nothing would have completed it.
    expect(second).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
    expect(await stored(h)).toMatchObject({ status: 'complete', decisions: 2 });
  });
});

describe('a retried request (idempotency key)', () => {
  it('returns the first decision_id and outcome and writes no second row', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'u1', group }, { id: 'u2', group, order: 2 }]);
    const key = `retry-${randomUUID()}`;
    const first = await decide(a, h, 'u1', { idempotencyKey: key });
    expect(first).toMatchObject({ outcome: 'decided', unitState: 'approved', submissionStatus: 'pending_review', replayed: false });
    const afterFirst = await stored(h);

    // The retry carries a decision id of its own (the API makes one per request); the first one comes back.
    const retry = await decide(a, h, 'u1', { idempotencyKey: key, decisionId: uuidV7(new Date()) });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await stored(h)).toEqual(afterFirst);
    expect((await t.owner.query('select 1 from review_decisions where idempotency_key = $1', [key])).rowCount).toBe(1);

    // The key is the request: another user, another unit, another decision or another hash is a reuse, not a replay.
    const reuse = (who: Person, unit: string, over: DecideOver = {}) => decide(who, h, unit, { idempotencyKey: key, ...over });
    for (const result of [
      await reuse(b, 'u1'),
      await reuse(a, 'u2'),
      await reuse(a, 'u1', { decision: 'reject', reasonCode: 'other' }),
      await reuse(a, 'u1', { answersHash: sha('something else') }),
    ]) {
      expect(result).toMatchObject({ outcome: 'idempotency_key_reused', decisionId: null, replayed: false });
    }
    expect(await stored(h)).toEqual(afterFirst);
  });

  it('replays the decision that finalised the response, and a replay still needs the permission', async () => {
    const group = await newGroup();
    const a = await person({ group });
    const h = await held([{ id: 'u1', group }]);
    const key = `final-${randomUUID()}`;
    const first = await decide(a, h, 'u1', { idempotencyKey: key });
    expect(first).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
    expect(await decide(a, h, 'u1', { idempotencyKey: key })).toEqual({ ...first, replayed: true });
    // A different key for the same unit is a new request, and the unit is closed.
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'review_closed', unitState: 'approved', submissionStatus: 'complete' });
    // The first result is not handed to someone who may no longer review.
    expect(await as(checker(a, ['forms.read']), (tx) => reviewDecide(tx, input(h, 'u1', { idempotencyKey: key })))).toMatchObject({ outcome: 'permission_denied', decisionId: null });
    expect((await stored(h)).decisions).toBe(1);
  });
});

describe('when a response is final', () => {
  it('completes only when every required applicable unit is approved; optional pending units and not-applicable ones do not block, and are closed', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([
      { id: 'u1', group },
      { id: 'u2', group },
      { id: 'optional', group, required: false },
      { id: 'hidden', group, applicable: false },
    ]);
    expect((await stored(h)).units).toEqual({ hidden: { state: 'not_applicable', rev: 1 }, optional: { state: 'pending', rev: 1 }, u1: { state: 'pending', rev: 1 }, u2: { state: 'pending', rev: 1 } });
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'decided', unitState: 'approved', submissionStatus: 'pending_review' });
    expect(await stored(h)).toMatchObject({ status: 'pending_review', revision: 1 });
    // A not-applicable unit is never asked.
    await refused(h, () => decide(b, h, 'hidden'), 'review_closed');

    expect(await decide(b, h, 'u2')).toMatchObject({ outcome: 'decided', unitState: 'approved', submissionStatus: 'complete' });
    const done = await stored(h);
    expect(done.status).toBe('complete');
    expect(done.revision).toBe(2);
    // The optional unit was still pending: it is closed with the response, so no queue keeps offering it.
    expect(done.units).toEqual({ hidden: { state: 'not_applicable', rev: 1 }, optional: { state: 'closed', rev: 2 }, u1: { state: 'approved', rev: 2 }, u2: { state: 'approved', rev: 2 } });
    // And it cannot be decided any more: the response is not held.
    await refused(h, () => decide(a, h, 'optional'), 'review_closed');
  });

  it('decides nothing on a response the grid trashed (trashed_at set, the status still pending_review): an approval must not release it', async () => {
    const group = await newGroup();
    const a = await person({ group });
    const h = await held([{ id: 'u1', group }]);
    await t.owner.query('update submissions set trashed_at = now() where id = $1 and received_at = $2', [h.sub.id, h.sub.receivedAt]);
    await refused(h, () => decide(a, h, 'u1'), 'review_closed');
    await refused(h, () => decide(a, h, 'u1', { decision: 'reject', reasonCode: 'other' }), 'review_closed');
    expect((await stored(h)).status).toBe('pending_review');
    // Restored, it is decided as usual.
    await t.owner.query('update submissions set trashed_at = null where id = $1 and received_at = $2', [h.sub.id, h.sub.receivedAt]);
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('completes without the optional unit being decided, and an optional unit that was rejected does not reject the response', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'must', group }, { id: 'nice', group, required: false }]);
    expect(await decide(a, h, 'nice', { decision: 'reject', reasonCode: 'duplicate' })).toMatchObject({ outcome: 'decided', unitState: 'rejected', submissionStatus: 'pending_review' });
    expect(await decide(b, h, 'must')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
    expect((await stored(h)).units).toEqual({ must: { state: 'approved', rev: 2 }, nice: { state: 'rejected', rev: 2 } });
  });

  it('rejects the response on a required reject, records the reason, and closes the units that were still pending', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }, { id: 'u3', group, required: false }]);
    expect(await decide(a, h, 'u1', { decision: 'approve' })).toMatchObject({ outcome: 'decided' });
    const rejected = await decide(b, h, 'u2', { decision: 'reject', reasonCode: 'missing_document' });
    expect(rejected).toMatchObject({ outcome: 'decided', unitState: 'rejected', submissionStatus: 'rejected' });
    const state = await stored(h);
    expect(state).toMatchObject({ status: 'rejected', revision: 2, decisions: 2 });
    expect(state.units).toEqual({ u1: { state: 'approved', rev: 2 }, u2: { state: 'rejected', rev: 2 }, u3: { state: 'closed', rev: 2 } });
    const row = (await t.owner.query('select decision, reason_code, decided_by, form_version_id from review_decisions where id = $1', [rejected.decisionId])).rows[0];
    expect(row).toEqual({ decision: 'reject', reason_code: 'missing_document', decided_by: b.id, form_version_id: h.form.versionId });
    // Nothing is decided on a rejected response.
    await refused(h, () => decide(a, h, 'u3'), 'review_closed');
  });

  it('does not complete on an approval of answers that have changed since: approved against the current answers_hash only', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }]);
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'decided', submissionStatus: 'pending_review' });
    // The unit's answers changed after it was approved (SUB-09 will also reopen it; here only the hash moves, as an owner edit
    // that forgot to would leave it). Its approval names the old hash, so it does not count.
    await t.owner.query(`update submission_reviews set answers_hash = $1 where submission_id = $2 and unit_id = 'u1'`, [sha('edited'), h.sub.id]);
    expect(await decide(b, h, 'u2')).toMatchObject({ outcome: 'decided', unitState: 'approved', submissionStatus: 'pending_review' });
    expect(await stored(h)).toMatchObject({ status: 'pending_review', revision: 1 });
  });

  it('answers review_stale to a decision on answers that are not the current ones, and writes nothing', async () => {
    const group = await newGroup();
    const a = await person({ group });
    const h = await held([{ id: 'u1', group }]);
    await refused(h, () => decide(a, h, 'u1', { answersHash: sha('what the checker saw before the edit') }), 'review_stale');
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'decided' });
  });
});

describe('order, and one checker for one unit', () => {
  it('answers order_blocked to an order-2 unit while an order-1 required unit is pending, and decides it once that is approved', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'first', group, order: 1 }, { id: 'second', group, order: 2 }]);
    await refused(h, () => decide(b, h, 'second'), 'order_blocked');
    expect(await decide(a, h, 'first')).toMatchObject({ outcome: 'decided' });
    expect(await decide(b, h, 'second')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('waits for required units only, and for approved or not-applicable ones: an optional or a hidden order-1 unit does not block order 2', async () => {
    const group = await newGroup();
    const a = await person({ group });
    const h = await held([
      { id: 'optional-first', group, order: 1, required: false },
      { id: 'hidden-first', group, order: 1, applicable: false },
      { id: 'second', group, order: 2 },
    ]);
    expect(await decide(a, h, 'second')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('lets units of the same order be decided in any order', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const h = await held([{ id: 'x', group, order: 1 }, { id: 'y', group, order: 1 }]);
    expect(await decide(a, h, 'y')).toMatchObject({ outcome: 'decided', submissionStatus: 'pending_review' });
    expect(await decide(b, h, 'x')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('with distinctCheckers, answers four_eyes_violation to a checker who already decided another unit of the response', async () => {
    const group = await newGroup();
    const [a, b] = [await person({ group }), await person({ group })];
    const form = await newForm({ distinctCheckers: true });
    const h = await held([{ id: 'u1', group, order: 1 }, { id: 'u2', group, order: 2 }, { id: 'u3', group, order: 2 }], { form });
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'decided' });
    await refused(h, () => decide(a, h, 'u2'), 'four_eyes_violation');
    expect(await decide(b, h, 'u2')).toMatchObject({ outcome: 'decided' });
    // The rule is about the same response: another response of the form is a fresh start for the same checker.
    const other = await held([{ id: 'u1', group }], { form });
    expect(await decide(a, other, 'u1')).toMatchObject({ outcome: 'decided' });
    // b decided u2 and a decided u1: neither may take u3.
    await refused(h, () => decide(a, h, 'u3'), 'four_eyes_violation');
    await refused(h, () => decide(b, h, 'u3'), 'four_eyes_violation');
    const third = await person({ group });
    expect(await decide(third, h, 'u3')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('without distinctCheckers, lets one checker decide several units of a response', async () => {
    const group = await newGroup();
    const a = await person({ group });
    const h = await held([{ id: 'u1', group }, { id: 'u2', group }]);
    expect(await decide(a, h, 'u1')).toMatchObject({ outcome: 'decided' });
    expect(await decide(a, h, 'u2')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });
});

describe('review_open', () => {
  const units = (group: string, version = 'a'): ReviewOpenUnit[] => [
    { unitId: `u-${version}`, groupId: group, order: 1, required: true, visibility: 'own_unit', applicable: true, answersHash: sha('open') },
  ];
  const newHeld = async (status = 'pending_review') => {
    const form = await newForm();
    const sub = await insertSubmission(t.owner, newSubmission({ orgId: seed.b.orgId, formIds: [form.id, form.id], versionIds: [form.versionId, form.versionId] }, 0, { status, answers: {} }));
    return { form, sub };
  };
  const open = (ctx: Ctx, h: { form: FormFixture; sub: Pick<SubmissionSeed, 'id' | 'receivedAt'> }, us: ReviewOpenUnit[], over: Partial<Parameters<typeof reviewOpen>[1]> = {}, orgId?: string) =>
    as(ctx, (tx) => reviewOpen(tx, { submissionId: h.sub.id, receivedAt: h.sub.receivedAt, formVersionId: h.form.versionId, units: us, ...over }), orgId);
  const rowsOf = async (id: string) => (await t.owner.query('select 1 from submission_reviews where submission_id = $1', [id])).rowCount;

  it('refuses a response that is not pending_review, and one that already has review rows', async () => {
    const group = await newGroup();
    for (const status of ['complete', 'pending_payment', 'spam', 'rejected']) {
      const h = await newHeld(status);
      const err = await failure(open(respondent, h, units(group)));
      expect(pgCode(err), status).toBe('55000');
      expect(await rowsOf(h.sub.id), status).toBe(0);
    }
    const once = await newHeld();
    await open(respondent, once, units(group));
    const again = await failure(open(respondent, once, units(group, 'b')));
    expect(pgCode(again)).toBe('55000');
    expect(await rowsOf(once.sub.id)).toBe(1);
  });

  it('refuses a response of another org or that does not exist, a version that is not the response\'s, and callers that are not a respondent, user or job', async () => {
    const group = await newGroup();
    const h = await newHeld();
    expect(pgCode(await failure(open(respondent, h, units(group), {}, seed.a.orgId)))).toBe('P0002');
    const ghost = newSubmissionKey(new Date());
    expect(pgCode(await failure(open(respondent, h, units(group), { submissionId: ghost.id, receivedAt: ghost.receivedAt })))).toBe('P0002');
    expect(pgCode(await failure(open(respondent, h, units(group), { formVersionId: seed.b.versionIds[1] })))).toBe('22023');
    for (const ctx of [{ actor: 'api_key', perms: REVIEW_PERMS }, { actor: 'platform' }] as Ctx[]) expect(pgCode(await failure(open(ctx, h, units(group))))).toBe('42501');
    expect(await rowsOf(h.sub.id)).toBe(0);
  });

  it('refuses units that are malformed, repeated, of another org\'s group, or without a required applicable unit', async () => {
    const group = await newGroup();
    const foreign = await newGroup(seed.a);
    const h = await newHeld();
    const [one] = units(group);
    const bad = async (us: ReviewOpenUnit[]) => pgCode(await failure(open(respondent, h, us)));
    expect(await bad([])).toBe('22023');
    // Nothing to hold the response for: every required unit is hidden, or the applicable ones are optional.
    expect(await bad([{ ...one!, applicable: false }])).toBe('22023');
    expect(await bad([{ ...one!, required: false }])).toBe('22023');
    expect(await bad([{ ...one!, order: 0 }])).toBe('23514');
    expect(await bad([{ ...one!, visibility: 'everyone' as 'own_unit' }])).toBe('23514');
    expect(await bad([one!, one!])).toBe('23505');
    expect(await bad([{ ...one!, groupId: foreign }])).toBe('23503');
    expect(await bad([{ ...one!, groupId: randomUUID() }])).toBe('23503');
    // The raw function, with a hash that is not 64 hex digits and a unit that is not an object.
    const raw = (us: unknown) =>
      as(respondent, (tx) =>
        tx.execute(sql`select * from review_open(${h.sub.id}::uuid, ${h.sub.receivedAt.toISOString()}::timestamptz, ${h.form.versionId}::uuid, ${JSON.stringify(us)}::jsonb, '{}'::text[])`),
      );
    expect(pgCode(await failure(raw([{ unitId: 'u', groupId: group, order: 1, required: true, visibility: 'own_unit', applicable: true, answersHash: 'abc' }])))).toBe('22023');
    expect(pgCode(await failure(raw({ not: 'an array' })))).toBe('22023');
    expect(await rowsOf(h.sub.id)).toBe(0);
    // And the good one still opens after all those refusals.
    expect(await open(respondent, h, [one!])).toEqual({ units: 1, pending: 1, excluded: 0 });
  });

  it('matches the respondent\'s addresses case-insensitively in the database too, whatever the caller sent', async () => {
    const group = await newGroup();
    const member = await person({ group, email: 'Casey@Corp.test' });
    const h = await newHeld();
    // The TypeScript wrapper lower-cases first; the function itself must not depend on that.
    const { rows } = await as(respondent, (tx) =>
      tx.execute<{ excluded_count: number }>(
        sql`select * from review_open(${h.sub.id}::uuid, ${h.sub.receivedAt.toISOString()}::timestamptz, ${h.form.versionId}::uuid, ${JSON.stringify(
          units(group).map((u) => ({ ...u, answersHash: sha('raw').toString('hex') })),
        )}::jsonb, ${'{"  CASEY@corp.TEST ","other@x.test"}'}::text[])`,
      ),
    );
    expect(rows[0]!.excluded_count).toBe(1);
    expect((await t.owner.query('select excluded_user_ids as ids from submission_reviews where submission_id = $1', [h.sub.id])).rows).toEqual([{ ids: [member.id] }]);
  });

  it('does not exclude a member who joined (or verified their address) after the review was opened: a documented limit', async () => {
    const group = await newGroup();
    const email = `late-${randomUUID()}@corp.test`;
    const h = await held([{ id: 'u1', group }], { emails: [email] });
    // The account exists already but unverified, and is a member of the group: not excluded at open time.
    const late = await person({ group, email, verified: false });
    await t.owner.query('update users set email_verified_at = now() where id = $1', [late.id]);
    const excluded = (await t.owner.query<{ ids: string[] }>('select excluded_user_ids as ids from submission_reviews where submission_id = $1', [h.sub.id])).rows[0]!.ids;
    expect(excluded).toEqual([]);
    // So the rule cannot stop them: the match is made when the review is opened (blind indexes, WP-1.11, will close this).
    expect(await decide(late, h, 'u1')).toMatchObject({ outcome: 'decided', submissionStatus: 'complete' });
  });

  it('stores one row per unit with the group, order, required, visibility and hash it was given, and not_applicable for a hidden unit', async () => {
    const [g1, g2] = [await newGroup(), await newGroup()];
    const h = await newHeld();
    const us: ReviewOpenUnit[] = [
      { unitId: 'p1', groupId: g1, order: 1, required: true, visibility: 'own_unit', applicable: true, answersHash: sha('p1') },
      { unitId: 'p2', groupId: g2, order: 3, required: false, visibility: 'whole_submission', applicable: false, answersHash: sha('p2') },
    ];
    expect(await open(system, h, us)).toEqual({ units: 2, pending: 1, excluded: 0 });
    const rows = (await t.owner.query(
      `select unit_id, round, state, required, review_order, group_id, visibility, encode(answers_hash, 'hex') as hash, rev, org_id, form_id from submission_reviews where submission_id = $1 order by unit_id`,
      [h.sub.id],
    )).rows;
    expect(rows).toEqual([
      { unit_id: 'p1', round: 1, state: 'pending', required: true, review_order: 1, group_id: g1, visibility: 'own_unit', hash: sha('p1').toString('hex'), rev: 1, org_id: seed.b.orgId, form_id: h.form.id },
      { unit_id: 'p2', round: 1, state: 'not_applicable', required: false, review_order: 3, group_id: g2, visibility: 'whole_submission', hash: sha('p2').toString('hex'), rev: 1, org_id: seed.b.orgId, form_id: h.form.id },
    ]);
  });
});

describe('the functions are the way in, for fr_app only', () => {
  it('are executable by fr_app and not by public, and fr_app still cannot write the tables or the status itself', async () => {
    const { rows } = await t.owner.query<{ fn: string; app: boolean; public: boolean; definer: boolean; config: string[] }>(
      `select p.proname as fn, has_function_privilege('fr_app', p.oid, 'execute') as app, has_function_privilege('public', p.oid, 'execute') as public,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.proname in ('review_open', 'review_decide') order by 1`,
    );
    expect(rows).toEqual([
      { fn: 'review_decide', app: true, public: false, definer: true, config: ['search_path=pg_catalog, public'] },
      { fn: 'review_open', app: true, public: false, definer: true, config: ['search_path=pg_catalog, public'] },
    ]);
    const group = await newGroup();
    const member = await person({ group });
    const h = await held([{ id: 'u1', group }]);
    const writes = [
      sql`update submissions set status = 'complete' where id = ${h.sub.id}`,
      sql`update submission_reviews set state = 'approved'`,
      sql`insert into review_decisions (id, org_id, form_id, submission_id, submission_received_at, unit_id, round, decision, decided_by, answers_hash, form_version_id, idempotency_key)
          values (${randomUUID()}, ${seed.b.orgId}, ${h.form.id}, ${h.sub.id}, ${h.sub.receivedAt.toISOString()}::timestamptz, 'u1', 1, 'approve', ${member.id}, ${h.hash('u1')}, ${h.form.versionId}, 'sneaky')`,
    ];
    const everything = { actor: 'user', userId: member.id, perms: [...REVIEW_PERMS, 'submissions.read', 'submissions.edit', 'submissions.delete'] } satisfies Ctx;
    for (const write of writes) expect(pgCode(await failure(as(everything, (tx) => tx.execute(write))))).toBe('42501');
    expect(await stored(h)).toMatchObject({ status: 'pending_review', decisions: 0 });
  });
});

describe('reviewerScope', () => {
  const putSettings = (form: FormFixture, settings: Record<string, unknown>, enabled = true) =>
    t.owner.query('update form_review_settings set settings = $1, enabled = $2 where form_id = $3', [JSON.stringify(settings), enabled, form.id]);

  it('returns the live settings and the groups of the user that are assigned a unit of the form', async () => {
    const [g1, g2, g3] = [await newGroup(), await newGroup(), await newGroup()];
    const form = await newForm();
    const settings = {
      distinctCheckers: true,
      units: [
        { unitId: 'u1', groupId: g1, order: 1, required: true, visibility: 'own_unit' },
        { unitId: 'u2', groupId: g2, order: 2, required: false, visibility: 'whole_submission' },
      ],
    };
    await putSettings(form, settings);
    const user = await person({ group: g1 });
    await t.owner.query(`insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)`, [seed.b.orgId, g3, user.id, seed.b.ownerId]);
    const scope = await as({ actor: 'user', userId: user.id, perms: [] }, (tx) => reviewerScope(tx, { formId: form.id, userId: user.id }));
    // g3 is the user's too, but no unit of this form is assigned to it; g2 is assigned but the user is not in it.
    expect(scope).toEqual({ settings: { enabled: true, ...settings }, groupIds: [g1] });
    // Not a reviewer of the form: no groups. A disabled form keeps its units, so a review still running keeps its reviewers.
    const stranger = await person();
    expect((await as({ actor: 'user', userId: stranger.id, perms: [] }, (tx) => reviewerScope(tx, { formId: form.id, userId: stranger.id }))).groupIds).toEqual([]);
    await putSettings(form, settings, false);
    expect(await as({ actor: 'user', userId: user.id, perms: [] }, (tx) => reviewerScope(tx, { formId: form.id, userId: user.id }))).toMatchObject({ settings: { enabled: false }, groupIds: [g1] });
    // An owner of the org who is in the group is a reviewer too, whatever their role.
    await t.owner.query(`insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)`, [seed.b.orgId, g1, seed.b.ownerId, seed.b.ownerId]);
    expect((await as({ actor: 'user', userId: seed.b.ownerId, perms: [] }, (tx) => reviewerScope(tx, { formId: form.id, userId: seed.b.ownerId }))).groupIds).toEqual([g1]);
  });

  it('answers no settings and no groups for a form that was never set up, for a form of another org, and for a suspended member', async () => {
    const group = await newGroup();
    const user = await person({ group });
    const plain = randomUUID();
    await t.owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [plain, seed.b.orgId, seed.b.teamId, seed.b.ownerId, 'No review']);
    const scope = (formId: string, userId = user.id, orgId = seed.b.orgId) => as({ actor: 'user', userId, perms: [] }, (tx) => reviewerScope(tx, { formId, userId }), orgId);
    expect(await scope(plain)).toEqual({ settings: null, groupIds: [] });
    expect(await scope(randomUUID())).toEqual({ settings: null, groupIds: [] });
    // A form of org B read in org A's context is invisible.
    const form = await newForm();
    await putSettings(form, { distinctCheckers: false, units: [{ unitId: 'u1', groupId: group, order: 1, required: true, visibility: 'own_unit' }] });
    expect(await scope(form.id, user.id, seed.a.orgId)).toEqual({ settings: null, groupIds: [] });
    expect((await scope(form.id)).groupIds).toEqual([group]);
    await t.owner.query(`update memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [seed.b.orgId, user.id]);
    expect((await scope(form.id)).groupIds).toEqual([]);
  });

  it('reads a row made with the defaults as "no units", and refuses a row that does not parse rather than treat the form as unreviewed', async () => {
    const group = await newGroup();
    const user = await person({ group });
    const defaults = await newForm();
    await t.owner.query(`update form_review_settings set settings = '{}', enabled = false where form_id = $1`, [defaults.id]);
    const run = (form: FormFixture) => as({ actor: 'user', userId: user.id, perms: [] }, (tx) => reviewerScope(tx, { formId: form.id, userId: user.id }));
    expect(await run(defaults)).toEqual({ settings: { enabled: false, distinctCheckers: false, units: [] }, groupIds: [] });
    const broken = await newForm();
    await putSettings(broken, { distinctCheckers: false, units: [{ unitId: 'u1', groupId: 'not-a-uuid-but-opaque', order: 0, required: true, visibility: 'own_unit' }] });
    await expect(run(broken)).rejects.toThrow(/not valid/);
    await putSettings(broken, { surprise: true });
    await expect(run(broken)).rejects.toThrow(/not valid/);
  });
});
