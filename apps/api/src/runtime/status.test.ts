import { describe, expect, it } from 'vitest';
import type { RichDoc } from '@form/schema';
import { runtimeStatus, type AccessCounters, type AccessRules } from './status.ts';

/** Every case passes its own instant: the clock is frozen by construction, and no test reads the real one. */
const at = (iso: string) => new Date(iso);

const OPEN: AccessRules = { enabled: true, openAt: null, closeAt: null, availability: null, submissionLimit: null, hasPassword: false, screens: {} };
const NONE: AccessCounters = { submittedTotal: 0 };
const EMPTY: RichDoc = { type: 'doc', content: [] };
const doc = (text: string): RichDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const MONDAY_NOON = at('2026-11-16T12:00:00Z');

describe('runtimeStatus: switched off and dates (ACC-01..03)', () => {
  it('is open for a form with no rules', () => {
    expect(runtimeStatus(OPEN, NONE, MONDAY_NOON)).toEqual({ state: 'open' });
  });

  it('is closed when disabled, with the author’s screen or an empty one', () => {
    expect(runtimeStatus({ ...OPEN, enabled: false }, NONE, MONDAY_NOON)).toEqual({ state: 'closed', screen: EMPTY });
    const custom = { ...OPEN, enabled: false, screens: { closed: { content: doc('See you next year') } } };
    expect(runtimeStatus(custom, NONE, MONDAY_NOON)).toEqual({ state: 'closed', screen: doc('See you next year') });
  });

  it('is not yet open before the open date, and says when it opens', () => {
    const rules = { ...OPEN, openAt: at('2026-11-17T09:00:00Z'), screens: { not_yet_open: { content: doc('Opens tomorrow') } } };
    expect(runtimeStatus(rules, NONE, MONDAY_NOON)).toEqual({ state: 'not_yet_open', opensAt: '2026-11-17T09:00:00.000Z', screen: doc('Opens tomorrow') });
  });

  it('opens at the open instant and closes at the close instant, to the millisecond', () => {
    const rules = { ...OPEN, openAt: at('2026-11-16T12:00:00.000Z'), closeAt: at('2026-11-16T13:00:00.000Z') };
    expect(runtimeStatus(rules, NONE, at('2026-11-16T11:59:59.999Z')).state).toBe('not_yet_open');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T12:00:00.000Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T12:59:59.999Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T13:00:00.000Z')).state).toBe('closed');
  });

  it('is closed after the close date', () => {
    const rules = { ...OPEN, closeAt: at('2026-11-15T18:29:59Z') };
    expect(runtimeStatus(rules, NONE, MONDAY_NOON)).toEqual({ state: 'closed', screen: EMPTY });
  });

  it('compares instants in UTC, whatever offset the author wrote them with', () => {
    // 2026-11-17T05:00:00+05:30 is 2026-11-16T23:30:00Z.
    const rules = { ...OPEN, closeAt: new Date('2026-11-17T05:00:00+05:30') };
    expect(runtimeStatus(rules, NONE, at('2026-11-16T23:29:59Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T23:30:00Z')).state).toBe('closed');
  });
});

describe('runtimeStatus: the limit (ACC-04)', () => {
  const limited = { ...OPEN, submissionLimit: 10, screens: { limit_reached: { content: doc('Full') } } };

  it('is open until the counter reaches the limit, then limit_reached', () => {
    expect(runtimeStatus(limited, { submittedTotal: 9 }, MONDAY_NOON)).toEqual({ state: 'open' });
    expect(runtimeStatus(limited, { submittedTotal: 10 }, MONDAY_NOON)).toEqual({ state: 'limit_reached', screen: doc('Full') });
    expect(runtimeStatus(limited, { submittedTotal: 11 }, MONDAY_NOON).state).toBe('limit_reached');
  });

  it('closes at whichever of the date or the limit comes first: the limit before the close date', () => {
    const both = { ...limited, closeAt: at('2026-12-01T00:00:00Z') };
    expect(runtimeStatus(both, { submittedTotal: 10 }, MONDAY_NOON).state).toBe('limit_reached');
    expect(runtimeStatus(both, { submittedTotal: 3 }, MONDAY_NOON).state).toBe('open');
  });

  it('closes at whichever of the date or the limit comes first: the date before the limit', () => {
    const both = { ...limited, closeAt: at('2026-11-16T11:00:00Z') };
    expect(runtimeStatus(both, { submittedTotal: 3 }, MONDAY_NOON).state).toBe('closed');
  });

  it('answers closed once the date has passed even if the counter is also full (the date is the part that is knowable)', () => {
    const both = { ...limited, closeAt: at('2026-11-16T11:00:00Z') };
    expect(runtimeStatus(both, { submittedTotal: 10 }, MONDAY_NOON).state).toBe('closed');
  });

  it('does not count a limit of none', () => {
    expect(runtimeStatus(OPEN, { submittedTotal: 1_000_000 }, MONDAY_NOON)).toEqual({ state: 'open' });
  });
});

describe('runtimeStatus: the password (ACC-05)', () => {
  const protectedForm = { ...OPEN, hasPassword: true, screens: { password: { content: doc('Ask the organiser') } } };

  it('asks for the password until the caller holds a valid access token', () => {
    expect(runtimeStatus(protectedForm, NONE, MONDAY_NOON)).toEqual({ state: 'password', screen: doc('Ask the organiser') });
    expect(runtimeStatus(protectedForm, NONE, MONDAY_NOON, { unlocked: false }).state).toBe('password');
    expect(runtimeStatus(protectedForm, NONE, MONDAY_NOON, { unlocked: true })).toEqual({ state: 'open' });
  });

  it('never asks for a password on a form that is closed, not yet open or full', () => {
    expect(runtimeStatus({ ...protectedForm, enabled: false }, NONE, MONDAY_NOON).state).toBe('closed');
    expect(runtimeStatus({ ...protectedForm, openAt: at('2026-11-20T00:00:00Z') }, NONE, MONDAY_NOON).state).toBe('not_yet_open');
    expect(runtimeStatus({ ...protectedForm, submissionLimit: 1 }, { submittedTotal: 1 }, MONDAY_NOON).state).toBe('limit_reached');
  });

  it('holds a form that is outside its hours to the hours first', () => {
    const rules: AccessRules = { ...protectedForm, availability: { timeZone: 'UTC', windows: [{ weekdays: [2], from: '09:00', to: '17:00' }] } };
    expect(runtimeStatus(rules, NONE, MONDAY_NOON).state).toBe('outside_hours');
    expect(runtimeStatus(rules, NONE, at('2026-11-17T12:00:00Z')).state).toBe('password');
  });
});

describe('runtimeStatus: weekly windows in their own time zone (ACC-06)', () => {
  const kolkata = (windows: NonNullable<AccessRules['availability']>['windows']): AccessRules => ({
    ...OPEN,
    availability: { timeZone: 'Asia/Kolkata', windows },
  });

  it('opens a Monday to Friday 09:00 to 18:00 window at 03:30 UTC and closes it at 12:30 UTC', () => {
    const rules = kolkata([{ weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }]);
    expect(runtimeStatus(rules, NONE, at('2026-11-16T03:29:59Z')).state).toBe('outside_hours');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T03:30:00Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T12:29:59Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-16T12:30:00Z')).state).toBe('outside_hours');
  });

  it('uses the local weekday across UTC midnight: Tuesday 01:30 in Kolkata is still Monday in UTC', () => {
    const tuesdayEarly = kolkata([{ weekdays: [2], from: '01:00', to: '03:00' }]);
    // 2026-11-16T20:00Z is Monday 20:00 UTC and Tuesday 01:30 IST.
    expect(runtimeStatus(tuesdayEarly, NONE, at('2026-11-16T20:00:00Z')).state).toBe('open');
    expect(runtimeStatus(tuesdayEarly, NONE, at('2026-11-16T19:29:59Z')).state).toBe('outside_hours');
    expect(runtimeStatus(tuesdayEarly, NONE, at('2026-11-16T21:30:00Z')).state).toBe('outside_hours');
    // The same wall-clock hour on the UTC Tuesday is Tuesday 06:30 IST, outside.
    expect(runtimeStatus(tuesdayEarly, NONE, at('2026-11-17T01:00:00Z')).state).toBe('outside_hours');
  });

  it('says when the next window opens, as an instant', () => {
    const rules = kolkata([{ weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }]);
    expect(runtimeStatus(rules, NONE, at('2026-11-16T03:29:59Z'))).toEqual({ state: 'outside_hours', nextOpenAt: '2026-11-16T03:30:00.000Z', screen: EMPTY });
    // Saturday evening in Kolkata: the next opening is Monday 09:00 IST.
    expect(runtimeStatus(rules, NONE, at('2026-11-21T14:00:00Z'))).toMatchObject({ state: 'outside_hours', nextOpenAt: '2026-11-23T03:30:00.000Z' });
    // After Friday's window closes, too.
    expect(runtimeStatus(rules, NONE, at('2026-11-20T13:00:00Z'))).toMatchObject({ nextOpenAt: '2026-11-23T03:30:00.000Z' });
  });

  it('leaves nextOpenAt out when the next window opens after the form closes', () => {
    const rules = { ...kolkata([{ weekdays: [1], from: '09:00', to: '18:00' }]), closeAt: at('2026-11-20T00:00:00Z') };
    const status = runtimeStatus(rules, NONE, at('2026-11-16T13:00:00Z'));
    expect(status).toEqual({ state: 'outside_hours', screen: EMPTY });
  });

  it('runs a window whose end is before its start over midnight, on the day it starts', () => {
    const rules: AccessRules = { ...OPEN, availability: { timeZone: 'UTC', windows: [{ weekdays: [5], from: '22:00', to: '02:00' }] } };
    // Friday is 2026-11-20.
    expect(runtimeStatus(rules, NONE, at('2026-11-20T21:59:59Z')).state).toBe('outside_hours');
    expect(runtimeStatus(rules, NONE, at('2026-11-20T22:00:00Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-21T01:59:59Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-21T02:00:00Z')).state).toBe('outside_hours');
    // Thursday night into Friday morning is not part of a Friday window.
    expect(runtimeStatus(rules, NONE, at('2026-11-20T01:00:00Z')).state).toBe('outside_hours');
  });

  it('runs a window that ends at 23:59 to the end of the day', () => {
    const rules: AccessRules = { ...OPEN, availability: { timeZone: 'UTC', windows: [{ weekdays: [1], from: '00:00', to: '23:59' }] } };
    expect(runtimeStatus(rules, NONE, at('2026-11-16T23:59:30Z')).state).toBe('open');
    expect(runtimeStatus(rules, NONE, at('2026-11-17T00:00:00Z')).state).toBe('outside_hours');
  });

  it('follows the clock change of the zone (New York, summer time ended on 2026-11-01)', () => {
    const rules: AccessRules = { ...OPEN, availability: { timeZone: 'America/New_York', windows: [{ weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] } };
    // Friday 2026-10-30, still EDT (UTC-4): 09:00 is 13:00Z.
    expect(runtimeStatus(rules, NONE, at('2026-10-30T12:59:59Z')).state).toBe('outside_hours');
    expect(runtimeStatus(rules, NONE, at('2026-10-30T13:00:00Z')).state).toBe('open');
    // Monday 2026-11-02, EST (UTC-5): 09:00 is 14:00Z.
    expect(runtimeStatus(rules, NONE, at('2026-11-02T13:59:59Z')).state).toBe('outside_hours');
    expect(runtimeStatus(rules, NONE, at('2026-11-02T14:00:00Z')).state).toBe('open');
    // From Friday evening, the next opening is Monday 09:00 EST.
    expect(runtimeStatus(rules, NONE, at('2026-10-30T22:00:00Z'))).toMatchObject({ state: 'outside_hours', nextOpenAt: '2026-11-02T14:00:00.000Z' });
  });

  it('is closed, not open and not an error, for a zone Intl does not know', () => {
    const rules: AccessRules = { ...OPEN, availability: { timeZone: 'Mars/Olympus_Mons', windows: [{ weekdays: [1], from: '09:00', to: '17:00' }] } };
    expect(runtimeStatus(rules, NONE, MONDAY_NOON)).toEqual({ state: 'closed', screen: EMPTY });
  });
});
