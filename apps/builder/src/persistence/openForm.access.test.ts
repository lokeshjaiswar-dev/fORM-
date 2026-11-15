import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsoInstant } from '@form/schema';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { richDoc } from '@/lib/definition';
import type { AccessSettings } from '@/persistence/accessApi';
import { LEGACY_FORMAT, type StoredForm } from '@/persistence/DocumentRepository';
import { newStoredForm, openStored, settleLegacyAccess, type OpenedForm } from '@/persistence/openForm';
import { legacyAccessOf } from '@/state/opsStore';
import { MemoryRepository, v1Form } from '@/test/fixtures';

/*
 * BL-145 and WP-1.07: a form that an older build saved with a password or a closed state in this browser has them sent
 * to the API when it opens, and the browser's copy is rewritten without them. BL-273: a plaintext password is held only
 * for the request that sends it; whatever the request answers, it is in no copy and no ops afterwards. The API is mocked here; its routes are
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

  it('a closed state an earlier open could not send is read from the pending slot, and is not loaded either', () => {
    const pending = { closed: true, closedMessage: richDoc('This form is closed.') };
    const result = opened(storedWith({ pendingAccess: pending }));
    expect(result.legacy).toEqual({ password: '', ...pending });
    expect(result.ops).toEqual({});
    // A slot that holds nothing to send is not worth a call.
    expect(opened(storedWith({ pendingAccess: { closed: false } })).legacy).toBeUndefined();
  });

  it('a slot an earlier dev build saved with the password beside the closed state is still read once, so the password can be sent and then dropped', () => {
    const result = opened(storedWith({ pendingAccess: { password: 'hunter2', closed: true } }));
    expect(result.legacy).toEqual({ password: 'hunter2', closed: true, closedMessage: undefined });
    expect(result.ops).toEqual({});
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

    const { notes, ops } = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(ops).toEqual({});
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

    const { notes } = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(saveAccess).not.toHaveBeenCalled();
    expect(setFormPassword).not.toHaveBeenCalled();
    expect((await repo.load('abc'))?.ops).toEqual({});
    expect(notes[0]?.code).toBe('access_moved');
  });

  it('a server that cannot be reached drops the password and keeps only the closed state, in the copy and in the ops the session carries on with', async () => {
    getAccess.mockRejectedValue(new ApiUnreachable());
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps({ open: false }), { serverRev: 3 });
    await repo.save(stored);

    const { notes, ops } = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(notes).toEqual([expect.objectContaining({ code: 'access_password_dropped', detail: expect.stringContaining('set a new password under Access') }), expect.objectContaining({ code: 'access_kept' })]);
    // The session saves its ops over the copy on every change, so what is still to be sent must be among them.
    const pending = { closed: true, closedMessage: richDoc('This form is closed.') };
    expect(ops).toEqual({ pendingAccess: pending });
    expect((await repo.load('abc'))?.ops).toEqual({ pendingAccess: pending });
    expect(legacyAccessOf((await repo.load('abc'))?.ops)).toEqual({ password: '', ...pending });
    expect(JSON.stringify([ops, await repo.load('abc')])).not.toContain('hunter2');
  });

  it('a form that is open with a password nobody could send keeps nothing: one note, no pending slot', async () => {
    getAccess.mockRejectedValue(new ApiUnreachable());
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps(), { serverRev: 3 });
    await repo.save(stored);

    const { notes, ops } = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(notes).toEqual([expect.objectContaining({ code: 'access_password_dropped' })]);
    expect(ops).toEqual({});
    expect((await repo.load('abc'))?.ops).toEqual({});
    expect(JSON.stringify(await repo.load('abc'))).not.toContain('hunter2');
  });

  it('the closed state a copy kept is read again at the next open and sent then, and the copy is cleared; the password is not sent, it was dropped', async () => {
    getAccess.mockRejectedValueOnce(new ApiUnreachable());
    const repo = new MemoryRepository();
    const first = storedWith(legacyOps({ open: false }), { serverRev: 3 });
    await repo.save(first);
    await settleLegacyAccess(first, opened(first), { org: 'o1', repo });
    expect(setFormPassword).not.toHaveBeenCalled();

    const second = (await repo.load('abc')) as StoredForm;
    const reopened = opened(second);
    expect(reopened.ops).toEqual({});
    expect(reopened.legacy).toEqual({ password: '', closed: true, closedMessage: richDoc('This form is closed.') });
    const { notes, ops } = await settleLegacyAccess(second, reopened, { org: 'o1', repo });

    expect(notes[0]?.code).toBe('access_moved');
    expect(ops).toEqual({});
    expect(saveAccess).toHaveBeenCalledExactlyOnceWith('o1', 'abc', expect.objectContaining({ enabled: false }), 0);
    expect(setFormPassword).not.toHaveBeenCalled();
    expect((await repo.load('abc'))?.ops).toEqual({});
  });

  it('a refusal that retrying cannot fix (a password the server’s rules reject) clears the copy and says why', async () => {
    setFormPassword.mockRejectedValue(new ApiProblem(422, 'WEAK_PASSWORD', 'Choose a longer password.'));
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps(), { serverRev: 3 });
    await repo.save(stored);

    const { notes } = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });

    expect(notes).toEqual([expect.objectContaining({ code: 'access_refused', detail: expect.stringContaining('Choose a longer password.') })]);
    expect(JSON.stringify(await repo.load('abc'))).not.toContain('hunter2');
  });

  it('a 401, a 403 or a 5xx is not final: the closed state stays, so a member who gains the permission later still has it moved; the password does not', async () => {
    for (const status of [401, 403, 408, 429, 503]) {
      setFormPassword.mockRejectedValue(new ApiProblem(status, 'FORBIDDEN', ''));
      getAccess.mockResolvedValue(defaults);
      const repo = new MemoryRepository();
      const stored = storedWith(legacyOps({ open: false }), { serverRev: 3 });
      await repo.save(stored);
      const { notes, ops } = await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });
      expect(notes.map((n) => n.code)).toEqual(['access_password_dropped', 'access_kept']);
      expect(ops.pendingAccess).toEqual({ closed: true, closedMessage: richDoc('This form is closed.') });
      expect(legacyAccessOf((await repo.load('abc'))?.ops)).toEqual({ password: '', closed: true, closedMessage: richDoc('This form is closed.') });
      expect(JSON.stringify(await repo.load('abc'))).not.toContain('hunter2');
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

  it('the closed state the server could not take stays in a draft with unsent changes too, without the password, and the draft stays unsent', async () => {
    getAccess.mockRejectedValue(new ApiUnreachable());
    const saveLocal = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue(undefined);
    const stored = storedWith(legacyOps({ open: false }), { serverRev: 3, dirty: true });
    await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo: { save, saveLocal } });
    expect(saveLocal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dirty: true, ops: { pendingAccess: { closed: true, closedMessage: richDoc('This form is closed.') } } }));
    expect(JSON.stringify(saveLocal.mock.calls)).not.toContain('hunter2');
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

    const { notes, ops } = await settleLegacyAccess(v1, result, { org: 'o1', repo });
    expect(notes).toEqual([expect.objectContaining({ code: 'access_lost', detail: expect.stringContaining('Set them again under Access') })]);
    // The note says it is lost, so the converted draft does not carry it.
    expect(ops).toEqual({});
    // The caller saves the conversion; nothing of this function writes a copy for a migrated form.
    expect(repo.records.size).toBe(0);
  });

  it('a form with nothing to move makes no call', async () => {
    const stored = storedWith({});
    expect(await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo: new MemoryRepository() })).toEqual({ notes: [], ops: {} });
    expect(getAccess).not.toHaveBeenCalled();
  });

  it('nobody signed in: nothing can be sent, so the password is dropped and the closed state waits', async () => {
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps({ open: false }));
    await repo.save(stored);
    const { notes, ops } = await settleLegacyAccess(stored, opened(stored), { org: null, repo });
    expect(notes.map((n) => n.code)).toEqual(['access_password_dropped', 'access_kept']);
    expect(getAccess).not.toHaveBeenCalled();
    expect(ops.pendingAccess).toEqual({ closed: true, closedMessage: richDoc('This form is closed.') });
    expect(JSON.stringify(await repo.load('abc'))).not.toContain('hunter2');
  });
});

/*
 * BL-273: the password in the request is the only copy that outlives the open. Every way the request can end leaves no
 * plaintext password in the copy, in the ops the session carries on with, or in what the session saves over the copy.
 */
describe('a plaintext password never outlives the request that sends it (BL-273)', () => {
  const outcomes: Array<[string, () => void, { org: string | null }]> = [
    ['the server took it', () => undefined, { org: 'o1' }],
    ['the server refused it for good (422)', () => setFormPassword.mockRejectedValue(new ApiProblem(422, 'WEAK_PASSWORD', 'Choose a longer password.')), { org: 'o1' }],
    ['the server could not be reached', () => getAccess.mockRejectedValue(new ApiUnreachable()), { org: 'o1' }],
    ['the member may not manage access yet (403)', () => getAccess.mockRejectedValue(new ApiProblem(403, 'FORBIDDEN', '')), { org: 'o1' }],
    ['the server was down (503)', () => setFormPassword.mockRejectedValue(new ApiProblem(503, 'UNAVAILABLE', '')), { org: 'o1' }],
    ['nobody was signed in', () => undefined, { org: null }],
  ];

  for (const [outcome, arrange, env] of outcomes) {
    for (const dirty of [false, true]) {
      it(`${outcome}${dirty ? ', in a draft with unsent changes' : ''}: no plaintext password is left in the copy or the ops`, async () => {
        arrange();
        const repo = new MemoryRepository();
        const stored = storedWith(legacyOps({ open: false }), { serverRev: 3, dirty });
        await repo.save(stored);
        const written: unknown[] = [];
        const spy = {
          save: (form: StoredForm) => (written.push(form), repo.save(form)),
          saveLocal: (form: StoredForm) => (written.push(form), repo.save(form)),
        };

        const { ops } = await settleLegacyAccess(stored, opened(stored), { ...env, repo: spy });

        expect(written.length).toBeGreaterThan(0);
        expect(JSON.stringify(ops)).not.toContain('hunter2');
        expect(JSON.stringify(written)).not.toContain('hunter2');
        expect(JSON.stringify(await repo.load('abc'))).not.toContain('hunter2');
      });
    }
  }

  it('is handed on in the request that sends it and in no other call', async () => {
    const repo = new MemoryRepository();
    const stored = storedWith(legacyOps(), { serverRev: 3 });
    await repo.save(stored);
    await settleLegacyAccess(stored, opened(stored), { org: 'o1', repo });
    const seen = [getAccess, saveAccess, createRemoteForm].flatMap((fn) => fn.mock.calls);
    expect(JSON.stringify(seen)).not.toContain('hunter2');
    expect(setFormPassword).toHaveBeenCalledExactlyOnceWith('o1', 'abc', 'hunter2');
  });
});
