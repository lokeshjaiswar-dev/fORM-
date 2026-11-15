import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DraftConflictDialog } from '@/components/builder/DraftConflictDialog';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import { DraftConflict, type ServerDraft } from '@/persistence/DocumentRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { API_SAVE_MS, discardPending, startAutosave, type Autosave } from '@/persistence/autosave';
import { addBlock, setTitle } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import { loadOps } from '@/state/opsStore';
import { resetUi, useUiStore } from '@/state/uiStore';
import { MemoryRepository, block, formWith, resetStore } from '@/test/fixtures';

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

const ORG = 'org-1';
const THEIRS_AT = '2026-10-19T05:00:00.000Z';

/** The draft another tab saved: a different title and one question this tab does not have. */
const theirs = (draftRev: number) => ({
  draftRev,
  draft: { ...formWith([block('short_text', 'extra', { label: 'Their question' })]), formId: 'test', title: 'Theirs' },
  updatedAt: THEIRS_AT,
  updatedBy: 'u2',
});

describe('DraftConflictDialog', () => {
  let cache: MemoryRepository;
  let repo: CachingApiRepository;
  let autosave: Autosave;

  /** Types in this tab, lets the server answer 409, and waits for the dialog to open. */
  async function openConflict(serverDraft: ServerDraft = theirs(7)) {
    putRemoteDraft.mockRejectedValueOnce(new DraftConflict(serverDraft));
    setTitle('Mine');
    addBlock({ type: 'short_text', configOverrides: {} });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(API_SAVE_MS);
    });
    return screen.findByRole('dialog', { name: 'This form changed somewhere else' });
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetStore();
    resetUi({ started: true });
    listRemoteForms.mockReset().mockResolvedValue(null);
    getRemoteDraft.mockReset().mockResolvedValue(null);
    createRemoteForm.mockReset().mockResolvedValue(undefined);
    trashRemoteForm.mockReset().mockResolvedValue(undefined);
    putRemoteDraft.mockReset().mockImplementation((_org: string, _id: string, _doc: unknown, expected: number) => Promise.resolve({ draftRev: expected + 1, updatedAt: THEIRS_AT }));
    cache = new MemoryRepository();
    repo = new CachingApiRepository(cache, ORG);
    autosave = startAutosave({ repo, id: 'test', rev: 0, serverRev: 3, onState: (save) => useUiStore.setState({ save }) });
    render(
      <RepositoryProvider repo={repo}>
        <MemoryRouter>
          <DraftConflictDialog />
        </MemoryRouter>
      </RepositoryProvider>,
    );
  });

  afterEach(async () => {
    discardPending();
    await autosave.stop();
    vi.useRealTimers();
  });

  it('is closed until the server answers 409, then lists what differs and cannot be dismissed', async () => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const dialog = await openConflict();
    expect(screen.getByRole('region', { name: 'Only in the saved version' })).toHaveTextContent('Their question');
    expect(screen.getByRole('region', { name: 'Only in your version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeEnabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'This form changed somewhere else' })).toBeInTheDocument();
    // Nothing is sent while the choice is open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(API_SAVE_MS * 3);
    });
    expect(putRemoteDraft).toHaveBeenCalledTimes(1);
  });

  it('keep mine: sends the document on screen again, on top of the server revision from the 409', async () => {
    await openConflict(theirs(7));
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(putRemoteDraft).toHaveBeenCalledTimes(2));
    expect(putRemoteDraft).toHaveBeenLastCalledWith(ORG, 'test', expect.objectContaining({ title: 'Mine' }), 7);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useUiStore.getState().draftConflict).toBeNull();
    expect(currentDoc().title).toBe('Mine');
    expect(cache.records.get('test')).toMatchObject({ serverRev: 8, dirty: false, doc: { title: 'Mine' } });
    expect(useUiStore.getState().save).toMatchObject({ state: 'saved' });
  });

  it('take theirs: loads the server draft into the document store and caches it clean at its revision', async () => {
    await openConflict(theirs(7));
    fireEvent.click(screen.getByRole('button', { name: 'Take theirs' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(currentDoc().title).toBe('Theirs');
    expect(Object.keys(currentDoc().blocks)).toEqual(['extra']);
    expect(currentDoc().formId).toBe('test');
    expect(cache.records.get('test')).toMatchObject({ serverRev: 7, dirty: false, doc: { title: 'Theirs' } });
    // Mine was not sent over theirs, and what was loaded is not saved again as a change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(API_SAVE_MS * 2);
    });
    expect(putRemoteDraft).toHaveBeenCalledTimes(1);
  });

  it('copy mine to a new form: saves my version under a new id, then shows the server draft here', async () => {
    await openConflict(theirs(7));
    fireEvent.click(screen.getByRole('button', { name: 'Copy mine to a new form' }));
    await waitFor(() => expect(currentDoc().title).toBe('Theirs'));
    expect(createRemoteForm).toHaveBeenCalledTimes(1);
    const [, copyId, copyTitle] = createRemoteForm.mock.calls[0] as [string, string, string];
    expect(copyId).not.toBe('test');
    expect(copyTitle).toBe('Copy of Mine');
    expect(putRemoteDraft).toHaveBeenLastCalledWith(ORG, copyId, expect.objectContaining({ title: 'Copy of Mine' }), 0);
    expect(cache.records.get(copyId)).toMatchObject({ doc: { title: 'Copy of Mine' } });
    expect(cache.records.get('test')).toMatchObject({ serverRev: 7, dirty: false, doc: { title: 'Theirs' } });
  });

  it('copy mine leaves access the server has not taken with this form: the copy has none of it', async () => {
    loadOps({ pendingAccess: { password: 'hunter2', closed: true } });
    await openConflict(theirs(7));
    fireEvent.click(screen.getByRole('button', { name: 'Copy mine to a new form' }));
    await waitFor(() => expect(currentDoc().title).toBe('Theirs'));
    const [, copyId] = createRemoteForm.mock.calls[0] as [string, string, string];
    expect(cache.records.get(copyId)?.ops).toEqual({});
    expect(JSON.stringify(cache.records.get(copyId))).not.toContain('hunter2');
    // It is still waiting for this form's next open.
    expect(cache.records.get('test')?.ops).toMatchObject({ pendingAccess: { password: 'hunter2', closed: true } });
  });

  it('says so when the server draft cannot be read, and still offers keep mine', async () => {
    const dialog = await openConflict({ ...theirs(7), draft: { schemaVersion: 2, nonsense: true } });
    expect(dialog).toHaveTextContent('The saved version cannot be shown');
    expect(screen.getByRole('button', { name: 'Take theirs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy mine to a new form' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeEnabled();
  });
});
