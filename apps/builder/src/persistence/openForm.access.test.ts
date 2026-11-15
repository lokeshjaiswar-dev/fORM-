import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsoInstant } from '@form/schema';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { richDoc } from '@/lib/definition';
import type { AccessSettings } from '@/persistence/accessApi';
import { LEGACY_FORMAT, type StoredForm } from '@/persistence/DocumentRepository';
import { newStoredForm, openStored, settleLegacyAccess, type OpenedForm } from '@/persistence/openForm';
import { MemoryRepository, v1Form } from '@/test/fixtures';

/*
 * BL-145 and WP-1.07: a form that an older build saved with a password or a closed state in this browser has them sent
 * to the API when it opens, and the browser's copy is rewritten without them. The API is mocked here; its routes are
 * proved in apps/api (access.int.test.ts) and the whole path in the builder's stack e2e.
 */

const getAccess = vi.fn();
const saveAccess = vi.fn();
const setFormPassword = vi.fn();
const createRemoteForm = vi.fn();

vi.mock('@/persistence/accessApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/accessApi')>();
  return {
    ...actual,
    getAccess: (...args: unknown[]) => getAccess(...args),
    saveAccess: (...args: unknown[]) => saveAccess(...args),
    setFormPassword: (...args: unknown[]) => setFormPassword(...args),
  };
});
vi.mock('@/persistence/draftsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/draftsApi')>();
  return { ...actual, createRemoteForm: (...args: unknown[]) => createRemoteForm(...args) };
});

const NOW = '2026-11-15T04:30:00.000Z';
const defaults: AccessSettings = { rev: 0, enabled: true, hasPassword: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 };

/** A stored form as an older build saved it: the v2 draft, with its FormOps (open, closed message, password) beside it. */
function storedWith(ops: unknown, patch: Partial<StoredForm> = {}): StoredForm {
  return { ...newStoredForm('abc', NOW), ops, ...patch };
}

function opened(stored: StoredForm): OpenedForm {
  const result = openStored(stored, NOW as IsoInstant);
  if (!result.ok) throw new Error(result.error);
  return result;
}

const legacyOps = (patch: Record<string, unknown> = {}) => ({ open: true, closedMessage: richDoc('This form is closed.'), password: 'hunter2', ...patch });

beforeEach(() => {
  for (const fn of [getAccess, saveAccess, setFormPassword, createRemoteForm]) fn.mockReset();
  getAccess.mockResolvedValue(defaults);
  saveAccess.mockResolvedValue(defaults);
  setFormPassword.mockResolvedValue(undefined);
  createRemoteForm.mockResolvedValue(undefined);
});

describe('openStored reads the legacy FormOps without loading them', () => {
  it('a stored draft whose ops hold a password has a legacy password, and its ops are empty', () => {
    const result = opened(storedWith(legacyOps()));
    expect(result.legacy).toEqual({ password: 'hunter2', closed: false, closedMessage: undefined });
    expect(result.ops).toEqual({});
  });

  it('a closed form keeps the closed message it had; an open form’s message is not worth moving', () => {
    expect(opened(storedWith(legacyOps({ open: false, password: '' }))).legacy).toEqual({ password: '', closed: true, closedMessage: richDoc('This form is closed.') });
    expect(opened(storedWith(legacyOps({ open: false, password: '', closedMessage: richDoc('') }))).legacy).toEqual({ password: '', closed: true, closedMessage: undefined });
    expect(opened(storedWith(legacyOps({ password: '' }))).legacy).toBeUndefined();
  });

  it('ops that hold nothing, or are not ops at all, leave nothing to move', () => {
    expect(opened(storedWith({})).legacy).toBeUndefined();
    expect(opened(storedWith(undefined)).legacy).toBeUndefined();
    expect(opened(storedWith('garbage')).legacy).toBeUndefined();
    expect(opened(storedWith({ open: 'yes', password: 7 })).legacy).toBeUndefined();
  });
});

describe('settleLegacyAccess (BL-145)', () => {
  it('a stored draft whose ops hold a password is moved (PUT password) and the browser’s copy no longer contains it', async () => {
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps(), { serverRev: 3 });
    await repo.save(stored);

    const notes = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(setFormPassword).toHaveBeenCalledExactlyOnceWith('o1', 'abc', 'hunter2');
    expect(createRemoteForm).not.toHaveBeenCalled();
    expect(saveAccess).not.toHaveBeenCalled();
    const kept = await repo.load('abc');
    expect(kept?.ops).toEqual({});
    expect(JSON.stringify(kept)).not.toContain('hunter2');
    expect(notes).toEqual([expect.objectContaining({ code: 'access_moved' })]);
  });

  it('a closed form is saved closed with its message, as the first settings of a form nobody configured; a form only this browser had is created first', async () => {
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps({ open: false, password: '' }));
    await repo.save(stored);

    await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(createRemoteForm).toHaveBeenCalledExactlyOnceWith('o1', 'abc', '');
    expect(saveAccess).toHaveBeenCalledExactlyOnceWith('o1', 'abc', expect.objectContaining({ enabled: false, screens: { closed: { content: richDoc('This form is closed.') } } }), 0);
    expect(setFormPassword).not.toHaveBeenCalled();
    expect((await repo.load('abc'))?.ops).toEqual({});
  });

  it('the server wins where it already holds a value: an old local copy never overwrites newer settings or a newer password', async () => {
    getAccess.mockResolvedValue({ ...defaults, rev: 3, hasPassword: true });
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps({ open: false }), { serverRev: 2 });
    await repo.save(stored);

    const notes = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(saveAccess).not.toHaveBeenCalled();
    expect(setFormPassword).not.toHaveBeenCalled();
    expect((await repo.load('abc'))?.ops).toEqual({});
    expect(notes[0]?.code).toBe('access_moved');
  });

  it('a server that cannot be reached leaves the copy as it is, to try again at the next open', async () => {
    getAccess.mockRejectedValue(new ApiUnreachable());
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps(), { serverRev: 3 });
    await repo.save(stored);

    const notes = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(notes).toEqual([expect.objectContaining({ code: 'access_kept' })]);
    expect((await repo.load('abc'))?.ops).toEqual(legacyOps());
  });

  it('a refusal that retrying cannot fix (a password the server’s rules reject) clears the copy and says why', async () => {
    setFormPassword.mockRejectedValue(new ApiProblem(422, 'WEAK_PASSWORD', 'Choose a longer password.'));
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps(), { serverRev: 3 });
    await repo.save(stored);

    const notes = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(notes).toEqual([expect.objectContaining({ code: 'access_refused', detail: expect.stringContaining('Choose a longer password.') })]);
    expect(JSON.stringify(await repo.load('abc'))).not.toContain('hunter2');
  });

  it('a 403 or a 5xx is not final: the copy stays, so a member who gains the permission later still has it moved', async () => {
    for (const status of [403, 429, 503]) {
      setFormPassword.mockRejectedValue(new ApiProblem(status, 'FORBIDDEN', ''));
      const repo = new MemoryRepository();
      const stored = storedWith(legacyOps(), { serverRev: 3 });
      await repo.save(stored);
      expect((await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo }))[0]?.code).toBe('access_kept');
      expect((await repo.load('abc'))?.ops).toEqual(legacyOps());
    }
  });

  it('a draft with unsent changes is rewritten in this browser only, and stays unsent', async () => {
    const saveLocal = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue(undefined);
    const stored = storedWith(legacyOps(), { serverRev: 3, dirty: true });
    await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo: { save, saveLocal } });
    expect(saveLocal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'abc', dirty: true, ops: {} }));
    expect(save).not.toHaveBeenCalled();
  });

  it('a clean copy is written as clean, so the server is not sent the draft', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const stored = storedWith(legacyOps(), { serverRev: 3, dirty: false });
    await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo: { save } });
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dirty: false, ops: {} }));
  });

  it('a v1 file is replaced by its conversion right after, so the notes say to set the password again if it could not be sent', async () => {
    getAccess.mockRejectedValue(new ApiUnreachable());
    const repo = new MemoryRepository();
    const v1: StoredForm = { id: 'old', format: LEGACY_FORMAT, rev: 2, savedAt: NOW, doc: v1Form([{ id: 'q', type: 'text', label: 'Question' }], { password: 'hunter2' }) };
    const result = opened(v1);
    expect(result.migrated).toBe(true);
    expect(result.legacy?.password).toBe('hunter2');

    const notes = await settleLegacyAccess(v1, result, { org: 'o1', repo });
    expect(notes).toEqual([expect.objectContaining({ code: 'access_lost', detail: expect.stringContaining('Set them again under Access') })]);
    // The caller saves the conversion; nothing of this function writes a copy for a migrated form.
    expect(repo.records.size).toBe(0);
  });

  it('a form with nothing to move makes no call', async () => {
    const stored = storedWith({});
    expect(await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo: new MemoryRepository() })).toEqual([]);
    expect(getAccess).not.toHaveBeenCalled();
  });

  it('nobody signed in: nothing can be sent, and the copy is left alone', async () => {
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps());
    await repo.save(stored);
    expect((await settleLegacyAccess(stored, opened(stored), { org: null, repo }))[0]?.code).toBe('access_kept');
    expect(getAccess).not.toHaveBeenCalled();
    expect((await repo.load('abc'))?.ops).toEqual(legacyOps());
  });
});
