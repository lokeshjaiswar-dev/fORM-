import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable, useSessionStore, type Me } from '@/auth/client';
import { richDoc } from '@/lib/definition';
import type { AccessSettings } from '@/persistence/accessApi';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import type { DocumentRepository, StoredForm } from '@/persistence/DocumentRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { API_SAVE_MS, AUTOSAVE_MS, discardPending, keepMine, takeTheirs } from '@/persistence/autosave';
import { newStoredForm } from '@/persistence/openForm';
import { useFormSession } from '@/persistence/useFormSession';
import { setTitle } from '@/state/actions';
import { currentOps, legacyAccessOf } from '@/state/opsStore';
import { resetUi, useUiStore } from '@/state/uiStore';
import { MemoryRepository, formWith, resetStore } from '@/test/fixtures';

/*
 * BL-145 end to end, from the session's side: a form an older build saved with a password or a closed state in this
 * browser, opened while the server cannot take them. Autosave writes the whole FormOps store over the cached copy on
 * every save, so the access that is still to be sent has to be part of what the session carries; otherwise the first
 * save drops it, the next open finds nothing to send and shows no note, and a form the author switched off stays open.
 * The API is mocked, as in persistence.test.ts; the routes themselves are proved in apps/api.
 */

const ORG = 'org-1';
const NOW = '2026-11-15T04:30:00.000Z';
const LATER = '2026-11-15T05:00:00.000Z';

const listRemoteForms = vi.fn();
const getRemoteDraft = vi.fn();
const putRemoteDraft = vi.fn();
const createRemoteForm = vi.fn();
const trashRemoteForm = vi.fn();
vi.mock('@/persistence/draftsApi', () => ({
  listRemoteForms: (...args: unknown[]) => listRemoteForms(...args),
  getRemoteDraft: (...args: unknown[]) => getRemoteDraft(...args),
  putRemoteDraft: (...args: unknown[]) => putRemoteDraft(...args),
  createRemoteForm: (...args: unknown[]) => createRemoteForm(...args),
  trashRemoteForm: (...args: unknown[]) => trashRemoteForm(...args),
}));

const getAccess = vi.fn();
const saveAccess = vi.fn();
const setFormPassword = vi.fn();
vi.mock('@/persistence/accessApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/accessApi')>();
  return {
    ...actual,
    getAccess: (...args: unknown[]) => getAccess(...args),
    saveAccess: (...args: unknown[]) => saveAccess(...args),
    setFormPassword: (...args: unknown[]) => setFormPassword(...args),
  };
});

const defaults: AccessSettings = { rev: 0, enabled: true, hasPassword: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };
const me: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: ORG, slug: 'a', name: 'A', role: 'owner' }],
  activeOrgId: ORG,
};

/** The form is closed with its own message and has a password: the two things that must not be dropped. */
const closedAndLocked = { open: false, closedMessage: richDoc('Closed for the season.'), password: 'hunter2' };
const PENDING = { password: 'hunter2', closed: true, closedMessage: richDoc('Closed for the season.') };

const serverDraft = (draftRev: number, title = 'Theirs') => ({ draftRev, draft: { ...formWith([]), formId: 'test', title }, updatedAt: LATER, updatedBy: 'u2' });

const wrapper = (repo: DocumentRepository) => ({ children }: { children: React.ReactNode }) => <RepositoryProvider repo={repo}>{children}</RepositoryProvider>;

/** A cached copy as an older build saved it: the v2 draft with the password and closed state in its ops. */
const cachedWith = async (patch: Partial<StoredForm>) => {
  const cache = new MemoryRepository();
  await cache.save({ ...newStoredForm('test', NOW, { ...formWith([]), title: 'Mine' }), ops: closedAndLocked, serverRev: 5, ...patch });
  return cache;
};

const heldIn = (cache: MemoryRepository) => legacyAccessOf(cache.records.get('test')?.ops);

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function opened(result: { current: { status: string } }) {
  for (let i = 0; i < 20 && result.current.status !== 'ready'; i += 1) await advance(0);
  expect(result.current.status).toBe('ready');
}

describe('legacy access a form could not send at open survives the session (BL-145)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
    resetUi();
    useSessionStore.setState({ status: 'signed_in', me }, true);
    listRemoteForms.mockReset().mockResolvedValue(null);
    getRemoteDraft.mockReset().mockResolvedValue(serverDraft(5, 'Same'));
    putRemoteDraft.mockReset().mockImplementation((_org: string, _id: string, _doc: unknown, expected: number) => Promise.resolve({ draftRev: expected + 1, updatedAt: LATER }));
    createRemoteForm.mockReset().mockResolvedValue(undefined);
    trashRemoteForm.mockReset().mockResolvedValue(undefined);
    getAccess.mockReset().mockResolvedValue(defaults);
    saveAccess.mockReset().mockResolvedValue(defaults);
    setFormPassword.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    useSessionStore.setState({ status: 'unknown' }, true);
  });

  it('a dirty copy opened while the API is out of reach keeps the password and the closed state through its own autosave, and sends them at the next open', async () => {
    const cache = await cachedWith({ dirty: true });
    for (const call of [getRemoteDraft, getAccess, putRemoteDraft]) call.mockRejectedValue(new ApiUnreachable());

    const first = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
    await opened(first.result);
    expect(useUiStore.getState().notes).toEqual([expect.objectContaining({ code: 'access_kept' })]);
    expect(currentOps().pendingAccess).toEqual(PENDING);

    // The dirty copy goes up after 2 s: the repository writes the cache first, even with the server out of reach.
    await advance(API_SAVE_MS);
    expect(putRemoteDraft).toHaveBeenCalled();
    expect(cache.records.get('test')).toMatchObject({ dirty: true, serverRev: 5 });
    expect(heldIn(cache)).toEqual(PENDING);
    first.unmount();
    await advance(0);
    expect(heldIn(cache)).toEqual(PENDING);

    // The next open reaches the server: both settings go up, and the copy is cleared.
    getRemoteDraft.mockResolvedValue(serverDraft(5, 'Same'));
    getAccess.mockResolvedValue(defaults);
    putRemoteDraft.mockImplementation((_org: string, _id: string, _doc: unknown, expected: number) => Promise.resolve({ draftRev: expected + 1, updatedAt: LATER }));
    const second = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
    await opened(second.result);
    expect(useUiStore.getState().notes).toEqual([expect.objectContaining({ code: 'access_moved' })]);
    expect(saveAccess).toHaveBeenCalledExactlyOnceWith(ORG, 'test', expect.objectContaining({ enabled: false, screens: { closed: { content: richDoc('Closed for the season.') } } }), 0);
    expect(setFormPassword).toHaveBeenCalledExactlyOnceWith(ORG, 'test', 'hunter2');
    expect(currentOps()).toEqual({});
    await advance(API_SAVE_MS);
    expect(heldIn(cache)).toBeNull();
    expect(JSON.stringify(cache.records.get('test'))).not.toContain('hunter2');
    second.unmount();
  });

  it('a clean copy keeps them through the author’s first edit when the member cannot manage access yet (403)', async () => {
    const cache = await cachedWith({ dirty: false });
    getAccess.mockRejectedValue(new ApiProblem(403, 'FORBIDDEN', 'No access'));

    const { result, unmount } = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
    await opened(result);
    expect(useUiStore.getState().notes).toEqual([expect.objectContaining({ code: 'access_kept' })]);
    expect(heldIn(cache)).toEqual(PENDING);

    act(() => {
      setTitle('Edited');
    });
    await advance(AUTOSAVE_MS);
    expect(cache.records.get('test')).toMatchObject({ doc: { title: 'Edited' } });
    expect(heldIn(cache)).toEqual(PENDING);
    await advance(API_SAVE_MS);
    expect(putRemoteDraft).toHaveBeenCalled();
    expect(cache.records.get('test')).toMatchObject({ dirty: false, serverRev: 6 });
    expect(heldIn(cache)).toEqual(PENDING);
    unmount();
  });

  it('a copy an older build saved, behind a newer server draft, is not blanked when the cache takes the server draft in', async () => {
    // The cache write that takes a newer server draft over a clean copy blanks a top-level `password`; the session has already read it by then and moves it into the slot.
    const cache = await cachedWith({ dirty: false, serverRev: 3 });
    getRemoteDraft.mockResolvedValue(serverDraft(5, 'Newer'));
    getAccess.mockRejectedValue(new ApiProblem(503, 'UNAVAILABLE', ''));

    const { result, unmount } = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
    await opened(result);
    expect(cache.records.get('test')).toMatchObject({ doc: { title: 'Newer' }, serverRev: 5 });
    expect(heldIn(cache)).toEqual(PENDING);
    unmount();
  });

  describe('a form that opens behind the merge dialog', () => {
    const behind = async () => {
      const cache = await cachedWith({ dirty: true, serverRev: 3 });
      getRemoteDraft.mockResolvedValue(serverDraft(5));
      const hook = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
      await opened(hook.result);
      expect(useUiStore.getState().save).toEqual({ state: 'conflict' });
      return { cache, ...hook };
    };

    it('sends nothing yet and keeps the access in the copy and in the session', async () => {
      const { cache, unmount } = await behind();
      expect(getAccess).not.toHaveBeenCalled();
      expect(setFormPassword).not.toHaveBeenCalled();
      expect(heldIn(cache)).toEqual(PENDING);
      expect(currentOps().pendingAccess).toEqual(PENDING);
      discardPending();
      unmount();
    });

    it('"keep mine" writes the session’s ops over the copy without dropping it', async () => {
      const { cache, unmount } = await behind();
      await act(async () => {
        await keepMine();
      });
      expect(putRemoteDraft).toHaveBeenCalledWith(ORG, 'test', expect.objectContaining({ title: 'Mine' }), 5);
      expect(heldIn(cache)).toEqual(PENDING);
      unmount();
    });

    it('"take theirs" replaces the draft and keeps the access, even if nothing is typed afterwards', async () => {
      const { cache, unmount } = await behind();
      await act(async () => {
        await takeTheirs();
      });
      expect(cache.records.get('test')).toMatchObject({ doc: { title: 'Theirs' }, dirty: false, serverRev: 5 });
      expect(heldIn(cache)).toEqual(PENDING);
      unmount();
    });
  });
});
