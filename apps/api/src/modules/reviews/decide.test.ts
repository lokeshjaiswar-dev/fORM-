import { describe, expect, it } from 'vitest';
import { REVIEW_REASON_CODES } from '@form/db';
import { visibleBlocksForReviewer } from '@form/logic';
import type { CompiledForm, ReviewGroupId, ReviewSettings, ReviewUnitId } from '@form/schema';
import { PROBLEMS } from '../../errors.ts';
import { answersHashToken, rawHashOfToken, unmatchableHash, type AnswersTokenScope } from './answersToken.ts';
import { assignmentsOf, canDecideHint, decisionBody, hasSecondFactor, isBlocked, redactAnswers, refusalProblem, type Refusal, type UnitRow } from './decide.ts';
import { positionOf, QUEUE_AGES, queueScope } from './queue.ts';
import { signCursor } from '../../cursor.ts';

const GROUP_A = '0190a000-0000-7000-8000-00000000000a' as ReviewGroupId;
const GROUP_B = '0190a000-0000-7000-8000-00000000000b' as ReviewGroupId;
const GROUP_C = '0190a000-0000-7000-8000-00000000000c' as ReviewGroupId;
const ME = '0190b000-0000-7000-8000-000000000001';
const OTHER = '0190b000-0000-7000-8000-000000000002';
const HASH = 'a'.repeat(64);

describe('the body of a decision', () => {
  it('takes an approve with the hash of what the checker read, and a reject with one of the catalogue’s reasons', () => {
    expect(decisionBody.parse({ decision: 'approve', answersHash: HASH })).toEqual({ decision: 'approve', answersHash: HASH });
    for (const reasonCode of REVIEW_REASON_CODES) expect(decisionBody.parse({ decision: 'reject', reasonCode, answersHash: HASH }).reasonCode).toBe(reasonCode);
    // Either case of hex: the checker sends back the 64 digits the detail gave them.
    expect(decisionBody.safeParse({ decision: 'approve', answersHash: 'A'.repeat(64) }).success).toBe(true);
  });

  it('refuses a reject without a reason, an approve with one, and a reason that is not in the catalogue', () => {
    const noReason = decisionBody.safeParse({ decision: 'reject', answersHash: HASH });
    expect(noReason.success).toBe(false);
    expect(noReason.error?.issues[0]).toMatchObject({ path: ['reasonCode'] });
    expect(decisionBody.safeParse({ decision: 'approve', reasonCode: 'other', answersHash: HASH }).success).toBe(false);
    expect(decisionBody.safeParse({ decision: 'reject', reasonCode: 'because', answersHash: HASH }).success).toBe(false);
  });

  it('refuses a hash that is not 32 bytes of hex, a decision that is not approve or reject, and any other key', () => {
    for (const answersHash of ['', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), ` ${'a'.repeat(63)}`]) expect(decisionBody.safeParse({ decision: 'approve', answersHash }).success, answersHash).toBe(false);
    expect(decisionBody.safeParse({ decision: 'return', answersHash: HASH }).success).toBe(false);
    // A return and a note are not in this slice; nobody names themselves, an org or a time either.
    for (const extra of [{ note: 'ok' }, { decidedBy: ME }, { orgId: ME }, { decidedAt: '2026-11-16T00:00:00Z' }, { unitId: 'u1' }]) {
      expect(decisionBody.safeParse({ decision: 'approve', answersHash: HASH, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe('two-factor sign-in of a session', () => {
  it('is a level with a second factor after the first: password+totp, link+recovery', () => {
    for (const level of ['pwd+totp', 'link+totp', 'oauth+recovery', 'pwd+recovery']) expect(hasSecondFactor(level), level).toBe(true);
    for (const level of ['pwd', 'link', 'oauth', 'sso']) expect(hasSecondFactor(level), level).toBe(false);
  });
});

describe('refusals', () => {
  const EXPECTED: Record<Refusal, { code: keyof typeof PROBLEMS; status: number }> = {
    permission_denied: { code: 'FORBIDDEN', status: 403 },
    four_eyes_violation: { code: 'FOUR_EYES_VIOLATION', status: 403 },
    not_in_group: { code: 'NOT_IN_REVIEW_GROUP', status: 403 },
    mfa_required: { code: 'MFA_REQUIRED', status: 403 },
    review_stale: { code: 'REVIEW_STALE', status: 409 },
    order_blocked: { code: 'REVIEW_ORDER_BLOCKED', status: 409 },
    review_closed: { code: 'REVIEW_CLOSED', status: 409 },
    idempotency_key_reused: { code: 'IDEMPOTENCY_KEY_REUSED', status: 422 },
  };

  it('each outcome of review_decide() has its problem and status, and the route audits it itself so the handler adds no second record', () => {
    for (const [outcome, want] of Object.entries(EXPECTED) as Array<[Refusal, (typeof EXPECTED)[Refusal]]>) {
      const problem = refusalProblem(outcome);
      expect(problem.code, outcome).toBe(want.code);
      expect(PROBLEMS[problem.code].status, outcome).toBe(want.status);
      expect(problem.audited, outcome).toBe(true);
      expect(problem.detail?.length, outcome).toBeGreaterThan(10);
    }
  });
});

const unit = (o: Partial<UnitRow> & { unitId: string }): UnitRow => ({
  state: 'pending',
  required: true,
  reviewOrder: 1,
  groupId: GROUP_A,
  visibility: 'own_unit',
  makerUserId: null,
  lastEditorId: null,
  excludedUserIds: [],
  ...o,
});

describe('which unit blocks which', () => {
  it('is blocked while a required unit of a lower order is open; optional, equal and higher orders do not block', () => {
    const second = { reviewOrder: 2 };
    expect(isBlocked(second, [unit({ unitId: 'a', reviewOrder: 1, state: 'pending' })])).toBe(true);
    expect(isBlocked(second, [unit({ unitId: 'a', reviewOrder: 1, state: 'rejected' })])).toBe(true);
    expect(isBlocked(second, [unit({ unitId: 'a', reviewOrder: 1, state: 'approved' })])).toBe(false);
    expect(isBlocked(second, [unit({ unitId: 'a', reviewOrder: 1, state: 'not_applicable' })])).toBe(false);
    expect(isBlocked(second, [unit({ unitId: 'a', reviewOrder: 1, state: 'pending', required: false })])).toBe(false);
    expect(isBlocked(second, [unit({ unitId: 'a', reviewOrder: 2, state: 'pending' })])).toBe(false);
    expect(isBlocked({ reviewOrder: 1 }, [unit({ unitId: 'a', reviewOrder: 2, state: 'pending' })])).toBe(false);
  });
});

describe('the hint behind canDecide', () => {
  const base = { userId: ME, submissionStatus: 'pending_review' as const, yours: true, blocked: false, distinctCheckers: false, decidedElsewhere: false };
  const open = unit({ unitId: 'a' });

  it('is true for an open unit of the caller’s group that nothing blocks', () => {
    expect(canDecideHint(base, open)).toBe(true);
  });

  it('is false when it is not theirs, not open, blocked, or the response is not held any more', () => {
    expect(canDecideHint({ ...base, yours: false }, open)).toBe(false);
    for (const state of ['approved', 'rejected', 'not_applicable', 'closed'] as const) expect(canDecideHint(base, unit({ unitId: 'a', state })), state).toBe(false);
    expect(canDecideHint({ ...base, blocked: true }, open)).toBe(false);
    for (const submissionStatus of ['complete', 'rejected'] as const) expect(canDecideHint({ ...base, submissionStatus }, open), submissionStatus).toBe(false);
  });

  it('is false for the unit’s maker, its last editor and a member the respondent’s address excluded, and true for anyone else', () => {
    expect(canDecideHint(base, unit({ unitId: 'a', makerUserId: ME }))).toBe(false);
    expect(canDecideHint(base, unit({ unitId: 'a', lastEditorId: ME }))).toBe(false);
    expect(canDecideHint(base, unit({ unitId: 'a', excludedUserIds: [OTHER, ME] }))).toBe(false);
    expect(canDecideHint(base, unit({ unitId: 'a', makerUserId: OTHER, lastEditorId: OTHER, excludedUserIds: [OTHER] }))).toBe(true);
  });

  it('is false with distinct checkers once they decided another unit, and only then', () => {
    expect(canDecideHint({ ...base, distinctCheckers: true, decidedElsewhere: true }, open)).toBe(false);
    expect(canDecideHint({ ...base, distinctCheckers: true, decidedElsewhere: false }, open)).toBe(true);
    expect(canDecideHint({ ...base, distinctCheckers: false, decidedElsewhere: true }, open)).toBe(true);
  });
});

/** Two units over three blocks, and `free`, which no unit covers. */
const COMPILED = {
  documentOrder: ['name', 'email', 'note', 'free'],
  reviewUnits: { u_a: ['name', 'email'], u_b: ['note'] },
  plan: [],
  reads: {},
} as unknown as CompiledForm;
const ANSWERS = { name: { type: 'short_text', value: 'Asha' }, email: { type: 'email', value: { address: 'asha@x.test' } }, note: { type: 'short_text', value: 'ground floor' }, free: { type: 'short_text', value: 'anyone' }, stray: { type: 'short_text', value: 'not in any version' } };
const assignment = (unitId: string, groupId: ReviewGroupId, o: Partial<ReviewSettings['units'][number]> = {}) =>
  ({ unitId: unitId as ReviewUnitId, groupId, order: 1, required: true, visibility: 'own_unit', ...o }) as ReviewSettings['units'][number];
const settings = (...units: ReviewSettings['units']): ReviewSettings => ({ enabled: true, distinctCheckers: false, units });
const rows = [unit({ unitId: 'u_a', groupId: GROUP_A }), unit({ unitId: 'u_b', groupId: GROUP_B, reviewOrder: 2 })];
const keysFor = (live: ReviewSettings | null, groups: ReviewGroupId[]) => {
  const visible = visibleBlocksForReviewer(COMPILED, { units: assignmentsOf(live, rows) }, groups);
  return visible === null ? null : Object.keys(redactAnswers(ANSWERS, visible)).sort();
};

describe('what a checker may read of a response (own_unit)', () => {
  const live = settings(assignment('u_a', GROUP_A), assignment('u_b', GROUP_B, { order: 2 }));

  it('a checker of unit B holds no unit A answer: their unit’s and the blocks no unit covers, and nothing the version does not know', () => {
    expect(keysFor(live, [GROUP_B])).toEqual(['free', 'note']);
    expect(keysFor(live, [GROUP_A])).toEqual(['email', 'free', 'name']);
  });

  it('is the same for a member in both groups: they see both units', () => {
    expect(keysFor(live, [GROUP_A, GROUP_B])).toEqual(['email', 'free', 'name', 'note']);
  });

  it('is nothing hidden for a member in no group of the form, whatever their role', () => {
    expect(keysFor(live, [])).toBeNull();
    expect(keysFor(live, [GROUP_C])).toBeNull();
    expect(redactAnswers(ANSWERS, null)).toBe(ANSWERS);
  });

  it('is nothing hidden from a checker whose units are whole_submission, and own_unit wins for one who holds both', () => {
    const whole = settings(assignment('u_a', GROUP_A, { visibility: 'whole_submission' }), assignment('u_b', GROUP_B, { order: 2, visibility: 'own_unit' }));
    const wholeRows = [unit({ unitId: 'u_a', groupId: GROUP_A, visibility: 'whole_submission' }), unit({ unitId: 'u_b', groupId: GROUP_B, visibility: 'own_unit', reviewOrder: 2 })];
    const visible = (groups: ReviewGroupId[]) => visibleBlocksForReviewer(COMPILED, { units: assignmentsOf(whole, wholeRows) }, groups);
    expect(visible([GROUP_A])).toBeNull();
    expect(visible([GROUP_A, GROUP_B])).not.toBeNull();
  });

  it('still redacts a checker after their unit was given to another group: the response keeps the group it was opened with', () => {
    // Today's settings give u_a to group C; the response's own rows still say group A.
    const moved = settings(assignment('u_a', GROUP_C), assignment('u_b', GROUP_B, { order: 2 }));
    // Settings alone would show group A's member the whole response.
    expect(visibleBlocksForReviewer(COMPILED, { units: moved.units }, [GROUP_A])).toBeNull();
    // With the rows they are still a checker of u_a, redacted, and still see it to decide it.
    expect(keysFor(moved, [GROUP_A])).toEqual(['email', 'free', 'name']);
  });

  it('redacts a checker of a form whose settings were never saved or are off, from the rows alone', () => {
    expect(keysFor(null, [GROUP_A])).toEqual(['email', 'free', 'name']);
    expect(keysFor({ ...live, enabled: false }, [GROUP_B])).toEqual(['free', 'note']);
  });

  it('lists today’s assignments first and then the copies on the rows', () => {
    const merged = assignmentsOf(settings(assignment('u_a', GROUP_C)), rows);
    expect(merged.map((a) => [a.unitId, a.groupId])).toEqual([
      ['u_a', GROUP_C],
      ['u_a', GROUP_A],
      ['u_b', GROUP_B],
    ]);
    expect(merged.at(-1)).toMatchObject({ order: 2, required: true, visibility: 'own_unit' });
  });
});

describe('the queue’s cursor', () => {
  const secret = new Uint8Array(32).fill(7);
  const SUBMISSION = '0190c000-0000-7000-8000-000000000001';
  const scope = queueScope('org-1', ME, {});

  it('says what the age filter means: responses at least that many hours old', () => {
    expect(QUEUE_AGES).toEqual({ '1d': 24, '3d': 72, '7d': 168, '30d': 720 });
  });

  it('is bound to the org, the caller and every filter', () => {
    const all = [scope, queueScope('org-2', ME, {}), queueScope('org-1', OTHER, {}), queueScope('org-1', ME, { formId: SUBMISSION }), queueScope('org-1', ME, { unitId: 'u_a' }), queueScope('org-1', ME, { age: '1d' })];
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives back the position it was signed with', () => {
    const at = '2026-11-15T10:00:00.000Z';
    expect(positionOf(secret, scope, signCursor(secret, scope, [at, SUBMISSION, 'u_a']))).toEqual({ receivedAt: at, submissionId: SUBMISSION, unitId: 'u_a' });
  });

  it('refuses a cursor of another list, a forged one, and one that is not shaped like a position', () => {
    const at = '2026-11-15T10:00:00.000Z';
    const other = queueScope('org-1', OTHER, {});
    expect(() => positionOf(secret, scope, signCursor(secret, other, [at, SUBMISSION, 'u_a']))).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => positionOf(secret, scope, 'c1.e30.AAAA')).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    for (const values of [[at, SUBMISSION], [at, SUBMISSION, 'u_a', 1], ['yesterday', SUBMISSION, 'u_a'], ['2026-11-15', SUBMISSION, 'u_a'], [at, 'not-a-uuid', 'u_a'], [at, SUBMISSION, ''], [at, SUBMISSION, 'u'.repeat(65)], [at, SUBMISSION, 7]]) {
      expect(() => positionOf(secret, scope, signCursor(secret, scope, values)), JSON.stringify(values)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    }
  });
});

describe('the token of a unit’s answers hash', () => {
  const SECRET = new Uint8Array(32).fill(9);
  const SCOPE: AnswersTokenScope = { orgId: '0190c000-0000-7000-8000-000000000001', submissionId: '0190d000-0000-7000-8000-000000000001', unitId: 'u_applicant', round: 1 };
  const RAW = new Uint8Array(32).fill(0xab);
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('is 64 hex digits and is not the digest it stands for', () => {
    const token = answersHashToken(SECRET, SCOPE, RAW);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(hex(RAW));
    // Stable for the same answers, so a checker's read and a later decision agree.
    expect(answersHashToken(SECRET, SCOPE, RAW)).toBe(token);
  });

  it('depends on the key, the org, the response, the unit, the round and the digest', () => {
    const base = answersHashToken(SECRET, SCOPE, RAW);
    const others = [
      answersHashToken(new Uint8Array(32).fill(8), SCOPE, RAW),
      answersHashToken(SECRET, { ...SCOPE, orgId: '0190c000-0000-7000-8000-000000000002' }, RAW),
      answersHashToken(SECRET, { ...SCOPE, submissionId: '0190d000-0000-7000-8000-000000000002' }, RAW),
      answersHashToken(SECRET, { ...SCOPE, unitId: 'u_notes' }, RAW),
      answersHashToken(SECRET, { ...SCOPE, round: 2 }, RAW),
      answersHashToken(SECRET, SCOPE, new Uint8Array(32).fill(0xac)),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  it('does not confuse two units whose ids run into the next field', () => {
    const a = answersHashToken(SECRET, { ...SCOPE, unitId: 'u1', round: 12 }, RAW);
    const b = answersHashToken(SECRET, { ...SCOPE, unitId: 'u11', round: 2 }, RAW);
    expect(a).not.toBe(b);
  });

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => answersHashToken(SECRET, SCOPE, new Uint8Array(31))).toThrow(TypeError);
  });

  it('gives back the digest of the candidate it was made for, in either case of hex, and nothing for any other value', () => {
    const token = answersHashToken(SECRET, SCOPE, RAW);
    const other = new Uint8Array(32).fill(1);
    expect(rawHashOfToken(SECRET, SCOPE, token, [other, RAW])).toEqual(RAW);
    expect(rawHashOfToken(SECRET, SCOPE, token.toUpperCase(), [RAW])).toEqual(RAW);
    // The digest itself is not a token; nor is a token for another scope, key or digest, or one that is edited, short or not hex.
    expect(rawHashOfToken(SECRET, SCOPE, hex(RAW), [RAW])).toBeNull();
    expect(rawHashOfToken(SECRET, { ...SCOPE, unitId: 'u_notes' }, token, [RAW])).toBeNull();
    expect(rawHashOfToken(SECRET, { ...SCOPE, round: 2 }, token, [RAW])).toBeNull();
    expect(rawHashOfToken(new Uint8Array(32).fill(8), SCOPE, token, [RAW])).toBeNull();
    expect(rawHashOfToken(SECRET, SCOPE, token, [other])).toBeNull();
    expect(rawHashOfToken(SECRET, SCOPE, token, [])).toBeNull();
    expect(rawHashOfToken(SECRET, SCOPE, `${token.slice(0, 63)}${token.endsWith('0') ? '1' : '0'}`, [RAW])).toBeNull();
    for (const bad of ['', token.slice(0, 62), `${token}00`, 'zz'.repeat(32)]) expect(rawHashOfToken(SECRET, SCOPE, bad, [RAW]), bad).toBeNull();
  });

  it('makes a hash that is nobody’s: 32 bytes, and never the same twice', () => {
    const a = unmatchableHash();
    expect(a.byteLength).toBe(32);
    expect(hex(a)).not.toBe(hex(unmatchableHash()));
  });
});
