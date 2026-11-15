import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineMessages } from '@form/i18n';
import { ApiProblem, ApiUnreachable, loadSession } from '@/auth/client';
import { t } from '@/i18n';
import { whenSaved } from '@/persistence/autosave';
import type { DocumentRepository, FormSummary } from '@/persistence/DocumentRepository';
import { fetchFormsPage, type FormLifecycle, type FormRow, type FormSort, type FormsQuery } from '@/persistence/formsListApi';

const M = defineMessages('builder', {
  'forms.load_failed': 'The forms could not be loaded.',
  'forms.more_failed': 'More forms could not be loaded.',
});

/** How long the search box waits after the last key before it asks the server, so typing "invoice" is one call, not seven. */
export const SEARCH_DELAY_MS = 300;

/**
 * A row of the list. `unsynced` marks a form this browser holds that the server has never seen (made offline, or its
 * first save failed): it has no copy to archive, clone or restore, and deleting it cannot be undone.
 */
export interface ListRow extends FormRow {
  unsynced?: boolean;
}

/**
 * `server`: the pages the API answered. `local`: the server could not be reached, so this is what the browser's cache
 * holds, with search applied here and none of the server-only controls (stars, archive, trash view, clone).
 */
export type ListSource = 'server' | 'local';

export type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; source: ListSource; items: ListRow[]; nextCursor: string | null };

/** The server's own sentence for a refusal (it is written for people), else `fallback`. */
export function describeError(err: unknown, fallback: string): string {
  return err instanceof ApiProblem && err.message ? err.message : fallback;
}

const LOADING: ListState = { status: 'loading' };

/** The state of "Load more": a call out, or why the last one failed. */
interface MoreState {
  busy: boolean;
  error: string | null;
}
const IDLE: MoreState = { busy: false, error: null };

/** Everything a list depends on, as one object that is new whenever any of it changes (see `useFormsList`). */
interface Token {
  repo: DocumentRepository;
  org: string | null;
  lifecycle: FormLifecycle;
  q: string;
  sort: FormSort;
  favourite: boolean;
  reloads: number;
}

/** What a query loaded, tagged with the query's token. */
interface Loaded {
  token: Token;
  state: ListState;
  more: MoreState;
}

const matches = (title: string, q: string) => title.toLowerCase().includes(q.toLowerCase());

/** A form from the browser's cache as a list row. Nothing is known of its star, count or creation date there. */
function cachedRow(form: FormSummary): ListRow {
  return { id: form.id, title: form.title, lifecycle: 'active', createdAt: form.savedAt, updatedAt: form.savedAt, favourite: false, submissionCount: 0, isLive: false };
}

/** Rows of `next` added to `prev`; a server row replaces an unsynced one of the same id (the form reached the server meanwhile). */
function appendRows(prev: ListRow[], next: ListRow[]): ListRow[] {
  const incoming = new Set(next.map((row) => row.id));
  const known = new Set(prev.filter((row) => !row.unsynced).map((row) => row.id));
  return [...prev.filter((row) => !(row.unsynced && incoming.has(row.id))), ...next.filter((row) => !known.has(row.id))];
}

/**
 * The forms list of the signed-in member's active org (BL-267): the server's pages for the chosen folder (Active,
 * Archived, Trash), search, sort and starred filter, "Load more" by the server's signed cursor, and the small row
 * updates the actions make. Anything that changes the query restarts at the first page; an answer that arrives after
 * the query changed again is dropped, so a slow page never lands in the wrong list.
 *
 * While the server cannot be reached the list falls back to the browser's cache (offline-first, as the builder does
 * everywhere); while it can, forms the cache holds and the server has never seen are listed first, so a form made
 * offline is not lost from sight.
 */
export function useFormsList(repo: DocumentRepository, org: string | null) {
  const [lifecycle, setLifecycle] = useState<FormLifecycle>('active');
  const [sort, setSort] = useState<FormSort>('updated');
  const [favourite, setFavourite] = useState(false);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [reloads, setReloads] = useState(0);
  /**
   * One value per query: it changes exactly when the list has to start again (another folder, search, sort, org, or a
   * reload). What was loaded under an earlier value is never shown, so a changed query shows "loading" in the same
   * render instead of the last list for a moment, and an answer for an earlier value is dropped.
   */
  const token = useMemo<Token>(() => ({ repo, org, lifecycle, q, sort, favourite, reloads }), [repo, org, lifecycle, q, sort, favourite, reloads]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const state: ListState = loaded?.token === token ? loaded.state : LOADING;
  const more: MoreState = loaded?.token === token ? loaded.more : IDLE;
  /** The token the rows being loaded belong to, null once the page is left. */
  const active = useRef<Token | null>(null);
  const moreBusy = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const { repo, org, lifecycle, q, sort, favourite } = token;
    active.current = token;
    moreBusy.current = false;

    const cachedForms = async (): Promise<FormSummary[]> => (repo.listCached ? repo.listCached() : repo.list());
    const local = async (): Promise<ListState> => {
      const items = lifecycle === 'active' ? (await cachedForms()).filter((form) => !q || matches(form.title, q)).map(cachedRow) : [];
      return { status: 'ready', source: 'local', items, nextCursor: null };
    };
    /** Forms only this browser has. They are not in any server page, and they cannot be starred, so only the plain Active list shows them. */
    const unsynced = async (): Promise<ListRow[]> => {
      if (lifecycle !== 'active' || favourite || !repo.listCached) return [];
      try {
        return (await repo.listCached()).filter((form) => (form.serverRev ?? 0) === 0 && (!q || matches(form.title, q))).map((form) => ({ ...cachedRow(form), unsynced: true }));
      } catch {
        return [];
      }
    };

    const first = async (): Promise<ListState> => {
      // The form just left may still be saving; the list should show its new title.
      await whenSaved();
      if (org === null) return local();
      try {
        const page = await fetchFormsPage(org, { lifecycle, q, sort, favourite });
        return { status: 'ready', source: 'server', items: appendRows(await unsynced(), page.items), nextCursor: page.nextCursor };
      } catch (err) {
        if (err instanceof ApiUnreachable) return local();
        // The session ended: let the session gate send the member to sign in.
        if (err instanceof ApiProblem && err.status === 401) void loadSession();
        return { status: 'error', message: describeError(err, t(M['forms.load_failed'])) };
      }
    };

    const show = (next: ListState) => {
      if (active.current === token) setLoaded({ token, state: next, more: IDLE });
    };
    first().then(show, () => show({ status: 'error', message: t(M['forms.load_failed']) }));
    return () => {
      if (active.current === token) active.current = null;
    };
  }, [token]);

  /** Changes what is loaded under the current query; a change meant for an earlier one is dropped. */
  const update = useCallback((mine: Token, change: (current: Loaded) => Loaded) => setLoaded((prev) => (prev && prev.token === mine ? change(prev) : prev)), []);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    const { org, lifecycle, q, sort, favourite } = token;
    if (state.status !== 'ready' || state.source !== 'server' || !state.nextCursor || org === null || moreBusy.current) return;
    const mine = token;
    const query: FormsQuery = { lifecycle, q, sort, favourite };
    moreBusy.current = true;
    update(mine, (current) => ({ ...current, more: { busy: true, error: null } }));
    try {
      const page = await fetchFormsPage(org, query, state.nextCursor);
      if (active.current !== mine) return;
      update(mine, (current) =>
        current.state.status === 'ready'
          ? { ...current, state: { ...current.state, items: appendRows(current.state.items, page.items), nextCursor: page.nextCursor }, more: IDLE }
          : current,
      );
    } catch (err) {
      if (active.current !== mine) return;
      // A cursor the server no longer accepts (it is bound to the exact query) cannot be retried: start the list again.
      if (err instanceof ApiProblem && err.code === 'INVALID_CURSOR') reload();
      else update(mine, (current) => ({ ...current, more: { busy: false, error: describeError(err, t(M['forms.more_failed'])) } }));
    } finally {
      if (active.current === mine) moreBusy.current = false;
    }
  }, [state, token, reload, update]);

  const patchRow = useCallback(
    (id: string, patch: Partial<ListRow>) =>
      update(token, (current) =>
        current.state.status === 'ready' ? { ...current, state: { ...current.state, items: current.state.items.map((row) => (row.id === id ? { ...row, ...patch } : row)) } } : current,
      ),
    [token, update],
  );

  const removeRow = useCallback(
    (id: string) =>
      update(token, (current) => (current.state.status === 'ready' ? { ...current, state: { ...current.state, items: current.state.items.filter((row) => row.id !== id) } } : current)),
    [token, update],
  );

  return {
    /**
     * Names the list on screen: a new value whenever it is loaded again (another folder, search, sort or org, or a
     * reload). Things that belong to one list, such as ticked rows, remember it and are dropped when it changes.
     */
    view: token as object,
    lifecycle,
    sort,
    favourite,
    search,
    /** The search the list was last asked for; it trails `search` by `SEARCH_DELAY_MS`. */
    appliedSearch: q,
    setLifecycle,
    setSort,
    setFavourite,
    setSearch,
    state,
    more,
    loadMore,
    reload,
    patchRow,
    removeRow,
  };
}

export type FormsList = ReturnType<typeof useFormsList>;
