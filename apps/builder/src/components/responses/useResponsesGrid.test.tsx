import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/auth/client';
import { useResponsesGrid } from '@/components/responses/useResponsesGrid';
import type { GridPage, GridQuery, GridRow } from '@/persistence/submissionsApi';

const listSubmissions = vi.fn();
vi.mock('@/persistence/submissionsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/submissionsApi')>();
  return { ...actual, listSubmissions: (...args: unknown[]) => listSubmissions(...args) };
});

const row = (id: string, change: Partial<GridRow> = {}): GridRow => ({
  id,
  receivedAt: '2026-11-15T10:00:00.000Z',
  status: 'complete',
  read: false,
  starred: false,
  archivedAt: null,
  trashedAt: null,
  versionNumber: 1,
  cells: {},
  masked: [],
  ...change,
});
const page = (ids: string[], nextCursor: string | null = null): GridPage => ({ columns: [{ id: 'b1', key: 'a', label: 'A', type: 'short_text' }], items: ids.map((id) => row(id)), nextCursor });

/** A call whose answer the test gives when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const INBOX: GridQuery = { view: 'inbox' };
const TRASH: GridQuery = { view: 'trash' };

describe('useResponsesGrid', () => {
  beforeEach(() => {
    listSubmissions.mockReset();
  });

  it('loads the first page, then the next one with the cursor the API gave, and appends it', async () => {
    listSubmissions.mockResolvedValueOnce(page(['a', 'b'], 'c1')).mockResolvedValueOnce(page(['c'], null));
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    expect(result.current.state.phase).toBe('loading');
    await waitFor(() => expect(result.current.state.rows.map((r) => r.id)).toEqual(['a', 'b']));
    expect(result.current.state.nextCursor).toBe('c1');

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']));
    expect(listSubmissions).toHaveBeenNthCalledWith(2, 'f1', INBOX, 'c1');
    expect(result.current.state.nextCursor).toBeNull();
    // On the last page there is nothing more to ask for.
    act(() => result.current.loadMore());
    expect(listSubmissions).toHaveBeenCalledTimes(2);
  });

  it('asks for one next page at a time, however often it is asked to', async () => {
    const next = deferred<GridPage>();
    listSubmissions.mockResolvedValueOnce(page(['a'], 'c1')).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(listSubmissions).toHaveBeenCalledTimes(2);
    expect(result.current.state.loadingMore).toBe(true);
    await act(async () => next.resolve(page(['b'])));
    expect(result.current.state.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.current.state.loadingMore).toBe(false);
  });

  it('does not show a row twice when two pages both hold it', async () => {
    listSubmissions.mockResolvedValueOnce(page(['a', 'b'], 'c1')).mockResolvedValueOnce(page(['b', 'c']));
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state.rows).toHaveLength(3));
    expect(result.current.state.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops the answer to a query the member has left, so a slow page never lands in the newer list', async () => {
    const slow = deferred<GridPage>();
    listSubmissions.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(page(['trashed-1']));
    const { result, rerender } = renderHook(({ query }) => useResponsesGrid('f1', query), { initialProps: { query: INBOX } });
    rerender({ query: TRASH });
    await waitFor(() => expect(result.current.state.rows.map((r) => r.id)).toEqual(['trashed-1']));
    // The inbox page arrives late.
    await act(async () => slow.resolve(page(['inbox-1', 'inbox-2'])));
    expect(result.current.state.rows.map((r) => r.id)).toEqual(['trashed-1']);
  });

  it('shows "loading" for a new query at once instead of the last query’s rows', async () => {
    const second = deferred<GridPage>();
    listSubmissions.mockResolvedValueOnce(page(['a'])).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ query }) => useResponsesGrid('f1', query), { initialProps: { query: INBOX } });
    await waitFor(() => expect(result.current.state.rows).toHaveLength(1));
    rerender({ query: TRASH });
    expect(result.current.state.phase).toBe('loading');
    expect(result.current.state.rows).toEqual([]);
    await act(async () => second.resolve(page(['t'])));
    expect(result.current.state.rows.map((r) => r.id)).toEqual(['t']);
  });

  it('does not ask again for the same query when the page builds a new, equal object', async () => {
    listSubmissions.mockResolvedValue(page(['a']));
    const { result, rerender } = renderHook(({ query }) => useResponsesGrid('f1', query), { initialProps: { query: { view: 'inbox', q: 'ada' } as GridQuery } });
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    rerender({ query: { view: 'inbox', q: 'ada' } });
    rerender({ query: { view: 'inbox', q: 'ada' } });
    expect(listSubmissions).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a null query, and shows an empty list', () => {
    const { result } = renderHook(() => useResponsesGrid('f1', null));
    expect(listSubmissions).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ phase: 'ready', rows: [], nextCursor: null });
  });

  it('keeps a failed first page as failed, and Try again asks for the first page once more', async () => {
    listSubmissions.mockRejectedValueOnce(new ApiProblem(500, 'INTERNAL', 'boom')).mockResolvedValueOnce(page(['a']));
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    await waitFor(() => expect(result.current.state.phase).toBe('failed'));
    expect(result.current.state.failure).toMatchObject({ code: 'INTERNAL' });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    expect(listSubmissions).toHaveBeenCalledTimes(2);
    expect(listSubmissions.mock.calls[1]).toEqual(['f1', INBOX]);
  });

  it('stops at a failed later page (no loop) until retryMore, which keeps the rows it has', async () => {
    listSubmissions.mockResolvedValueOnce(page(['a'], 'c1')).mockRejectedValueOnce(new ApiProblem(500, 'INTERNAL', 'boom')).mockResolvedValueOnce(page(['b']));
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state.moreFailed).toBe(true));
    expect(result.current.state.rows.map((r) => r.id)).toEqual(['a']);
    act(() => result.current.loadMore());
    expect(listSubmissions).toHaveBeenCalledTimes(2);

    act(() => result.current.retryMore());
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state.rows.map((r) => r.id)).toEqual(['a', 'b']));
  });

  it('starts again from the first page when the API refuses the cursor', async () => {
    listSubmissions
      .mockResolvedValueOnce(page(['a'], 'old'))
      .mockRejectedValueOnce(new ApiProblem(400, 'INVALID_CURSOR', 'bad'))
      .mockResolvedValueOnce(page(['a2'], null));
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.state.rows.map((r) => r.id)).toEqual(['a2']));
    expect(listSubmissions.mock.calls[2]).toEqual(['f1', INBOX]);
  });

  it('applies flags and removals the API accepted to the rows already loaded, without asking for a page', async () => {
    listSubmissions.mockResolvedValue(page(['a', 'b', 'c']));
    const { result } = renderHook(() => useResponsesGrid('f1', INBOX));
    await waitFor(() => expect(result.current.state.rows).toHaveLength(3));
    act(() => result.current.patchRows(new Set(['a', 'b']), { read: true }));
    act(() => result.current.patchRows(new Set(['b']), { starred: true }));
    expect(result.current.state.rows.map((r) => [r.id, r.read, r.starred])).toEqual([
      ['a', true, false],
      ['b', true, true],
      ['c', false, false],
    ]);
    act(() => result.current.dropRows(new Set(['a', 'c'])));
    expect(result.current.state.rows.map((r) => r.id)).toEqual(['b']);
    expect(listSubmissions).toHaveBeenCalledTimes(1);
  });
});
