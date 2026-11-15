import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listSubmissions, type GridColumn, type GridQuery, type GridRow } from '@/persistence/submissionsApi';
import { isInvalidCursor } from '@/components/responses/errors';

export interface GridState {
  /** `loading`: the first page of this query is on its way. `failed`: it did not come (`failure` says why). */
  phase: 'loading' | 'ready' | 'failed';
  failure: unknown;
  columns: GridColumn[];
  /** Every row loaded so far, in the API's order: the pages one after the other. */
  rows: GridRow[];
  /** Where the next page starts; null when the last page is in. */
  nextCursor: string | null;
  loadingMore: boolean;
  /** A later page did not come: the grid waits for the member to ask again instead of retrying in a loop. */
  moreFailed: boolean;
}

const LOADING: GridState = { phase: 'loading', failure: null, columns: [], rows: [], nextCursor: null, loadingMore: false, moreFailed: false };
const NOTHING: GridState = { ...LOADING, phase: 'ready' };

export interface ResponsesGrid {
  state: GridState;
  loadMore: () => void;
  /** Lets the grid ask for a page that failed to come once more. */
  retryMore: () => void;
  /** Starts again from the first page of the same query. */
  reload: () => void;
  /** Changes the read or starred flag of rows already loaded, after the API has agreed. Costs no request (every read is audited). */
  patchRows: (ids: ReadonlySet<string>, change: { read?: boolean; starred?: boolean }) => void;
  /** Takes rows out of the list, after the API has moved or deleted them. */
  dropRows: (ids: ReadonlySet<string>) => void;
}

/** What has arrived, and for which request (the form, the query and how many times the member asked again). */
type Held = GridState & { id: string };

/**
 * The pages of one query, one after the other (infinite scroll by the API's signed cursor). A new query starts again
 * from the first page, and an answer to an older query is dropped, so a slow page never lands in a newer list. A page
 * that fails to load stops there: the member asks again, so a server that is down is not asked in a loop. A null query
 * (a date range that ends before it starts) asks nothing and shows nothing.
 */
export function useResponsesGrid(formId: string, query: GridQuery | null): ResponsesGrid {
  // The query is identified by what it asks for, not by the object the page built this render.
  const key = JSON.stringify(query);
  const asked = useMemo(() => JSON.parse(key) as GridQuery | null, [key]);
  const [attempt, setAttempt] = useState(0);
  const id = `${formId}|${key}|${attempt}`;
  const [held, setHeld] = useState<Held | null>(null);
  /** The request whose next page is on its way (one at a time). */
  const moreFor = useRef<string | null>(null);

  // What came for another query is not shown for this one: until its first page arrives, this one is loading.
  const state: GridState = asked === null ? NOTHING : held?.id === id ? held : LOADING;

  useEffect(() => {
    if (asked === null) return;
    let live = true;
    listSubmissions(formId, asked).then(
      (page) => {
        if (live) setHeld({ id, phase: 'ready', failure: null, columns: page.columns, rows: page.items, nextCursor: page.nextCursor, loadingMore: false, moreFailed: false });
      },
      (failure: unknown) => {
        if (live) setHeld({ ...LOADING, id, phase: 'failed', failure });
      },
    );
    return () => {
      live = false;
    };
  }, [formId, asked, id]);

  const { phase, nextCursor, moreFailed } = state;
  const loadMore = useCallback(() => {
    if (asked === null || phase !== 'ready' || nextCursor === null || moreFailed || moreFor.current === id) return;
    moreFor.current = id;
    setHeld((prev) => (prev?.id === id ? { ...prev, loadingMore: true } : prev));
    listSubmissions(formId, asked, nextCursor).then(
      (page) => {
        if (moreFor.current === id) moreFor.current = null;
        setHeld((prev) => {
          // The member has moved on to another query (or asked again): this page is not for the list on screen.
          if (prev?.id !== id) return prev;
          const have = new Set(prev.rows.map((row) => row.id));
          return {
            ...prev,
            columns: page.columns,
            rows: [...prev.rows, ...page.items.filter((row) => !have.has(row.id))],
            nextCursor: page.nextCursor,
            loadingMore: false,
            moreFailed: false,
          };
        });
      },
      (failure: unknown) => {
        if (moreFor.current === id) moreFor.current = null;
        // A cursor the API no longer accepts cannot be retried: the list starts again from the top.
        if (isInvalidCursor(failure)) {
          setAttempt((n) => n + 1);
          return;
        }
        setHeld((prev) => (prev?.id === id ? { ...prev, loadingMore: false, moreFailed: true, failure } : prev));
      },
    );
  }, [formId, asked, id, phase, nextCursor, moreFailed]);

  const retryMore = useCallback(() => setHeld((prev) => (prev?.id === id ? { ...prev, moreFailed: false } : prev)), [id]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const patchRows = useCallback(
    (ids: ReadonlySet<string>, change: { read?: boolean; starred?: boolean }) =>
      setHeld((prev) => (prev ? { ...prev, rows: prev.rows.map((row) => (ids.has(row.id) ? { ...row, ...change } : row)) } : prev)),
    [],
  );

  const dropRows = useCallback(
    (ids: ReadonlySet<string>) => setHeld((prev) => (prev ? { ...prev, rows: prev.rows.filter((row) => !ids.has(row.id)) } : prev)),
    [],
  );

  return { state, loadMore, retryMore, reload, patchRows, dropRows };
}
