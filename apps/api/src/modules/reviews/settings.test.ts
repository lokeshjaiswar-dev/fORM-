import { describe, expect, it } from 'vitest';
import { ReviewSettingsSchema, type ReviewGroupId, type ReviewSettings } from '@form/schema';
import { ProblemError } from '../../errors.ts';
import { assignmentIssues, changedKeys, expectedRev, REVIEW_DEFAULTS, reviewUnitIdsOf, viewOf } from './settings.ts';

const G1 = '0190a000-0000-7000-8000-000000000001' as ReviewGroupId;
const G2 = '0190a000-0000-7000-8000-000000000002' as ReviewGroupId;
const unit = (unitId: string, o: Partial<ReviewSettings['units'][number]> = {}) =>
  ({ unitId, groupId: G1, order: 1, required: true, visibility: 'own_unit', ...o }) as ReviewSettings['units'][number];
const settings = (o: Partial<ReviewSettings> = {}): ReviewSettings => ({ enabled: true, distinctCheckers: false, units: [unit('u1'), unit('u2', { groupId: G2, order: 2 })], ...o });

describe('If-Match', () => {
  it('reads the revision from 3, "3" and W/"3"', () => {
    expect(expectedRev('3')).toBe(3);
    expect(expectedRev('"3"')).toBe(3);
    expect(expectedRev('W/"3"')).toBe(3);
    expect(expectedRev(' 0 ')).toBe(0);
  });

  it('refuses a missing or malformed header with the problem that asks for it (428)', () => {
    for (const header of [undefined, '', 'latest', '-1', '1.5', '1234567890', ['1']]) {
      let thrown: unknown;
      try {
        expectedRev(header);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, String(header)).toBeInstanceOf(ProblemError);
      expect((thrown as ProblemError).code).toBe('REVIEW_SETTINGS_REV_REQUIRED');
    }
  });
});

describe('the review units a definition names', () => {
  it('lists the ids of review.units, also of a draft that is half edited', () => {
    expect(reviewUnitIdsOf({ units: [{ id: 'u1', name: 'Page 1', target: { kind: 'page', pageId: 'p1' } }, { id: 'u2' }] })).toEqual(['u1', 'u2']);
  });

  it('ignores everything that is not a unit with a string id', () => {
    for (const review of [undefined, null, 'x', 7, {}, { units: 'u1' }, { units: [null, 1, {}, { id: 4 }, { id: null }] }]) expect(reviewUnitIdsOf(review), JSON.stringify(review)).toEqual([]);
  });
});

describe('assignmentIssues', () => {
  const known = new Set(['u1', 'u2']);
  const groups = new Set([G1, G2]);

  it('finds none for units of the form with groups of the org', () => {
    expect(assignmentIssues(settings().units, { known, groups })).toEqual([]);
    expect(assignmentIssues([], { known: new Set(), groups: new Set() })).toEqual([]);
  });

  it('names the unit the form does not have, at its place in the body', () => {
    expect(assignmentIssues([unit('u1'), unit('ghost')], { known, groups })).toEqual([{ path: 'body/units/1/unitId', message: expect.stringContaining('no review unit') }]);
  });

  it('names a group that is not among the org’s unarchived groups: a group of another org reads the same as one that never existed', () => {
    const other = '0190a000-0000-7000-8000-0000000000ff' as ReviewGroupId;
    const issues = assignmentIssues([unit('u1', { groupId: other })], { known, groups });
    expect(issues).toEqual([{ path: 'body/units/0/groupId', message: 'no such review group in this org, or it is archived' }]);
  });

  it('refuses a unit assigned twice, at the second place', () => {
    expect(assignmentIssues([unit('u1'), unit('u1', { order: 2 })], { known, groups })).toEqual([{ path: 'body/units/1/unitId', message: 'this unit is assigned more than once' }]);
  });

  it('reports every problem of a body, not the first', () => {
    const issues = assignmentIssues([unit('ghost', { groupId: 'nope' as never }), unit('u1')], { known, groups });
    expect(issues.map((i) => i.path)).toEqual(['body/units/0/unitId', 'body/units/0/groupId']);
  });
});

describe('the strict twin the route parses a save with', () => {
  it('refuses an order below 1, a visibility it does not know, a stray key and a missing flag', () => {
    expect(ReviewSettingsSchema.safeParse(settings()).success).toBe(true);
    expect(ReviewSettingsSchema.safeParse(settings({ units: [unit('u1', { order: 0 })] })).success).toBe(false);
    expect(ReviewSettingsSchema.safeParse(settings({ units: [unit('u1', { visibility: 'everything' as never })] })).success).toBe(false);
    expect(ReviewSettingsSchema.safeParse({ ...settings(), extra: true }).success).toBe(false);
    expect(ReviewSettingsSchema.safeParse({ enabled: true, units: [] }).success).toBe(false);
    expect(ReviewSettingsSchema.safeParse(settings({ units: [{ ...unit('u1'), note: 'x' } as never] })).success).toBe(false);
  });
});

describe('changedKeys', () => {
  it('is empty for the same settings, also with the units in another order', () => {
    expect(changedKeys(settings(), settings())).toEqual([]);
    expect(changedKeys(settings(), settings({ units: [...settings().units].reverse() }))).toEqual([]);
  });

  it('names the top-level key that differs, in a fixed order', () => {
    expect(changedKeys(settings(), settings({ enabled: false }))).toEqual(['enabled']);
    expect(changedKeys(settings(), settings({ distinctCheckers: true }))).toEqual(['distinctCheckers']);
    expect(changedKeys(settings(), settings({ units: [unit('u1'), unit('u2', { groupId: G2, order: 3 })] }))).toEqual(['units']);
    expect(changedKeys(settings(), settings({ units: [unit('u1', { required: false }), unit('u2', { groupId: G2, order: 2 })] }))).toEqual(['units']);
    expect(changedKeys(settings(), settings({ enabled: false, distinctCheckers: true, units: [] }))).toEqual(['enabled', 'distinctCheckers', 'units']);
  });

  it('counts a form that was never set up as off with no units', () => {
    expect(changedKeys(REVIEW_DEFAULTS, settings({ enabled: false, units: [] }))).toEqual([]);
    expect(changedKeys(REVIEW_DEFAULTS, settings())).toEqual(['enabled', 'units']);
  });
});

describe('the stored row as a view', () => {
  it('reads the settings back with the column’s enabled flag and the row’s revision', () => {
    const stored = { enabled: true, distinctCheckers: true, units: [unit('u1')] };
    expect(viewOf({ rev: 4, enabled: true, settings: stored })).toEqual({ rev: 4, ...stored });
    expect(viewOf({ rev: 5, enabled: false, settings: stored })).toEqual({ rev: 5, ...stored, enabled: false });
  });

  it('fails loudly on a row that is not a ReviewSettings, instead of reading it as "not reviewed"', () => {
    expect(() => viewOf({ rev: 1, enabled: true, settings: {} })).toThrow(/not a valid ReviewSettings/);
    expect(() => viewOf({ rev: 1, enabled: true, settings: { distinctCheckers: false, units: [{ unitId: 'u1' }] } })).toThrow();
  });
});
