import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { reviewUnitAnswersHash } from '@form/logic';
import type { JobName, JobRequest, Queue, SqlExecutor } from '@form/ports';
import type { Tx } from '@form/db';
import type { Answers, BlockId, CompiledForm, ReviewGroupId, ReviewSettings, ReviewUnitId } from '@form/schema';
import { emailsOf, finaliseOnDecision, hasReviewUnits, openReview, planReview, planReviewFrom, readReviewSettings, type DecisionOutcome, type PlanInput } from './open.ts';

const dialect = new PgDialect();

/** A transaction that records the statements it is given (as SQL text and parameters) and answers with `reply`. */
function fakeTx(reply: (sql: string, params: unknown[]) => unknown[] = () => []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    execute: vi.fn(async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql, params } = dialect.sqlToQuery(query);
      statements.push({ sql, params });
      return { rows: reply(sql, params) };
    }),
  } as unknown as Tx;
  return { tx, statements };
}

/** A queue that keeps what it was sent and the executor it was told to send through. */
function fakeQueue(id: string | null = 'job-1') {
  const sent: Array<{ name: JobName; job: JobRequest<JobName>; tx: SqlExecutor | undefined }> = [];
  const queue: Queue = {
    send: vi.fn(async (name, job, o) => {
      sent.push({ name, job: job as JobRequest<JobName>, tx: o?.tx });
      return id;
    }) as Queue['send'],
    work: vi.fn() as unknown as Queue['work'],
    schedule: vi.fn() as unknown as Queue['schedule'],
    unschedule: vi.fn() as unknown as Queue['unschedule'],
  };
  return { queue, sent };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const GROUP_A = '44444444-4444-4444-8444-444444444444' as ReviewGroupId;
const GROUP_B = '55555555-5555-4555-8555-555555555555' as ReviewGroupId;
const SUBMISSION = '018f0000-0000-7000-8000-000000000001';
const RECEIVED = new Date('2026-11-15T10:00:00.000Z');

const bid = (id: string) => id as BlockId;
const unit = (id: string) => id as ReviewUnitId;

/** Two units over four blocks, and a block (`note`) that belongs to neither. u_contact opens with a section break. */
const COMPILED = {
  reviewUnits: { u_applicant: [bid('name'), bid('age')], u_contact: [bid('brk'), bid('email')] },
  reviewUnitMarkers: { u_contact: bid('brk') },
} as unknown as CompiledForm;

const SETTINGS: ReviewSettings = {
  enabled: true,
  distinctCheckers: false,
  units: [
    { unitId: unit('u_applicant'), groupId: GROUP_A, order: 1, required: true, visibility: 'own_unit' },
    { unitId: unit('u_contact'), groupId: GROUP_B, order: 2, required: true, visibility: 'whole_submission' },
  ],
};

const ANSWERS = {
  name: { type: 'short_text', value: 'Asha Rao' },
  age: { type: 'number', value: '31' },
  email: { type: 'email', value: { address: 'asha@example.test' } },
  note: { type: 'long_text', value: 'Not in any unit' },
} as unknown as Answers;

const shown = (...ids: string[]) => ({ visible: new Set(ids) as ReadonlySet<never> }) as PlanInput['evalState'];
const ALL_SHOWN = shown('name', 'age', 'brk', 'email', 'note');
const input = (over: Partial<PlanInput> = {}): PlanInput => ({ compiled: COMPILED, answers: ANSWERS, evalState: ALL_SHOWN, ...over });

describe('planReviewFrom: which units a response is held for', () => {
  it('holds a response with a required, applicable unit, one element per assigned unit that the version holds', () => {
    const plan = planReviewFrom(SETTINGS, input());
    expect(plan).not.toBeNull();
    expect(plan!.units.map((u) => [u.unitId, u.groupId, u.order, u.required, u.visibility, u.applicable])).toEqual([
      ['u_applicant', GROUP_A, 1, true, 'own_unit', true],
      ['u_contact', GROUP_B, 2, true, 'whole_submission', true],
    ]);
  });

  it('hashes each unit’s own answers: the sha256 of the unit’s stored answers as 32 bytes, nothing outside the unit counting', () => {
    const plan = planReviewFrom(SETTINGS, input())!;
    for (const u of plan.units) {
      expect(u.answersHash).toHaveLength(32);
      expect(Buffer.from(u.answersHash).toString('hex')).toBe(reviewUnitAnswersHash(COMPILED, u.unitId as ReviewUnitId, ANSWERS));
    }
    // An answer outside every unit changes no hash; one inside a unit changes that unit's hash only.
    const edited = { ...ANSWERS, note: { type: 'long_text', value: 'Changed' }, age: { type: 'number', value: '32' } } as unknown as Answers;
    const again = planReviewFrom(SETTINGS, input({ answers: edited }))!;
    expect(Buffer.from(again.units[0]!.answersHash).equals(Buffer.from(plan.units[0]!.answersHash))).toBe(false);
    expect(Buffer.from(again.units[1]!.answersHash).equals(Buffer.from(plan.units[1]!.answersHash))).toBe(true);
  });

  it('stores a unit whose blocks were all hidden as not applicable, and still holds for the other one', () => {
    // The section break of u_contact is shown, but it holds no answer: the unit has nothing to review.
    const plan = planReviewFrom(SETTINGS, input({ evalState: shown('name', 'age', 'brk', 'note') }))!;
    expect(plan.units.map((u) => [u.unitId, u.applicable])).toEqual([
      ['u_applicant', true],
      ['u_contact', false],
    ]);
  });

  it('is not held when every required unit is not applicable, whatever an optional one asks', () => {
    const optionalApplicant: ReviewSettings = { ...SETTINGS, units: [{ ...SETTINGS.units[0]!, required: false }, SETTINGS.units[1]!] };
    // u_contact (required) is hidden; u_applicant is shown but optional: nothing a checker must approve.
    expect(planReviewFrom(optionalApplicant, input({ evalState: shown('name', 'age', 'brk') }))).toBeNull();
    // Everything hidden.
    expect(planReviewFrom(SETTINGS, input({ evalState: shown() }))).toBeNull();
  });

  it('is not held when review is off, the form has no settings, or the assignments name no unit of this version', () => {
    expect(planReviewFrom(null, input())).toBeNull();
    expect(planReviewFrom({ ...SETTINGS, enabled: false }, input())).toBeNull();
    expect(planReviewFrom({ ...SETTINGS, units: [] }, input())).toBeNull();
    // A later version dropped the unit the settings still name: there are no blocks of it to review or hash.
    const other = { ...SETTINGS, units: [{ ...SETTINGS.units[0]!, unitId: unit('u_gone') }] };
    expect(planReviewFrom(other, input())).toBeNull();
  });

  it('ignores an assignment of a unit this version lacks and holds for the ones it has', () => {
    const settings = { ...SETTINGS, units: [{ ...SETTINGS.units[0]!, unitId: unit('u_gone') }, SETTINGS.units[1]!] };
    expect(planReviewFrom(settings, input())!.units.map((u) => u.unitId)).toEqual(['u_contact']);
  });

  it('collects the respondent’s addresses for the four-eyes check', () => {
    expect(planReviewFrom(SETTINGS, input())!.respondentEmails).toEqual(['asha@example.test']);
  });

  it('does not take a unit assigned by the respondent’s word: only the settings and the compiled form decide', () => {
    // An answer that names a unit, or a block id that is not in the unit, adds nothing.
    const forged = { ...ANSWERS, u_other: { type: 'short_text', value: 'x' } } as unknown as Answers;
    expect(planReviewFrom(SETTINGS, input({ answers: forged }))!.units).toHaveLength(2);
  });
});

describe('emailsOf', () => {
  const email = (address: string) => ({ type: 'email', value: { address } });

  it('finds every email-type answer, a repeating group’s rows and a consent’s guardian too, and no other text', () => {
    const answers = {
      a: email('one@example.test'),
      b: { type: 'short_text', value: 'two@example.test' },
      grp: { type: 'repeating_group', value: { rows: [{ rowId: 'r1', values: { c: email('three@example.test') } }, { rowId: 'r2', values: { c: email('four@example.test'), d: { type: 'short_text', value: 'x' } } }] } },
      consent: { type: 'consent', value: { items: {}, noticeLocale: 'en-IN', noticeVersion: 1, guardian: { email: 'parent@example.test' } } },
    } as unknown as Answers;
    expect(emailsOf(answers).sort()).toEqual(['four@example.test', 'one@example.test', 'parent@example.test', 'three@example.test']);
  });

  it('lists an address once and skips blank or malformed ones', () => {
    const answers = { a: email('same@example.test'), b: email('same@example.test'), c: email('  '), d: { type: 'email', value: null }, e: { type: 'email', value: { address: 7 } } } as unknown as Answers;
    expect(emailsOf(answers)).toEqual(['same@example.test']);
    expect(emailsOf({})).toEqual([]);
  });

  it('refuses more addresses than review_open takes, rather than leaving some out of the check', () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`e${i}`, email(`m${i}@example.test`)])) as unknown as Answers;
    expect(() => emailsOf(many)).toThrow(/more than 100 email addresses/);
    const exactly = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`e${i}`, email(`m${i}@example.test`)])) as unknown as Answers;
    expect(emailsOf(exactly)).toHaveLength(100);
  });
});

describe('readReviewSettings', () => {
  const row = (over: Record<string, unknown> = {}) => [{ enabled: true, settings: { distinctCheckers: true, units: SETTINGS.units }, ...over }];

  it('reads nothing for a version without review units: a form that never had review costs no statement', async () => {
    const { tx, statements } = fakeTx(() => row());
    expect(hasReviewUnits({})).toBe(false);
    expect(hasReviewUnits({ reviewUnits: {} })).toBe(false);
    expect(await readReviewSettings(tx, FORM, {})).toBeNull();
    expect(await readReviewSettings(tx, FORM, { reviewUnits: {} })).toBeNull();
    expect(statements).toEqual([]);
  });

  it('returns the stored settings of a form with review on, asked of the form by id', async () => {
    const { tx, statements } = fakeTx(() => row());
    const settings = await readReviewSettings(tx, FORM, COMPILED);
    expect(settings).toEqual({ enabled: true, distinctCheckers: true, units: SETTINGS.units });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain('from form_review_settings');
    expect(statements[0]!.params).toEqual([FORM]);
  });

  it('is null for a form with no settings row, or with review switched off (the column wins over the document)', async () => {
    expect(await readReviewSettings(fakeTx(() => []).tx, FORM, COMPILED)).toBeNull();
    expect(await readReviewSettings(fakeTx(() => row({ enabled: false, settings: { enabled: true, distinctCheckers: false, units: SETTINGS.units } })).tx, FORM, COMPILED)).toBeNull();
  });

  it('is an error, not "not reviewed", when the stored settings do not parse', async () => {
    const broken = fakeTx(() => row({ settings: { units: [{ unitId: 'u_applicant', order: 0 }] } })).tx;
    await expect(readReviewSettings(broken, FORM, COMPILED)).rejects.toThrow(/review settings of form .* are not valid/);
  });

  it('planReview reads and plans in one call', async () => {
    const { tx } = fakeTx(() => row({ settings: { distinctCheckers: false, units: SETTINGS.units } }));
    const plan = await planReview(tx, { formId: FORM, ...input() });
    expect(plan?.units.map((u) => u.unitId)).toEqual(['u_applicant', 'u_contact']);
    expect(await planReview(fakeTx(() => []).tx, { formId: FORM, ...input() })).toBeNull();
  });
});

describe('openReview', () => {
  it('opens the response’s units through review_open and appends review.opened with counts, in the same transaction', async () => {
    const { tx, statements } = fakeTx((sql) => (sql.includes('review_open') ? [{ unit_count: 2, pending_count: 1, excluded_count: 1 }] : []));
    const plan = planReviewFrom(SETTINGS, input())!;
    const opened = await openReview(tx, { orgId: ORG, formId: FORM, formVersionId: VERSION, submissionId: SUBMISSION, receivedAt: RECEIVED, requestId: 'req-1', plan });
    expect(opened).toEqual({ units: 2, pending: 1, excluded: 1 });

    const [open, record] = statements;
    expect(open!.sql).toContain('review_open(');
    // The units go as one json document, hash in hex, and the addresses as an array: never stored by the API.
    const units = JSON.parse(String(open!.params.find((p) => typeof p === 'string' && p.startsWith('[{'))));
    expect(units.map((u: { unitId: string; applicable: boolean }) => [u.unitId, u.applicable])).toEqual([['u_applicant', true], ['u_contact', true]]);
    expect(units[0].answersHash).toMatch(/^[0-9a-f]{64}$/);

    expect(record!.sql).toContain('audit_pending');
    const event = JSON.parse(String(record!.params.find((p) => typeof p === 'string' && p.includes('review.opened'))));
    expect(event).toMatchObject({
      action: 'review.opened',
      actorKind: 'respondent',
      resourceType: 'submission',
      resourceId: SUBMISSION,
      formId: FORM,
      outcome: 'success',
      requestId: 'req-1',
      metadata: { units: 2, pending: 1, excluded: 1 },
    });
    // Counts and ids only: no address and no answer.
    expect(JSON.stringify(event)).not.toContain('example.test');
    expect(JSON.stringify(event)).not.toContain('Asha');
  });

  it('appends nothing when review_open refuses (the transaction rolls back with it)', async () => {
    const { tx, statements } = fakeTx((sql) => {
      if (sql.includes('review_open')) throw new Error('review_open: the response already has review rows');
      return [];
    });
    const plan = planReviewFrom(SETTINGS, input())!;
    await expect(openReview(tx, { orgId: ORG, formId: FORM, formVersionId: VERSION, submissionId: SUBMISSION, receivedAt: RECEIVED, requestId: 'req-1', plan })).rejects.toThrow(/already has review rows/);
    expect(statements.some((s) => s.sql.includes('audit_pending'))).toBe(false);
  });
});

describe('finaliseOnDecision', () => {
  const decision = (over: Partial<DecisionOutcome> = {}): DecisionOutcome => ({
    outcome: 'decided',
    submissionStatus: 'complete',
    replayed: false,
    orgId: ORG,
    formId: FORM,
    submissionId: SUBMISSION,
    receivedAt: RECEIVED,
    ...over,
  });

  it('sends exactly one submission.fanout "released" through the decision’s transaction when a decision made the response complete', async () => {
    const { tx, statements } = fakeTx();
    const { queue, sent } = fakeQueue();
    expect(await finaliseOnDecision(tx, queue, decision())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('submission.fanout');
    // The form is the resource (the worker resolves the org from it), the data are ids only.
    expect(sent[0]!.job).toEqual({
      orgId: ORG,
      resource: { type: 'form', id: FORM },
      data: { submissionId: SUBMISSION, receivedAt: '2026-11-15T10:00:00.000Z', event: 'released' },
    });
    // Through the transaction: the executor it was given runs its statements on `tx`.
    await sent[0]!.tx!.executeSql('select 1', []);
    expect(statements.at(-1)!.sql).toContain('select 1');
  });

  it('sends nothing for a rejected response (slice 1 has no rejected event)', async () => {
    const { queue, sent } = fakeQueue();
    expect(await finaliseOnDecision(fakeTx().tx, queue, decision({ submissionStatus: 'rejected' }))).toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends nothing for a decision that left the response held (other units are open)', async () => {
    const { queue, sent } = fakeQueue();
    expect(await finaliseOnDecision(fakeTx().tx, queue, decision({ submissionStatus: 'pending_review' }))).toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends nothing for a replayed decision (its first call sent the job) or a refusal', async () => {
    const { queue, sent } = fakeQueue();
    expect(await finaliseOnDecision(fakeTx().tx, queue, decision({ replayed: true }))).toBe(false);
    for (const outcome of ['permission_denied', 'not_found', 'idempotency_key_reused', 'not_in_group', 'mfa_required', 'review_closed', 'order_blocked', 'review_stale', 'four_eyes_violation'] as const) {
      expect(await finaliseOnDecision(fakeTx().tx, queue, decision({ outcome, submissionStatus: 'complete' }))).toBe(false);
    }
    expect(await finaliseOnDecision(fakeTx().tx, queue, decision({ submissionStatus: null }))).toBe(false);
    expect(sent).toEqual([]);
  });

  it('skips the job without a queue (an app built for a test), and fails the decision when the queue stored no job', async () => {
    expect(await finaliseOnDecision(fakeTx().tx, undefined, decision())).toBe(false);
    await expect(finaliseOnDecision(fakeTx().tx, fakeQueue(null).queue, decision())).rejects.toThrow('submission.fanout was not enqueued');
  });
});
