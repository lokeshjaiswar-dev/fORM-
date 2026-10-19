import 'fake-indexeddb/auto';
import { createStore, set } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsoInstant } from '@form/schema';
import { addBlock, setTitle, updateBlock } from '@/state/actions';
import { undo } from '@/state/history';
import { DOCUMENT_FORMAT, type StoredForm } from '@/persistence/DocumentRepository';
import { IndexedDbRepository } from '@/persistence/IndexedDbRepository';
import { AUTOSAVE_MS, discardPending, startAutosave } from '@/persistence/autosave';
import { importV1, newStoredForm, openStored } from '@/persistence/openForm';
import { watchTabs } from '@/persistence/tabChannel';
import { MemoryRepository, block, formWith, resetStore } from '@/test/fixtures';

const NOW = '2026-10-19T04:30:00.000Z';
let dbCount = 0;
const freshDb = () => new IndexedDbRepository(`test-${(dbCount += 1)}`);

describe('IndexedDbRepository', () => {
  it('saves, loads and lists forms, most recent first', async () => {
    const repo = freshDb();
    expect(await repo.list()).toEqual([]);
    expect(await repo.load('missing')).toBeNull();
    const a = { ...newStoredForm('a', '2026-10-01T00:00:00.000Z'), doc: { ...formWith([block('text')]), id: 'a', title: 'First' } };
    const b = newStoredForm('b', '2026-10-02T00:00:00.000Z');
    await repo.save(a);
    await repo.save(b);
    expect(await repo.load('a')).toEqual(a);
    expect(await repo.list()).toEqual([
      { id: 'b', title: '', savedAt: b.savedAt, blocks: 0 },
      { id: 'a', title: 'First', savedAt: a.savedAt, blocks: 1 },
    ]);
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

  it('saves a short while after each change, undo included, with a rising revision', async () => {
    const repo = new MemoryRepository();
    const states: string[] = [];
    const saved: number[] = [];
    const autosave = startAutosave({ repo, id: 'test', rev: 4, now: () => NOW, onState: (s) => states.push(s.state), onSaved: (rev) => saved.push(rev) });
    setTitle('One');
    setTitle('Two');
    expect(repo.records.size).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(repo.records.get('test')).toMatchObject({ id: 'test', format: DOCUMENT_FORMAT, rev: 5, savedAt: NOW, doc: { title: 'Two' } });
    undo();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(repo.records.get('test')).toMatchObject({ rev: 6, doc: { title: 'Test form' } });
    expect(states).toEqual(['saving', 'saved', 'saving', 'saved']);
    expect(saved).toEqual([5, 6]);
    await autosave.stop();
  });

  it('stop saves the pending change at once and then stops watching', async () => {
    const repo = new MemoryRepository();
    const autosave = startAutosave({ repo, id: 'test', rev: 0 });
    const id = addBlock('text');
    await autosave.stop();
    expect(repo.records.get('test')).toMatchObject({ rev: 1, doc: { blocks: [{ id }] } });
    updateBlock(id, { label: 'later' });
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
  it('reads a stored v1 form under its record id, with no notes when nothing needed repair or changes in v2', () => {
    const opened = openStored({ ...newStoredForm('abc', NOW), doc: formWith([block('text', { id: 'q', label: 'Q' })]) }, NOW as IsoInstant);
    expect(opened).toMatchObject({ ok: true, notes: [], doc: { id: 'abc', blocks: [{ id: 'q', label: 'Q' }] } });
  });

  it('notes every repair the v1 reader makes', () => {
    const doc = { ...formWith([block('text', { id: 'q' })]), extra: 1 } as unknown;
    const stored: StoredForm = { id: 'abc', format: DOCUMENT_FORMAT, rev: 1, savedAt: NOW, doc };
    const opened = openStored(stored, NOW as IsoInstant);
    expect(opened.ok && opened.notes).toEqual([{ code: 'repaired_unknown_key', path: '/extra', detail: 'an unknown key was dropped' }]);
  });

  it('refuses another format and an unreadable document', () => {
    expect(openStored({ ...newStoredForm('a', NOW), format: 'v2' }, NOW as IsoInstant)).toMatchObject({ ok: false, error: expect.stringContaining("'v2'") });
    expect(openStored({ ...newStoredForm('a', NOW), doc: { schemaVersion: 2 } }, NOW as IsoInstant)).toMatchObject({ ok: false });
  });
});

describe('importV1', () => {
  it('reads a v1 export under a new id with its repairs; opening it runs the v2 migration and shows its notes', () => {
    const v1 = {
      ...formWith([block('text', { id: 'name', label: 'Name' }), block('text', { id: 'shown', logic: { enabled: true, action: 'show', sourceBlockId: 'gone', value: 'x' } })]),
      id: 'old-id',
      unknown: true,
    };
    v1.settings = { ...v1.settings, redirectUrl: 'http://example.com', password: 'hunter2' };
    const imported = importV1(v1, 'new-id');
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.doc.id).toBe('new-id');
    expect(imported.doc.settings.password).toBe('hunter2');
    expect(imported.notes.map((n) => n.code)).toEqual(['repaired_unknown_key']);
    const opened = openStored({ id: 'new-id', format: DOCUMENT_FORMAT, rev: 0, savedAt: NOW, doc: imported.doc }, NOW as IsoInstant);
    if (!opened.ok) throw new Error(opened.error);
    const codes = opened.notes.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['redirect_dropped', 'password_extracted', 'dangling_logic_source']));
    expect(codes).not.toContain('default_purpose_added');
    expect(opened.notes.find((n) => n.code === 'redirect_dropped')?.detail).toMatch(/^the redirect URL is not https/);
  });

  it('shows on load the scale range a v1 form keeps (BL-109)', () => {
    const doc = formWith([block('linear_scale', { id: 's', customize: { scaleMin: 0, scaleMax: 10 } }), block('linear_scale', { id: 'w', customize: { scaleMin: 1, scaleMax: 50 } })]);
    const opened = openStored({ ...newStoredForm('abc', NOW), doc }, NOW as IsoInstant);
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.notes.filter((n) => n.code === 'clamped').map((n) => n.path)).toEqual(['/blocks/w/config/max']);
  });

  it('refuses what is not a v1 form', () => {
    expect(importV1([], 'x')).toMatchObject({ ok: false });
    expect(importV1({ schemaVersion: 2, blocks: [] }, 'x')).toMatchObject({ ok: false });
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
