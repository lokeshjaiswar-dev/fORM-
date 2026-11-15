import { describe, expect, it } from 'vitest';
import { richDoc } from '@/lib/definition';
import type { AccessSettings } from '@/persistence/accessApi';
import { entriesOf, formOf, inputFromForm, isBlankDoc, isChanged } from '@/components/builder/access/accessModel';

const ZONE = 'Asia/Kolkata';

const settings = (patch: Partial<AccessSettings> = {}): AccessSettings => ({
  rev: 4,
  enabled: true,
  hasPassword: false,
  embedAllowlist: [],
  screens: {},
  acceptPreviousVersionsHours: 72,
  ...patch,
});

describe('inputFromForm', () => {
  it('reads dates as wall-clock time in the org zone and sends instants', () => {
    const loaded = settings();
    const form = { ...formOf(loaded, ZONE), openAt: '2026-12-01T09:00', closeAt: '2026-12-31T18:00', limit: '100' };
    expect(inputFromForm(form, loaded, ZONE)).toEqual({
      ok: true,
      input: {
        enabled: true,
        openAt: '2026-12-01T03:30:00.000Z',
        closeAt: '2026-12-31T12:30:00.000Z',
        submissionLimit: 100,
        embedAllowlist: [],
        screens: {},
        acceptPreviousVersionsHours: 72,
      },
    });
  });

  it('names what is wrong, field by field, before anything is sent', () => {
    const loaded = settings();
    const base = formOf(loaded, ZONE);
    const problems = (patch: Partial<typeof base>) => {
      const built = inputFromForm({ ...base, ...patch }, loaded, ZONE);
      return built.ok ? null : built.problems;
    };
    expect(problems({ closeAt: '2026-12-31T18:00', openAt: '2026-12-31T18:00' })).toEqual({ closeAt: 'close_before_open' });
    expect(problems({ openAt: '2026-02-31T18:00' })).toEqual({ openAt: 'date_invalid' });
    expect(problems({ limit: '0' })).toEqual({ limit: 'limit_invalid' });
    expect(problems({ limit: '1.5' })).toEqual({ limit: 'limit_invalid' });
    expect(problems({ previousHours: '721' })).toEqual({ previousHours: 'hours_invalid' });
    expect(problems({ windows: [{ weekdays: [], from: '09:00', to: '17:00' }] })).toEqual({ windows: 'window_invalid' });
    expect(problems({ windows: [{ weekdays: [1], from: '09:00', to: '09:00' }] })).toEqual({ windows: 'window_invalid' });
    expect(problems({ embed: 'http://insecure.example' })).toEqual({ embed: 'embed_invalid' });
    expect(problems({ embed: 'https://example.com/path' })).toEqual({ embed: 'embed_invalid' });
    expect(problems({ redirects: 'https://example.com' })).toEqual({ redirects: 'redirect_invalid' });
  });

  it('keeps every other screen the server holds, and only the closed screen is the author’s text', () => {
    const notYet = { content: richDoc('Opening soon') };
    const loaded = settings({ screens: { not_yet_open: notYet, closed: { content: richDoc('Old text'), origin: 'x' } } });
    const form = { ...formOf(loaded, ZONE), closedMessage: richDoc('See you next year') };
    const built = inputFromForm(form, loaded, ZONE);
    expect(built.ok && built.input.screens).toEqual({ not_yet_open: notYet, closed: { content: richDoc('See you next year'), origin: 'x' } });
    // An emptied message leaves no closed screen: the renderer's own wording is used.
    const emptied = inputFromForm({ ...form, closedMessage: richDoc('') }, loaded, ZONE);
    expect(emptied.ok && emptied.input.screens).toEqual({ not_yet_open: notYet });
  });

  it('turns the lists into trimmed, lower-cased, de-duplicated entries and leaves an empty redirect list out', () => {
    const loaded = settings();
    const form = { ...formOf(loaded, ZONE), embed: 'https://Example.com\nhttps://example.com, https://other.example:8443', redirects: '' };
    const built = inputFromForm(form, loaded, ZONE);
    expect(built.ok && built.input.embedAllowlist).toEqual(['https://example.com', 'https://other.example:8443']);
    expect(built.ok && 'redirectAllowlist' in built.input).toBe(false);
    expect(entriesOf(' A.example , b.example\n\nA.example ')).toEqual(['a.example', 'b.example']);
  });

  it('sends weekly hours in their own zone, weekdays sorted', () => {
    const loaded = settings({ availability: { timeZone: 'Asia/Kolkata', windows: [{ weekdays: [1, 3], from: '09:00', to: '17:00' }] } });
    const form = { ...formOf(loaded, 'Europe/London'), windows: [{ weekdays: [5, 1], from: '10:00', to: '12:00' }] };
    expect(form.windowZone).toBe('Asia/Kolkata');
    const built = inputFromForm(form, loaded, 'Europe/London');
    expect(built.ok && built.input.availability).toEqual({ timeZone: 'Asia/Kolkata', windows: [{ weekdays: [1, 5], from: '10:00', to: '12:00' }] });
  });
});

describe('isChanged', () => {
  it('is false for what was just loaded, and keeps a stored instant that has seconds the input cannot show', () => {
    const loaded = settings({ closeAt: '2026-12-31T12:30:45.000Z', submissionLimit: 50, redirectAllowlist: ['example.com'] });
    const form = formOf(loaded, ZONE);
    expect(form.closeAt).toBe('2026-12-31T18:00');
    expect(isChanged(form, loaded, ZONE)).toBe(false);
    const built = inputFromForm(form, loaded, ZONE);
    expect(built.ok && built.input.closeAt).toBe('2026-12-31T12:30:45.000Z');
  });

  it('is true after an edit, and while an edit is invalid', () => {
    const loaded = settings();
    expect(isChanged({ ...formOf(loaded, ZONE), limit: '10' }, loaded, ZONE)).toBe(true);
    expect(isChanged({ ...formOf(loaded, ZONE), limit: 'ten' }, loaded, ZONE)).toBe(true);
  });
});

describe('isBlankDoc', () => {
  it('is true for no document and for empty paragraphs only', () => {
    expect(isBlankDoc(undefined)).toBe(true);
    expect(isBlankDoc(richDoc(''))).toBe(true);
    expect(isBlankDoc(richDoc('Closed'))).toBe(false);
  });
});
