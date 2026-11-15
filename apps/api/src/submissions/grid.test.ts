import { describe, expect, it } from 'vitest';
import { signCursor } from '../cursor.ts';
import { ProblemError } from '../errors.ts';
import { gridScope, isFiltered, positionOf, type GridFilters } from './grid.ts';
import { gridQuery, bulkBody, patchBody } from './schemas.ts';

const SECRET = new Uint8Array(32).fill(7);
const ORG = '0190f5a2-7c1e-7a00-8000-000000000001';
const USER = '0190f5a2-7c1e-7a00-8000-000000000002';
const FORM = '0190f5a2-7c1e-7a00-8000-000000000003';
const ID = '0190f5a2-7c1e-7a00-8000-000000000004';
const AT = '2026-11-10T08:15:30.250Z';

const inbox: GridFilters = { view: 'inbox' };
const scope = (f: GridFilters = inbox) => gridScope(ORG, USER, FORM, f);
const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).code).toBe('INVALID_CURSOR');
    return;
  }
  throw new Error('expected INVALID_CURSOR');
};

describe('grid cursors', () => {
  it('give back the position they were signed with, for a time-ordered page and for a search', () => {
    expect(positionOf(SECRET, scope(), signCursor(SECRET, scope(), [AT, ID, 2]), false)).toEqual({ kind: 'row', receivedAt: AT, id: ID, page: 2 });
    const searching = { ...inbox, q: 'pune' };
    expect(positionOf(SECRET, scope(searching), signCursor(SECRET, scope(searching), ['opaque-adapter-cursor', 5]), true)).toEqual({ kind: 'hit', after: 'opaque-adapter-cursor', page: 5 });
  });

  it('are bound to the query: a filter, the view, the search words, the member and the form each change the scope', () => {
    const token = signCursor(SECRET, scope(), [AT, ID, 2]);
    const others: GridFilters[] = [
      { view: 'trash' },
      { view: 'archived' },
      { ...inbox, status: 'spam' },
      { ...inbox, read: false },
      { ...inbox, starred: true },
      { ...inbox, from: new Date(AT) },
      { ...inbox, to: new Date(AT) },
      { ...inbox, q: 'pune' },
    ];
    for (const f of others) invalid(() => positionOf(SECRET, scope(f), token, false));
    invalid(() => positionOf(SECRET, gridScope(ORG, ID, FORM, inbox), token, false));
    invalid(() => positionOf(SECRET, gridScope(ORG, USER, ID, inbox), token, false));
    invalid(() => positionOf(SECRET, gridScope(ID, USER, FORM, inbox), token, false));
  });

  it('refuse a cursor that was edited, made with another key, or whose values are not a position', () => {
    const token = signCursor(SECRET, scope(), [AT, ID, 2]);
    invalid(() => positionOf(SECRET, scope(), `${token.slice(0, -2)}xx`, false));
    invalid(() => positionOf(new Uint8Array(32).fill(8), scope(), token, false));
    invalid(() => positionOf(SECRET, scope(), 'not a cursor', false));
    const sign = (values: Array<string | number | null>) => signCursor(SECRET, scope(), values);
    invalid(() => positionOf(SECRET, scope(), sign([AT, ID]), false));
    invalid(() => positionOf(SECRET, scope(), sign([AT, 'not-a-uuid', 2]), false));
    invalid(() => positionOf(SECRET, scope(), sign(['2026-11-10', ID, 2]), false));
    invalid(() => positionOf(SECRET, scope(), sign(['yesterday', ID, 2]), false));
    invalid(() => positionOf(SECRET, scope(), sign([AT, ID, 1]), false));
    invalid(() => positionOf(SECRET, scope(), sign([AT, ID, 2.5]), false));
    invalid(() => positionOf(SECRET, scope(), sign([AT, ID, '2']), false));
    // A search cursor is not a time cursor and the other way round, whatever the signature says.
    invalid(() => positionOf(SECRET, scope(), sign([AT, ID, 2]), true));
    invalid(() => positionOf(SECRET, scope(), sign(['adapter', 2]), false));
    invalid(() => positionOf(SECRET, scope(), sign(['', 2]), true));
  });
});

describe('grid filters', () => {
  it('count as filtered once more than the view narrows the rows', () => {
    expect(isFiltered(inbox)).toBe(false);
    expect(isFiltered({ view: 'trash' })).toBe(false);
    for (const f of [{ status: 'spam' }, { read: false }, { starred: false }, { from: new Date(0) }, { to: new Date(0) }, { q: 'x' }] as Array<Partial<GridFilters>>) {
      expect(isFiltered({ ...inbox, ...f })).toBe(true);
    }
  });
});

describe('request schemas', () => {
  it('take the query as a browser sends it, with the defaults, and refuse what the grid cannot honour', () => {
    expect(gridQuery.parse({})).toEqual({ limit: 50, view: 'inbox' });
    expect(gridQuery.parse({ limit: '200', read: 'false', starred: 'true', status: 'spam', view: 'trash', q: '  pune  ' })).toMatchObject({ limit: 200, read: 'false', starred: 'true', status: 'spam', view: 'trash', q: 'pune' });
    // An empty search box is no search (the route drops it), not an error.
    expect(gridQuery.parse({ q: '' }).q).toBe('');
    for (const bad of [{ limit: '201' }, { limit: '0' }, { view: 'all' }, { status: 'archived-ish' }, { read: 'yes' }, { from: 'yesterday' }, { q: 'x'.repeat(257) }, { from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }]) {
      expect(gridQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('take a bulk action on 1 to 500 ids from a known list, and a patch that changes something', () => {
    const id = '0190f5a2-7c1e-7a00-8000-0000000000aa';
    expect(bulkBody.safeParse({ ids: [id], action: 'delete' }).success).toBe(true);
    expect(bulkBody.safeParse({ ids: Array.from({ length: 500 }, () => id), action: 'trash' }).success).toBe(true);
    for (const bad of [{ ids: [], action: 'trash' }, { ids: Array.from({ length: 501 }, () => id), action: 'trash' }, { ids: [id], action: 'purge' }, { ids: ['nope'], action: 'trash' }, { ids: [id], action: 'trash', extra: 1 }]) {
      expect(bulkBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(patchBody.safeParse({ read: true }).success).toBe(true);
    expect(patchBody.safeParse({ starred: false, read: false }).success).toBe(true);
    for (const bad of [{}, { read: 'true' }, { trashedAt: null }, { read: true, answers: {} }]) expect(patchBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
