import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { SEARCH_DELAY_MS, useFormsList } from '@/pages/forms/useFormsList';
import type { FormRow, FormsPage, FormsQuery } from '@/persistence/formsListApi';
import { MemoryRepository } from '@/test/fixtures';

/*
 * The list hook's rules, with the API call held in the test's hand: what happens to an answer that arrives after the
 * query moved on, to a cursor the server refuses, and to a session that ended. The page's controls are in FormsList.test.tsx.
 */

const fetchFormsPage = vi.fn<(org: string, query: FormsQuery, cursor?: string | null) => Promise<FormsPage>>();
const loadSession = vi.fn();
vi.mock('@/persistence/formsListApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/formsListApi')>();
  return { ...actual, fetchFormsPage: (...args: Parameters<typeof fetchFormsPage>) => fetchFormsPage(...args) };
});
vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, loadSession: () => loadSession() };
});

const row = (id: string, title = id): FormRow => ({ id, title, lifecycle: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', favourite: false, submissionCount: 0, isLive: false });
const page = (ids: string[], nextCursor: string | null = null): FormsPage => ({ items: ids.map((id) => row(id)), nextCursor });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ids = (hook: { current: ReturnType<typeof useFormsList> }) => (hook.current.state.status === 'ready' ? hook.current.state.items.map((r) => r.id) : null);

/** One repository for the whole test: a new one per render would look like a different org's list every time and load for ever. */
let repo: MemoryRepository;

beforeEach(() => {
  repo = new MemoryRepository();
  fetchFormsPage.mockReset();
  loadSession.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useFormsList', () => {
  it('drops an answer that arrives after the folder changed, so a slow page never lands in the wrong list', async () => {
    const slow = deferred<FormsPage>();
    fetchFormsPage.mockImplementation((_org, query) => (query.lifecycle === 'active' ? slow.promise : Promise.resolve({ items: [{ ...row('t1'), lifecycle: 'trashed' }], nextCursor: null })));
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    act(() => result.current.setLifecycle('trashed'));
    await waitFor(() => expect(ids(result)).toEqual(['t1']));
    await act(async () => {
      slow.resolve(page(['stale']));
      await slow.promise;
    });
    expect(ids(result)).toEqual(['t1']);
    expect(result.current.lifecycle).toBe('trashed');
  });

  it('waits for the search to pause before it asks, and trims it', async () => {
    vi.useFakeTimers();
    fetchFormsPage.mockResolvedValue(page(['a']));
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchFormsPage).toHaveBeenCalledTimes(1);
    act(() => result.current.setSearch('  inv'));
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 50));
    act(() => result.current.setSearch('  invoice '));
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 50));
    expect(fetchFormsPage).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetchFormsPage).toHaveBeenCalledTimes(2);
    expect(fetchFormsPage).toHaveBeenLastCalledWith('o1', { lifecycle: 'active', q: 'invoice', sort: 'updated', favourite: false });
  });

  it('adds the next page under the same query, once, and keeps the page on screen if it fails', async () => {
    fetchFormsPage.mockResolvedValueOnce(page(['a', 'b'], 'cur-1'));
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    await waitFor(() => expect(ids(result)).toEqual(['a', 'b']));

    fetchFormsPage.mockRejectedValueOnce(new ApiProblem(503, 'UNAVAILABLE', 'Try again in a moment.'));
    await act(() => result.current.loadMore());
    expect(ids(result)).toEqual(['a', 'b']);
    expect(result.current.more).toEqual({ busy: false, error: 'Try again in a moment.' });

    const next = deferred<FormsPage>();
    fetchFormsPage.mockReturnValueOnce(next.promise);
    act(() => void result.current.loadMore());
    // A second press while the first is out does not send a second call.
    await act(() => result.current.loadMore());
    expect(fetchFormsPage).toHaveBeenCalledTimes(3);
    expect(fetchFormsPage).toHaveBeenLastCalledWith('o1', { lifecycle: 'active', q: '', sort: 'updated', favourite: false }, 'cur-1');
    await act(async () => {
      next.resolve(page(['b', 'c']));
      await next.promise;
    });
    // A row the first page already had is not listed twice.
    expect(ids(result)).toEqual(['a', 'b', 'c']);
    expect(result.current.more).toEqual({ busy: false, error: null });
    expect(result.current.state).toMatchObject({ nextCursor: null });
  });

  it('a page that arrives after the query changed is not added to the new list', async () => {
    fetchFormsPage.mockResolvedValueOnce(page(['a'], 'cur-1'));
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    await waitFor(() => expect(ids(result)).toEqual(['a']));
    const late = deferred<FormsPage>();
    fetchFormsPage.mockReturnValueOnce(late.promise);
    act(() => void result.current.loadMore());
    fetchFormsPage.mockResolvedValueOnce(page(['z']));
    act(() => result.current.setSort('title'));
    await waitFor(() => expect(ids(result)).toEqual(['z']));
    await act(async () => {
      late.resolve(page(['old']));
      await late.promise;
    });
    expect(ids(result)).toEqual(['z']);
  });

  it('starts the list again when the server no longer accepts its cursor', async () => {
    fetchFormsPage.mockResolvedValueOnce(page(['a'], 'cur-1'));
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    await waitFor(() => expect(ids(result)).toEqual(['a']));
    fetchFormsPage.mockRejectedValueOnce(new ApiProblem(400, 'INVALID_CURSOR', 'That cursor does not belong to this query.'));
    fetchFormsPage.mockResolvedValueOnce(page(['a', 'b']));
    await act(() => result.current.loadMore());
    await waitFor(() => expect(ids(result)).toEqual(['a', 'b']));
    expect(result.current.more.error).toBeNull();
    expect(fetchFormsPage).toHaveBeenLastCalledWith('o1', expect.anything());
  });

  it('a session that ended asks the session gate again, and the list says it could not load', async () => {
    fetchFormsPage.mockRejectedValue(new ApiProblem(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    await waitFor(() => expect(result.current.state).toEqual({ status: 'error', message: 'Sign in to continue.' }));
    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it('an unreachable server, or no org, shows the browser’s own copy instead', async () => {
    fetchFormsPage.mockRejectedValue(new ApiUnreachable());
    await repo.save({ id: 'l1', format: 'v2', rev: 0, savedAt: '2026-11-03T00:00:00.000Z', doc: { title: 'Local one', blocks: {} } });
    const { result } = renderHook(() => useFormsList(repo, 'o1'));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'ready', source: 'local' }));
    expect(ids(result)).toEqual(['l1']);

    fetchFormsPage.mockClear();
    const none = renderHook(() => useFormsList(repo, null));
    await waitFor(() => expect(none.result.current.state).toMatchObject({ status: 'ready', source: 'local' }));
    expect(fetchFormsPage).not.toHaveBeenCalled();
  });
});
