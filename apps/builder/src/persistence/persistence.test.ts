import 'fake-indexeddb/auto';
import { createElement, useEffect } from 'react';
import { createStore, set } from 'idb-keyval';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormDefinitionSchema, type IsoInstant } from '@form/schema';
import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { addBlock, setTitle, updateBlock } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import { undo } from '@/state/history';
import { updateOps } from '@/state/opsStore';
import { resetUi, useUiStore } from '@/state/uiStore';
import { ApiUnreachable, useSessionStore, type Me } from '@/auth/client';
import { DraftConflictDialog } from '@/components/builder/DraftConflictDialog';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import { DOCUMENT_FORMAT, DraftConflict, LEGACY_FORMAT, type DocumentRepository, type StoredForm } from '@/persistence/DocumentRepository';
import { IndexedDbRepository } from '@/persistence/IndexedDbRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { API_SAVE_MS, AUTOSAVE_MS, discardPending, flushAutosave, startAutosave } from '@/persistence/autosave';
import { importV1, newStoredForm, openStored } from '@/persistence/openForm';
import { cacheDbName, useRepository } from '@/persistence/repository';
import { watchTabs } from '@/persistence/tabChannel';
import { useFormSession } from '@/persistence/useFormSession';
import { inlineDoc } from '@/lib/definition';
import { MemoryRepository, block, formWith, resetStore, v1Form } from '@/test/fixtures';

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

const NOW = '2026-10-19T04:30:00.000Z';
let dbCount = 0;
const freshDb = () => new IndexedDbRepository(`test-${(dbCount += 1)}`);
const SHORT = { type: 'short_text', configOverrides: {} } as const;

describe('IndexedDbRepository', () => {
  it('saves, loads and lists forms, most recent first', async () => {
    const repo = freshDb();
    expect(await repo.list()).toEqual([]);
    expect(await repo.load('missing')).toBeNull();
    const a = { ...newStoredForm('a', '2026-10-01T00:00:00.000Z'), doc: { ...formWith([block('short_text', 'q')]), formId: 'a', title: 'First' } };
    const b = newStoredForm('b', '2026-10-02T00:00:00.000Z');
    await repo.save(a);
    await repo.save(b);
    expect(await repo.load('a')).toEqual(a);
    expect(await repo.list()).toEqual([
      { id: 'b', title: '', savedAt: b.savedAt, blocks: 0 },
      { id: 'a', title: 'First', savedAt: a.savedAt, blocks: 1 },
    ]);
    await repo.remove('a');
    expect(await repo.load('a')).toBeNull();
    expect((await repo.list()).map((f) => f.id)).toEqual(['b']);
  });

  it('refuses a record that is not a stored form, and lists around it', async () => {
    const repo = new IndexedDbRepository('test-bad');
    await repo.save(newStoredForm('ok', NOW));
    await set('bad', { id: 'bad', doc: 1 }, createStore('test-bad', 'forms'));
    await expect(repo.load('bad')).rejects.toThrow('unreadable');
    expect((await repo.list()).map((f) => f.id)).toEqual(['ok']);
  });
});

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves the v2 definition and the local ops a short while after each change, undo included, with a rising revision', async () => {
    const repo = new MemoryRepository();
    const states: string[] = [];
    const saved: number[] = [];
    const autosave = startAutosave({ repo, id: 'test', rev: 4, now: () => NOW, onState: (s) => states.push(s.state), onSaved: (rev) => saved.push(rev) });
    setTitle('One');
    setTitle('Two');
    expect(repo.records.size).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(repo.records.get('test')).toMatchObject({ id: 'test', format: DOCUMENT_FORMAT, rev: 5, savedAt: NOW, doc: { title: 'Two', schemaVersion: 2 }, ops: { open: true } });
    undo();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(repo.records.get('test')).toMatchObject({ rev: 6, doc: { title: 'Test form' } });
    updateOps({ open: false });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(repo.records.get('test')).toMatchObject({ rev: 7, ops: { open: false } });
    expect(states).toEqual(['saving', 'saved', 'saving', 'saved', 'saving', 'saved']);
    expect(saved).toEqual([5, 6, 7]);
    await autosave.stop();
  });

  it('stop saves the pending change at once and then stops watching', async () => {
    const repo = new MemoryRepository();
    const autosave = startAutosave({ repo, id: 'test', rev: 0 });
    const id = addBlock(SHORT);
    await autosave.stop();
    expect(repo.records.get('test')).toMatchObject({ rev: 1, doc: { pages: [{ children: [id] }] } });
    updateBlock(id as never, { label: inlineDoc('later') });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(repo.records.get('test')?.rev).toBe(1);
  });

  it('reports a failed save and writes the change again on the next flush', async () => {
    const repo = new MemoryRepository();
    const save = vi.spyOn(repo, 'save').mockRejectedValueOnce(new Error('quota exceeded'));
    const states: unknown[] = [];
    const autosave = startAutosave({ repo, id: 'test', rev: 0, now: () => NOW, onState: (s) => states.push(s) });
    setTitle('x');
    await autosave.flush();
    expect(states.at(-1)).toEqual({ state: 'error', message: 'quota exceeded' });
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(repo.records.get('test')).toMatchObject({ rev: 1, doc: { title: 'x' } });
    expect(states.at(-1)).toEqual({ state: 'saved', at: NOW });
    await autosave.stop();
  });

  it('BL-147: a failed save never writes an older document over a newer one', async () => {
    const repo = new MemoryRepository();
    let fail: ((e: Error) => void) | null = null;
    const original = repo.save.bind(repo);
    vi.spyOn(repo, 'save').mockImplementationOnce(() => new Promise<void>((_, reject) => {
      fail = reject;
    })).mockImplementation(original);
    const states: string[] = [];
    const autosave = startAutosave({ repo, id: 'test', rev: 0, now: () => NOW, onState: (s) => states.push(s.state) });
    setTitle('older');
    const first = autosave.flush();
    setTitle('newer');
    const second = autosave.flush();
    await vi.waitFor(() => expect(fail).not.toBeNull());
    (fail as unknown as (e: Error) => void)(new Error('disk full'));
    await first;
    await second;
    await autosave.stop();
    expect(repo.records.get('test')).toMatchObject({ doc: { title: 'newer' } });
    expect(states.at(-1)).toBe('saved');
  });

  it('discardPending drops the unsaved change, so leaving the page writes nothing over another tab', async () => {
    const repo = new MemoryRepository();
    const autosave = startAutosave({ repo, id: 'test', rev: 0 });
    setTitle('unsaved');
    discardPending();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    await autosave.stop();
    expect(repo.records.size).toBe(0);
  });
});

describe('openStored', () => {
  it('reads a stored v2 draft under its record id, through the strict definition twin', () => {
    const stored = { ...newStoredForm('abc', NOW), doc: formWith([block('short_text', 'q', { label: 'Q' })]) };
    const opened = openStored(stored, NOW as IsoInstant);
    expect(opened).toMatchObject({ ok: true, notes: [], migrated: false, doc: { formId: 'abc', blocks: { q: { label: inlineDoc('Q') } } }, ops: { open: true, password: '' } });
  });

  it('refuses another format and a document the twin rejects', () => {
    expect(openStored({ ...newStoredForm('a', NOW), format: 'v9' }, NOW as IsoInstant)).toMatchObject({ ok: false, error: expect.stringContaining('v9') });
    expect(openStored({ ...newStoredForm('a', NOW), doc: { ...formWith([]), extra: 1 } }, NOW as IsoInstant)).toMatchObject({ ok: false });
    expect(openStored({ ...newStoredForm('a', NOW), doc: { schemaVersion: 2 } }, NOW as IsoInstant)).toMatchObject({ ok: false });
  });

  it('BL-143: a v1 draft is migrated once to a valid v2 definition, with its repairs and changes as notes', () => {
    const v1 = { ...v1Form([{ id: 'name', type: 'text', label: 'Name', validation: { required: true } }, { id: 'pb', type: 'page_break' }, { id: 'mail', type: 'email', label: 'Email' }], { redirectUrl: 'http://example.com', password: 'hunter2', closed: true, closedMessage: 'Closed for now' }), extra: 1 };
    const stored: StoredForm = { id: 'abc', format: LEGACY_FORMAT, rev: 3, savedAt: NOW, doc: v1 };
    const opened = openStored(stored, NOW as IsoInstant);
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.migrated).toBe(true);
    expect(FormDefinitionSchema.safeParse(opened.doc).success).toBe(true);
    expect(validateDefinition(opened.doc, 'save', REGISTRY).filter((i) => i.severity === 'error')).toEqual([]);
    expect(opened.doc.formId).toBe('abc');
    expect(opened.doc.pages.map((p) => p.children)).toEqual([['name'], ['mail']]);
    expect(opened.doc.blocks['name' as never]).toMatchObject({ type: 'short_text', required: true });
    expect(opened.ops).toMatchObject({ open: false, password: 'hunter2', closedMessage: { content: [{ content: [{ text: 'Closed for now' }] }] } });
    expect(JSON.stringify(opened.doc)).not.toContain('hunter2');
    const codes = opened.notes.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['converted_to_v2', 'repaired_unknown_key', 'redirect_dropped', 'password_extracted', 'password_kept']));
    expect(codes).not.toContain('default_purpose_added');
  });

  it('shows on load the scale range a v1 form keeps (BL-109)', () => {
    const doc = v1Form([{ id: 's', type: 'linear_scale', customize: { scaleMin: 0, scaleMax: 10 } }, { id: 'w', type: 'linear_scale', customize: { scaleMin: 1, scaleMax: 50 } }]);
    const opened = openStored({ id: 'abc', format: LEGACY_FORMAT, rev: 0, savedAt: NOW, doc }, NOW as IsoInstant);
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.notes.filter((n) => n.code === 'clamped').map((n) => n.path)).toEqual(['/blocks/w/config/max']);
  });
});

describe('importV1', () => {
  it('reads a v1 export under a new id, migrated once, with its repairs and changes as notes', () => {
    const v1 = { ...v1Form([{ id: 'name', type: 'text', label: 'Name' }, { id: 'shown', type: 'text', logic: { enabled: true, action: 'show', sourceBlockId: 'gone', value: 'x' } }], { redirectUrl: 'http://example.com', password: 'hunter2' }), unknown: true };
    const imported = importV1(v1, 'new-id', NOW as IsoInstant);
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.doc.formId).toBe('new-id');
    expect(imported.ops.password).toBe('hunter2');
    const codes = imported.notes.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['repaired_unknown_key', 'redirect_dropped', 'password_extracted', 'dangling_logic_source']));
    expect(imported.notes.find((n) => n.code === 'redirect_dropped')?.detail).toMatch(/^the redirect URL is not https/);
  });

  it('refuses what is not a v1 form', () => {
    expect(importV1([], 'x', NOW as IsoInstant)).toMatchObject({ ok: false });
    expect(importV1({ schemaVersion: 2, blocks: [] }, 'x', NOW as IsoInstant)).toMatchObject({ ok: false });
  });
});

describe('watchTabs', () => {
  it('warns both tabs when a form is open twice, and warns of a save in the other tab', async () => {
    const first: string[] = [];
    const second: string[] = [];
    const other: string[] = [];
    const a = watchTabs('form-1', (c) => first.push(c));
    const b = watchTabs('form-1', (c) => second.push(c));
    const c = watchTabs('form-2', (x) => other.push(x));
    await vi.waitFor(() => expect(first).toContain('open_elsewhere'));
    await vi.waitFor(() => expect(second).toContain('open_elsewhere'));
    b.saved(3);
    await vi.waitFor(() => expect(first).toContain('saved_elsewhere'));
    expect(other).toEqual([]);
    a.close();
    b.close();
    c.close();
  });
});

/* ---- With a server behind the cache (WP-1.06) ---- */

const ORG = 'org-1';
const THEIRS_AT = '2026-10-19T05:00:00.000Z';

/** What a server draft of form `test` looks like in an answer: another title, so it differs from the one on screen. */
const serverDraft = (draftRev: number, title = 'Theirs') => ({ draftRev, draft: { ...formWith([]), formId: 'test', title }, updatedAt: THEIRS_AT, updatedBy: 'u2' });

function resetServer() {
  listRemoteForms.mockReset().mockResolvedValue(null);
  getRemoteDraft.mockReset().mockResolvedValue(null);
  createRemoteForm.mockReset().mockResolvedValue(undefined);
  trashRemoteForm.mockReset().mockResolvedValue(undefined);
  putRemoteDraft.mockReset().mockImplementation((_org: string, _id: string, _doc: unknown, expected: number) => Promise.resolve({ draftRev: expected + 1, updatedAt: THEIRS_AT }));
}

describe('autosave with a server behind the cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
    resetUi({ started: true });
    resetServer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the cache within 400 ms and PUTs once after 2 s idle, with If-Match = the server revision', async () => {
    const cache = new MemoryRepository();
    const states: string[] = [];
    const autosave = startAutosave({ repo: new CachingApiRepository(cache, ORG), id: 'test', rev: 0, serverRev: 4, now: () => NOW, onState: (s) => states.push(s.state) });
    setTitle('A');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(cache.records.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.records.get('test')).toMatchObject({ doc: { title: 'A' }, serverRev: 4, dirty: true });
    expect(putRemoteDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(API_SAVE_MS - AUTOSAVE_MS - 1);
    expect(putRemoteDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(putRemoteDraft).toHaveBeenCalledTimes(1);
    expect(putRemoteDraft).toHaveBeenLastCalledWith(ORG, 'test', expect.objectContaining({ title: 'A' }), 4);
    expect(cache.records.get('test')).toMatchObject({ serverRev: 5, dirty: false });
    expect(states).toEqual(['saving', 'saved']);

    // Typing on keeps pushing the API write back: one PUT for the burst, from the revision the last one returned.
    setTitle('B');
    await vi.advanceTimersByTimeAsync(1500);
    setTitle('C');
    await vi.advanceTimersByTimeAsync(1500);
    expect(putRemoteDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(putRemoteDraft).toHaveBeenCalledTimes(2);
    expect(putRemoteDraft).toHaveBeenLastCalledWith(ORG, 'test', expect.objectContaining({ title: 'C' }), 5);
    await autosave.stop();
  });

  it('flush sends the change now and says which server revision holds the document', async () => {
    const autosave = startAutosave({ repo: new CachingApiRepository(new MemoryRepository(), ORG), id: 'test', rev: 0, serverRev: 2, now: () => NOW });
    setTitle('Publish me');
    expect(await flushAutosave()).toEqual({ serverRev: 3 });
    expect(putRemoteDraft).toHaveBeenCalledWith(ORG, 'test', expect.objectContaining({ title: 'Publish me' }), 2);
    await autosave.stop();
  });

  it('keeps the change in this browser and says so when the server cannot be reached, then sends it on the next flush', async () => {
    putRemoteDraft.mockRejectedValueOnce(new ApiUnreachable());
    const cache = new MemoryRepository();
    const states: string[] = [];
    const autosave = startAutosave({ repo: new CachingApiRepository(cache, ORG), id: 'test', rev: 0, serverRev: 1, now: () => NOW, onState: (s) => states.push(s.state) });
    setTitle('Offline edit');
    await vi.advanceTimersByTimeAsync(API_SAVE_MS);
    expect(states.at(-1)).toBe('local');
    expect(cache.records.get('test')).toMatchObject({ dirty: true, serverRev: 1, doc: { title: 'Offline edit' } });
    expect(await flushAutosave()).toEqual({ serverRev: 2 });
    expect(putRemoteDraft).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe('saved');
    await autosave.stop();
  });

  it('sends an unreachable save again as soon as the browser is back online', async () => {
    putRemoteDraft.mockRejectedValueOnce(new ApiUnreachable());
    const autosave = startAutosave({ repo: new CachingApiRepository(new MemoryRepository(), ORG), id: 'test', rev: 0, serverRev: 1, now: () => NOW });
    setTitle('x');
    await vi.advanceTimersByTimeAsync(API_SAVE_MS);
    expect(putRemoteDraft).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(putRemoteDraft).toHaveBeenCalledTimes(2);
    await autosave.stop();
  });

  it('a refused save shows its reason and is sent again with the next change', async () => {
    putRemoteDraft.mockRejectedValueOnce(new Error('The draft is not valid.'));
    const states: unknown[] = [];
    const autosave = startAutosave({ repo: new CachingApiRepository(new MemoryRepository(), ORG), id: 'test', rev: 0, serverRev: 1, now: () => NOW, onState: (s) => states.push(s) });
    setTitle('x');
    await vi.advanceTimersByTimeAsync(API_SAVE_MS);
    expect(states.at(-1)).toEqual({ state: 'error', message: 'The draft is not valid.' });
    setTitle('xy');
    await vi.advanceTimersByTimeAsync(API_SAVE_MS);
    expect(putRemoteDraft).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toMatchObject({ state: 'saved' });
    await autosave.stop();
  });

  it('a 409 stops sending, keeps saving in this browser and raises the conflict; flush then reports nothing saved', async () => {
    putRemoteDraft.mockRejectedValueOnce(new DraftConflict(serverDraft(7)));
    const cache = new MemoryRepository();
    const states: string[] = [];
    const autosave = startAutosave({ repo: new CachingApiRepository(cache, ORG), id: 'test', rev: 0, serverRev: 3, now: () => NOW, onState: (s) => states.push(s.state) });
    setTitle('Mine');
    await vi.advanceTimersByTimeAsync(API_SAVE_MS);
    expect(states.at(-1)).toBe('conflict');
    expect(useUiStore.getState().draftConflict?.server).toMatchObject({ draftRev: 7 });
    setTitle('Mine, edited');
    await vi.advanceTimersByTimeAsync(API_SAVE_MS * 3);
    expect(putRemoteDraft).toHaveBeenCalledTimes(1);
    expect(cache.records.get('test')).toMatchObject({ dirty: true, doc: { title: 'Mine, edited' } });
    expect(await flushAutosave()).toEqual({ serverRev: null });
    await autosave.stop();
  });
});

describe('the merge dialog opens on a 409 (real timers)', () => {
  beforeEach(() => {
    resetStore();
    resetUi({ started: true });
    resetServer();
  });

  it('a 409 from an autosave opens DraftConflictDialog with what differs', async () => {
    const theirs = { ...serverDraft(7, 'Theirs'), draft: { ...formWith([block('short_text', 'extra', { label: 'Their question' })]), formId: 'test', title: 'Theirs' } };
    putRemoteDraft.mockRejectedValueOnce(new DraftConflict(theirs));
    const repo = new CachingApiRepository(new MemoryRepository(), ORG);
    render(createElement(MemoryRouter, null, createElement(RepositoryProvider, { repo, children: createElement(DraftConflictDialog) })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const autosave = startAutosave({ repo, id: 'test', rev: 0, serverRev: 3, delayMs: 5, apiDelayMs: 10 });
    setTitle('Mine');
    expect(await screen.findByRole('dialog', { name: 'This form changed somewhere else' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Only in the saved version' })).toHaveTextContent('Their question');
    discardPending();
    await autosave.stop();
  });
});

describe('useFormSession with a server behind the cache', () => {
  beforeEach(() => {
    resetStore();
    resetUi();
    resetServer();
  });

  const wrapper = (repo: DocumentRepository) => ({ children }: { children: React.ReactNode }) => createElement(RepositoryProvider, { repo, children });

  it('opens a dirty cached copy that is behind the server with the merge dialog raised, and sends nothing', async () => {
    const cache = new MemoryRepository();
    await cache.save({ ...newStoredForm('test', NOW, { ...formWith([]), title: 'Mine' }), serverRev: 3, dirty: true });
    getRemoteDraft.mockResolvedValue(serverDraft(5));
    const { result, unmount } = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(currentDoc().title).toBe('Mine');
    expect(useUiStore.getState().draftConflict?.server).toMatchObject({ draftRev: 5, draft: { title: 'Theirs' } });
    expect(useUiStore.getState().save).toEqual({ state: 'conflict' });
    expect(putRemoteDraft).not.toHaveBeenCalled();
    discardPending();
    unmount();
  });

  it('opens the server draft over a clean cache that is behind it', async () => {
    const cache = new MemoryRepository();
    await cache.save({ ...newStoredForm('test', NOW, { ...formWith([]), title: 'Old' }), serverRev: 3, dirty: false });
    getRemoteDraft.mockResolvedValue(serverDraft(5, 'Newer'));
    const { result, unmount } = renderHook(() => useFormSession('test'), { wrapper: wrapper(new CachingApiRepository(cache, ORG)) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(currentDoc().title).toBe('Newer');
    expect(useUiStore.getState().draftConflict).toBeNull();
    unmount();
  });
});

describe('org scoping (BL-231)', () => {
  const me = (activeOrgId: string): Me => ({
    user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
    session: null,
    orgs: [
      { id: 'org-a', slug: 'a', name: 'A', role: 'owner' },
      { id: 'org-b', slug: 'b', name: 'B', role: 'owner' },
    ],
    activeOrgId,
  });

  afterEach(() => {
    useSessionStore.setState({ status: 'unknown' }, true);
  });

  /** Renders a provider with no repository of its own and returns the repository a page would get now. */
  function mountProvider(): () => DocumentRepository {
    const seen: DocumentRepository[] = [];
    const Probe = () => {
      const repo = useRepository();
      useEffect(() => {
        seen.push(repo);
      });
      return null;
    };
    render(createElement(RepositoryProvider, null, createElement(Probe)));
    return () => {
      const repo = seen.at(-1);
      if (!repo) throw new Error('no repository');
      return repo;
    };
  }

  it("switching the active org rebuilds the repository, and the list shows only that org's forms", async () => {
    useSessionStore.setState({ status: 'signed_in', me: me('org-a') }, true);
    resetServer();
    listRemoteForms.mockImplementation((org: string) => Promise.resolve({ items: [{ id: `${org}-remote`, title: `Remote of ${org}`, updatedAt: NOW }], complete: true }));
    await new IndexedDbRepository(cacheDbName('org-a')).save(newStoredForm('org-a-local', NOW));

    const current = mountProvider();
    const first = current();
    expect((await first.list()).map((f) => f.id).sort()).toEqual(['org-a-local', 'org-a-remote']);

    act(() => useSessionStore.setState({ status: 'signed_in', me: me('org-b') }, true));
    const second = current();
    expect(second).not.toBe(first);
    expect((await second.list()).map((f) => f.id)).toEqual(['org-b-remote']);
    expect(listRemoteForms).toHaveBeenLastCalledWith('org-b');

    act(() => useSessionStore.setState({ status: 'signed_in', me: me('org-a') }, true));
    expect(current()).toBe(first);
  });

  it('with nobody signed in there is nothing to read and nothing can be saved', async () => {
    useSessionStore.setState({ status: 'signed_out' }, true);
    const none = mountProvider()();
    expect(await none.list()).toEqual([]);
    expect(await none.load('x')).toBeNull();
    await expect(none.save(newStoredForm('x', NOW))).rejects.toThrow('Sign in');
  });
});
