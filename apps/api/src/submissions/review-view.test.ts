import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@form/db';
import type { BlockId, ReviewSettings } from '@form/schema';
import { createRedactionLoader, mayShow, reviewerViewOf, reviewOf, reviewSummaries, SEES_ALL, type ReviewerView } from './review-view.ts';

const FORM = '0190f5a2-7c1e-7a00-8000-000000000001';
const USER = '0190f5a2-7c1e-7a00-8000-000000000002';
const G1 = '0190f5a2-7c1e-7a00-8000-0000000000a1';
const G2 = '0190f5a2-7c1e-7a00-8000-0000000000a2';
const ORG = '0190f5a2-7c1e-7a00-8000-0000000000b1';
const V1 = '0190f5a2-7c1e-7a00-8000-0000000000c1';
const V2 = '0190f5a2-7c1e-7a00-8000-0000000000c2';

const units = (...rows: Array<[unit: string, group: string, visibility: 'own_unit' | 'whole_submission']>) =>
  rows.map(([unitId, groupId, visibility], i) => ({ unitId, groupId, order: i + 1, required: true, visibility }));

/** A transaction whose `execute` answers the two reads of `reviewerScope` in order: the settings row, then the caller's groups. */
function scopeTx(settings: { enabled: boolean; settings: unknown } | null, groups: string[]): { tx: Tx; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  execute.mockResolvedValueOnce({ rows: settings ? [settings] : [] });
  execute.mockResolvedValueOnce({ rows: groups.map((group_id) => ({ group_id })) });
  return { tx: { execute } as unknown as Tx, execute };
}

describe('reviewerViewOf', () => {
  const stored = (...u: Parameters<typeof units>) => ({ enabled: true, settings: { distinctCheckers: false, units: units(...u) } });

  it('is not redacted, and reads nothing, for a caller with no user id', async () => {
    const { tx, execute } = scopeTx(stored(['u_a', G1, 'own_unit']), [G1]);
    expect(await reviewerViewOf(tx, {}, FORM)).toEqual({ settings: null, groupIds: [], redacted: false });
    expect(await reviewerViewOf(tx, { userId: null }, FORM)).toMatchObject({ redacted: false });
    expect(await reviewerViewOf(tx, { userId: 'not-a-uuid' }, FORM)).toMatchObject({ redacted: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('is not redacted for a form with no review settings, after one read', async () => {
    const { tx, execute } = scopeTx(null, []);
    expect(await reviewerViewOf(tx, { userId: USER }, FORM)).toEqual({ settings: null, groupIds: [], redacted: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('is not redacted for a member of no group the settings assign a unit to', async () => {
    const { tx } = scopeTx(stored(['u_a', G1, 'own_unit']), []);
    expect(await reviewerViewOf(tx, { userId: USER }, FORM)).toMatchObject({ groupIds: [], redacted: false });
  });

  it('is redacted for a member of a group with an own_unit unit, and not for one whose groups are all whole_submission', async () => {
    const own = scopeTx(stored(['u_a', G1, 'own_unit'], ['u_b', G2, 'whole_submission']), [G1]);
    expect(await reviewerViewOf(own.tx, { userId: USER }, FORM)).toMatchObject({ groupIds: [G1], redacted: true });
    const whole = scopeTx(stored(['u_a', G1, 'own_unit'], ['u_b', G2, 'whole_submission']), [G2]);
    expect(await reviewerViewOf(whole.tx, { userId: USER }, FORM)).toMatchObject({ groupIds: [G2], redacted: false });
    // Both kinds: own_unit wins.
    const both = scopeTx(stored(['u_a', G1, 'own_unit'], ['u_b', G2, 'whole_submission']), [G1, G2]);
    expect(await reviewerViewOf(both.tx, { userId: USER }, FORM)).toMatchObject({ redacted: true });
  });

  it('fails closed when the settings do not parse: it throws, it does not show the whole response', async () => {
    const { tx } = scopeTx({ enabled: true, settings: { units: 'nonsense' } }, []);
    await expect(reviewerViewOf(tx, { userId: USER }, FORM)).rejects.toThrow(/review settings of form/);
  });
});

describe('mayShow', () => {
  it('shows everything when nothing is hidden, and only the listed blocks otherwise', () => {
    expect(mayShow(null, 'anything')).toBe(true);
    const set = new Set(['a' as BlockId]);
    expect(mayShow(set, 'a')).toBe(true);
    expect(mayShow(set, 'b')).toBe(false);
    expect(mayShow(new Set(), 'a')).toBe(false);
  });
});

describe('reviewOf', () => {
  it('is the review key for a response that was held and no key at all for any other', () => {
    const summaries = new Map([['held', [{ name: 'Applicant', state: 'pending' as const }]]]);
    expect(reviewOf(summaries, 'held')).toEqual({ review: [{ name: 'Applicant', state: 'pending' }] });
    expect(reviewOf(summaries, 'other')).toEqual({});
    expect(Object.keys({ id: 'x', ...reviewOf(summaries, 'other') })).toEqual(['id']);
  });
});

describe('the redaction loader', () => {
  const settings: ReviewSettings = { enabled: true, distinctCheckers: false, units: units(['u_a', G1, 'own_unit'], ['u_b', G2, 'own_unit']) as ReviewSettings['units'] };
  const redacted: ReviewerView = { settings, groupIds: [G1], redacted: true };
  const compiled = { documentOrder: ['a', 'b'], reviewUnits: { u_a: ['a'], u_b: ['b'] }, plan: [], reads: {} };

  /** A transaction whose version read answers with `rows`, and counts how often it is asked. */
  function versionTx(rows: Array<{ id: string; scoping: unknown }>): { tx: Tx; where: ReturnType<typeof vi.fn> } {
    const where = vi.fn().mockResolvedValue(rows);
    const tx = { select: () => ({ from: () => ({ where }) }) } as unknown as Tx;
    return { tx, where };
  }

  it('gives a caller who is not redacted everything, without a read', async () => {
    const { tx, where } = versionTx([]);
    const loader = createRedactionLoader();
    const seen = await loader.visibility(tx, { settings: null, groupIds: [], redacted: false }, [V1]);
    expect(seen).toBe(SEES_ALL);
    expect(seen.of(V1)).toBeNull();
    expect(where).not.toHaveBeenCalled();
  });

  it('gives a redacted caller the blocks of their units for each version, and nothing for a version it cannot scope', async () => {
    const { tx } = versionTx([
      { id: V1, scoping: compiled },
      // A legacy stand-in version has `compiled` '{}': the keys come back null, there is no plan to read.
      { id: V2, scoping: { documentOrder: null, reviewUnits: null, plan: null, reads: null } },
    ]);
    const seen = await createRedactionLoader().visibility(tx, redacted, [V1, V2, V1]);
    expect([...seen.of(V1)!]).toEqual(['a']);
    expect([...seen.of(V2)!]).toEqual([]);
    // A version that was never loaded (not one the caller can read) shows nothing, not everything.
    expect([...seen.of('0190f5a2-7c1e-7a00-8000-0000000000ff')!]).toEqual([]);
  });

  it('reads a version once, and a second request for it from the cache', async () => {
    const { tx, where } = versionTx([{ id: V1, scoping: compiled }]);
    const loader = createRedactionLoader();
    await loader.visibility(tx, redacted, [V1]);
    const again = await loader.visibility(tx, redacted, [V1]);
    expect(where).toHaveBeenCalledTimes(1);
    expect([...again.of(V1)!]).toEqual(['a']);
  });

  it('hides a value worked out from a hidden block, wherever it sits', async () => {
    // total = b * 2 sits in unit A but is derived from unit B's block: a unit-A checker must not read it.
    const derived = {
      documentOrder: ['a', 'b', 'total'],
      reviewUnits: { u_a: ['a', 'total'], u_b: ['b'] },
      plan: [{ kind: 'calc', blockId: 'total' }],
      reads: { 'calc:total': ['value:b'] },
    };
    const { tx } = versionTx([{ id: V1, scoping: derived }]);
    const seen = await createRedactionLoader().visibility(tx, redacted, [V1]);
    expect([...seen.of(V1)!]).toEqual(['a']);
  });
});

describe('reviewSummaries', () => {
  const at = new Date('2026-11-10T08:00:00.000Z');
  const rows = [
    { id: 'sub-1', receivedAt: at, formVersionId: V1 },
    { id: 'sub-2', receivedAt: at, formVersionId: V1 },
  ];

  /** A transaction whose first read answers the review rows and its second the versions' units. */
  function summaryTx(reviews: unknown[], versions: unknown[]): { tx: Tx; select: ReturnType<typeof vi.fn> } {
    const where = vi.fn().mockResolvedValueOnce(reviews).mockResolvedValueOnce(versions);
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    return { tx: { select } as unknown as Tx, select };
  }

  it('reads nothing for a form with no review settings, and for a page with no rows', async () => {
    const none = summaryTx([], []);
    expect((await reviewSummaries(none.tx, { settings: null }, ORG, FORM, rows)).size).toBe(0);
    const settings: ReviewSettings = { enabled: true, distinctCheckers: false, units: [] };
    expect((await reviewSummaries(none.tx, { settings }, ORG, FORM, [])).size).toBe(0);
    expect(none.select).not.toHaveBeenCalled();
  });

  it('leaves out a response that was never held, and reads the names only when something was', async () => {
    const settings: ReviewSettings = { enabled: true, distinctCheckers: false, units: [] };
    const { tx, select } = summaryTx([], []);
    expect((await reviewSummaries(tx, { settings }, ORG, FORM, rows)).size).toBe(0);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('gives each unit its name from the response version, in the order of that version, with the state and nothing else', async () => {
    const settings: ReviewSettings = { enabled: true, distinctCheckers: false, units: [] };
    const { tx } = summaryTx(
      [
        { submissionId: 'sub-1', unitId: 'u_notes', state: 'approved', order: 2 },
        { submissionId: 'sub-1', unitId: 'u_applicant', state: 'pending', order: 1 },
        { submissionId: 'sub-2', unitId: 'u_notes', state: 'closed', order: 2 },
        { submissionId: 'sub-2', unitId: 'u_gone', state: 'rejected', order: 1 },
      ],
      [
        {
          id: V1,
          units: [
            { id: 'u_applicant', name: 'Applicant' },
            // A name is plain text: whatever is not text in a template is left out, and a control character is made safe.
            { id: 'u_notes', name: ['Notes ', { var: { name: 'org.name' } }, 'for\u0007 staff'] },
          ],
        },
      ],
    );
    const out = await reviewSummaries(tx, { settings }, ORG, FORM, rows);
    expect(out.get('sub-1')).toEqual([
      { name: 'Applicant', state: 'pending' },
      { name: 'Notes for  staff', state: 'approved' },
    ]);
    // A unit the version does not name goes last, shown by its id; the two keys are all there is.
    expect(out.get('sub-2')).toEqual([
      { name: 'Notes for  staff', state: 'closed' },
      { name: 'u_gone', state: 'rejected' },
    ]);
    for (const list of out.values()) for (const u of list) expect(Object.keys(u).sort()).toEqual(['name', 'state']);
  });

  it('clips a very long unit name', async () => {
    const settings: ReviewSettings = { enabled: true, distinctCheckers: false, units: [] };
    const { tx } = summaryTx([{ submissionId: 'sub-1', unitId: 'u_a', state: 'pending', order: 1 }], [{ id: V1, units: [{ id: 'u_a', name: 'x'.repeat(500) }] }]);
    const out = await reviewSummaries(tx, { settings }, ORG, FORM, rows.slice(0, 1));
    expect(out.get('sub-1')![0]!.name).toHaveLength(200);
  });
});
