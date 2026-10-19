import 'fake-indexeddb/auto';
import { createStore, set } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormDefinitionSchema, type IsoInstant } from '@form/schema';
import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { addBlock, setTitle, updateBlock } from '@/state/actions';
import { undo } from '@/state/history';
import { updateOps } from '@/state/opsStore';
import { DOCUMENT_FORMAT, LEGACY_FORMAT, type StoredForm } from '@/persistence/DocumentRepository';
import { IndexedDbRepository } from '@/persistence/IndexedDbRepository';
import { AUTOSAVE_MS, discardPending, startAutosave } from '@/persistence/autosave';
import { importV1, newStoredForm, openStored } from '@/persistence/openForm';
import { watchTabs } from '@/persistence/tabChannel';
import { inlineDoc } from '@/lib/definition';
import { MemoryRepository, block, formWith, resetStore, v1Form } from '@/test/fixtures';

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
