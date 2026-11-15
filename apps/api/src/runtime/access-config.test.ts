import { describe, expect, it } from 'vitest';
import { ACCESS_DEFAULTS, AccessBody, changedKeys, isHostname, isHttpsOrigin, isIanaTimeZone, settingsOfInput, viewOf } from './access-config.ts';

const base = { enabled: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };

/** The paths of the issues a body raises (`/availability/timeZone`), which is what the 400 answer lists. */
function paths(body: unknown): string[] {
  const parsed = AccessBody.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((i) => `/${i.path.join('/')}`);
}

describe('the body of PUT access', () => {
  it('accepts the defaults and a fully set body', () => {
    expect(paths(base)).toEqual([]);
    expect(
      paths({
        ...base,
        openAt: '2026-12-01T03:30:00Z',
        closeAt: '2026-12-31T18:29:59.999Z',
        availability: { timeZone: 'Asia/Kolkata', windows: [{ weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] },
        submissionLimit: 500,
        embedAllowlist: ['https://example.com', 'https://forms.example.org:8443'],
        redirectAllowlist: ['example.com', 'thanks.example.org'],
        acceptPreviousVersionsHours: 0,
      }),
    ).toEqual([]);
  });

  it('refuses a time zone that is not an IANA zone', () => {
    expect(paths({ ...base, availability: { timeZone: 'Mars/Olympus_Mons', windows: [{ weekdays: [1], from: '09:00', to: '17:00' }] } })).toEqual(['/availability/timeZone']);
    expect(paths({ ...base, availability: { timeZone: 'IST', windows: [{ weekdays: [1], from: '09:00', to: '17:00' }] } })).toEqual(['/availability/timeZone']);
    expect(isIanaTimeZone('Asia/Kolkata')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Asia/Nowhere')).toBe(false);
  });

  it('refuses a close that is not after the open, and instants that are not ISO instants', () => {
    expect(paths({ ...base, openAt: '2026-12-01T00:00:00Z', closeAt: '2026-11-30T00:00:00Z' })).toEqual(['/closeAt']);
    expect(paths({ ...base, openAt: '2026-12-01T00:00:00Z', closeAt: '2026-12-01T00:00:00Z' })).toEqual(['/closeAt']);
    // The same instant written with an offset the twin does not accept, and a date without a time.
    expect(paths({ ...base, openAt: '2026-12-01T05:30:00+05:30' })).toEqual(['/openAt']);
    expect(paths({ ...base, closeAt: '2026-12-01' })).toEqual(['/closeAt']);
  });

  it('refuses an embed origin that is not an https origin, with the path to the entry', () => {
    expect(paths({ ...base, embedAllowlist: ['http://example.com'] })).toEqual(['/embedAllowlist/0']);
    expect(paths({ ...base, embedAllowlist: ['https://example.com', 'https://example.com/path'] })).toEqual(['/embedAllowlist/1']);
    expect(paths({ ...base, embedAllowlist: ['example.com'] })).toEqual(['/embedAllowlist/0']);
    expect(paths({ ...base, embedAllowlist: ['https://user:pw@example.com'] })).toEqual(['/embedAllowlist/0']);
    expect(paths({ ...base, embedAllowlist: ['https://*.example.com'] })).toEqual(['/embedAllowlist/0']);
    expect(paths({ ...base, embedAllowlist: ['javascript:alert(1)'] })).toEqual(['/embedAllowlist/0']);
    expect(isHttpsOrigin('https://example.com')).toBe(true);
    expect(isHttpsOrigin('https://example.com/')).toBe(false);
    expect(isHttpsOrigin('https://example.com:443')).toBe(false);
  });

  it('keeps redirect entries to host names', () => {
    expect(paths({ ...base, redirectAllowlist: ['https://example.com'] })).toEqual(['/redirectAllowlist/0']);
    expect(paths({ ...base, redirectAllowlist: ['example.com/path'] })).toEqual(['/redirectAllowlist/0']);
    expect(paths({ ...base, redirectAllowlist: ['example.com:8080'] })).toEqual(['/redirectAllowlist/0']);
    expect(paths({ ...base, redirectAllowlist: ['*.example.com'] })).toEqual(['/redirectAllowlist/0']);
    expect(paths({ ...base, redirectAllowlist: [] })).toEqual([]);
    expect(isHostname('a-b.example.co.in')).toBe(true);
    expect(isHostname('-bad.example.com')).toBe(false);
  });

  it('lower-cases and de-duplicates the allowlists', () => {
    const parsed = AccessBody.parse({ ...base, embedAllowlist: ['https://Example.COM', 'https://example.com'], redirectAllowlist: ['Example.com', 'example.com'] });
    expect(settingsOfInput(parsed)).toMatchObject({ embedAllowlist: ['https://example.com'], redirectAllowlist: ['example.com'] });
  });

  it('bounds the limit and the previous-versions window', () => {
    expect(paths({ ...base, submissionLimit: 0 })).toEqual(['/submissionLimit']);
    expect(paths({ ...base, submissionLimit: 1.5 })).toEqual(['/submissionLimit']);
    expect(paths({ ...base, submissionLimit: 1 })).toEqual([]);
    expect(paths({ ...base, acceptPreviousVersionsHours: -1 })).toEqual(['/acceptPreviousVersionsHours']);
    expect(paths({ ...base, acceptPreviousVersionsHours: 721 })).toEqual(['/acceptPreviousVersionsHours']);
    expect(paths({ ...base, acceptPreviousVersionsHours: 720 })).toEqual([]);
  });

  it('checks the windows: at least one, weekdays each once, an end that differs from the start', () => {
    const tz = 'Asia/Kolkata';
    expect(paths({ ...base, availability: { timeZone: tz, windows: [] } })).toEqual(['/availability/windows']);
    expect(paths({ ...base, availability: { timeZone: tz, windows: [{ weekdays: [], from: '09:00', to: '17:00' }] } })).toEqual(['/availability/windows/0/weekdays']);
    expect(paths({ ...base, availability: { timeZone: tz, windows: [{ weekdays: [1, 1], from: '09:00', to: '17:00' }] } })).toEqual(['/availability/windows/0/weekdays']);
    expect(paths({ ...base, availability: { timeZone: tz, windows: [{ weekdays: [1], from: '09:00', to: '09:00' }] } })).toEqual(['/availability/windows/0/to']);
    expect(paths({ ...base, availability: { timeZone: tz, windows: [{ weekdays: [7], from: '09:00', to: '17:00' }] } })).toHaveLength(1);
    expect(paths({ ...base, availability: { timeZone: tz, windows: [{ weekdays: [1], from: '9:00', to: '17:00' }] } })).toHaveLength(1);
  });

  it('refuses a password, a hash and any key the access twin does not have', () => {
    expect(paths({ ...base, password: 'hunter2hunter2' })).toHaveLength(1);
    expect(paths({ ...base, password: { argon2idHash: '$argon2id$v=19$m=65536,t=3,p=1$x$y', updatedAt: '2026-11-16T00:00:00Z' } })).toHaveLength(1);
    expect(paths({ ...base, passwordHash: '$argon2id$x' })).toHaveLength(1);
    expect(paths({ ...base, hasPassword: true })).toHaveLength(1);
    expect(paths({ ...base, rev: 5 })).toHaveLength(1);
    // Settings that have no column yet (ACC-07, ACC-09, P3).
    expect(paths({ ...base, uniqueSubmission: 'off' })).toHaveLength(1);
  });

  it('needs the keys that are not optional', () => {
    expect(paths({ enabled: true })).toEqual(expect.arrayContaining(['/embedAllowlist', '/screens', '/acceptPreviousVersionsHours']));
    expect(paths({})).toContain('/enabled');
  });
});

describe('the settings as stored and as sent', () => {
  it('leave out the keys that are unset, as the access twin does, and never carry a hash', () => {
    const view = viewOf({ ...ACCESS_DEFAULTS, hasPassword: true, passwordUpdatedAt: new Date('2026-11-16T10:00:00Z') });
    expect(view).toEqual({
      rev: 0,
      enabled: true,
      hasPassword: true,
      passwordUpdatedAt: '2026-11-16T10:00:00.000Z',
      embedAllowlist: [],
      screens: {},
      acceptPreviousVersionsHours: 72,
    });
    expect(JSON.stringify(view)).not.toMatch(/hash|argon2/i);
  });

  it('send back what a save accepts, so a client can edit the answer and put it back', () => {
    const next = settingsOfInput(
      AccessBody.parse({
        ...base,
        openAt: '2026-12-01T03:30:00Z',
        availability: { timeZone: 'Asia/Kolkata', windows: [{ weekdays: [5, 1, 3], from: '09:00', to: '18:00' }] },
        submissionLimit: 10,
        redirectAllowlist: ['example.com'],
      }),
    );
    const { rev: _rev, hasPassword: _has, passwordUpdatedAt: _at, ...sent } = viewOf({ ...next, rev: 3, hasPassword: false, passwordUpdatedAt: null });
    expect(next.availability?.windows[0]?.weekdays).toEqual([1, 3, 5]);
    expect(AccessBody.safeParse(sent).success).toBe(true);
  });

  it('name the keys that differ, in a fixed order, and none for equal settings (dates compared as instants)', () => {
    const before = { ...ACCESS_DEFAULTS };
    expect(changedKeys(before, { ...before })).toEqual([]);
    expect(changedKeys(before, { ...before, closeAt: new Date('2026-12-31T00:00:00Z'), submissionLimit: 5, enabled: false })).toEqual(['enabled', 'closeAt', 'submissionLimit']);
    const opens = { ...before, openAt: new Date('2026-12-01T00:00:00Z') };
    // The same instant written with an offset is no change; another instant is.
    expect(changedKeys(opens, { ...opens, openAt: new Date('2026-12-01T05:30:00+05:30') })).toEqual([]);
    expect(changedKeys(opens, { ...opens, openAt: new Date('2026-12-01T05:30:00Z') })).toEqual(['openAt']);
    const screens = { ...before, screens: { closed: { content: { type: 'doc' as const, content: [] } }, password: { content: { type: 'doc' as const, content: [] } } } };
    expect(changedKeys(screens, { ...screens, screens: { password: screens.screens.password, closed: screens.screens.closed } })).toEqual([]);
  });
});
