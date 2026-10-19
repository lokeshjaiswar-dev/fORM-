import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addBlock, setTitle, updateBlock } from '@/state/actions';
import { dispatch } from '@/state/commands/dispatch';
import type { Command } from '@/state/commands/types';
import { HISTORY_LIMIT, useDocumentStore } from '@/state/documentStore';
import { COALESCE_MS, loadDocument, redo, setHistoryClock, undo } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { block, doc, formWith, resetStore } from '@/test/fixtures';
import type { FieldType, FormSchema } from '@/types/form';

const history = () => useDocumentStore.temporal.getState();
let now = 0;
const tick = (ms: number) => {
  now += ms;
};

beforeEach(() => {
  now = 0;
  setHistoryClock(() => now);
  resetStore();
});

afterEach(() => setHistoryClock(() => Date.now()));

describe('history', () => {
  it('coalesces consecutive typing in one field into one history step', () => {
    const id = addBlock('text');
    history().clear();
    for (const label of ['N', 'Na', 'Nam']) {
      tick(100);
      updateBlock(id, { label });
    }
    expect(history().pastStates).toHaveLength(1);
    expect(history().pastStates[0].doc?.blocks[0].label).toBe('');
    dispatch({ type: 'delete_block', id, rules: 'disable' });
    expect(history().pastStates).toHaveLength(2);
    expect(history().pastStates[1].doc?.blocks[0].label).toBe('Nam');
  });

  it(`starts a new step after a ${COALESCE_MS} ms pause, in another field, or after an undo`, () => {
    const id = addBlock('text');
    history().clear();
    updateBlock(id, { label: 'N' });
    tick(COALESCE_MS);
    updateBlock(id, { label: 'Na' });
    updateBlock(id, { placeholder: 'x' });
    setTitle('T');
    expect(history().pastStates).toHaveLength(4);
    undo();
    setTitle('U');
    expect(history().pastStates).toHaveLength(4);
    expect(history().futureStates).toHaveLength(0);
  });

  it('typing in two blocks makes two steps even within the window', () => {
    resetStore([block('text', { id: 'a' }), block('text', { id: 'b' })]);
    updateBlock('a', { label: 'x' });
    updateBlock('b', { label: 'y' });
    updateBlock('a', { label: 'xx' });
    expect(history().pastStates).toHaveLength(3);
  });

  it('typing an option label, then removing an option within the window, makes two steps', () => {
    resetStore([block('dropdown', { id: 'c', options: [{ id: 'o1', label: 'A', value: 'a' }, { id: 'o2', label: 'B', value: 'b' }] })]);
    const labels = () => doc().blocks[0].options?.map((o) => o.label);
    updateBlock('c', { options: [{ id: 'o1', label: 'Ab', value: 'a' }, { id: 'o2', label: 'B', value: 'b' }] });
    tick(100);
    updateBlock('c', { options: [{ id: 'o1', label: 'Abc', value: 'a' }, { id: 'o2', label: 'B', value: 'b' }] });
    tick(100);
    updateBlock('c', { options: [{ id: 'o1', label: 'Abc', value: 'a' }] });
    expect(history().pastStates).toHaveLength(2);
    undo();
    expect(labels()).toEqual(['Abc', 'B']);
    undo();
    expect(labels()).toEqual(['A', 'B']);
  });

  it('loading a document starts an empty history that cannot undo the load', () => {
    addBlock('text');
    loadDocument(formWith([block('email', { id: 'm' })]));
    expect(history().pastStates).toHaveLength(0);
    undo();
    expect(doc().blocks.map((b) => b.id)).toEqual(['m']);
  });

  it('random command sequences: undo^n then redo^n returns the same documents; UI changes never enter history', () => {
    const types: FieldType[] = ['text', 'email', 'dropdown', 'page_break', 'rating'];
    const step = fc.oneof(
      fc.record({ kind: fc.constant('add' as const), type: fc.constantFrom(...types), at: fc.nat() }),
      fc.record({ kind: fc.constant('type' as const), at: fc.nat(), text: fc.string({ maxLength: 4 }), gap: fc.integer({ min: 0, max: 2 * COALESCE_MS }) }),
      fc.record({ kind: fc.constant('title' as const), text: fc.string({ maxLength: 4 }), gap: fc.integer({ min: 0, max: 2 * COALESCE_MS }) }),
      fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), remove: fc.boolean() }),
      fc.record({ kind: fc.constant('duplicate' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('move' as const), from: fc.nat(), to: fc.nat() }),
      fc.record({ kind: fc.constant('beside' as const), host: fc.nat(), other: fc.nat() }),
      fc.record({ kind: fc.constant('ui' as const), at: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        resetStore([block('text', { id: 'seed', label: 'Seed' })]);
        let n = 0;
        const ids = { newId: () => `b${(n += 1)}` };
        const start = doc();
        const states: FormSchema[] = [start];
        /* The model of coalescing, kept apart from history.ts: a typing step joins the previous one only when it has
         * the same key and comes within COALESCE_MS of it, with nothing else in between. */
        let run = null as { key: string; at: number } | null;
        for (const s of steps) {
          const blocks = doc().blocks;
          const pick = (i: number) => blocks[i % Math.max(1, blocks.length)];
          let command: Command | null = null;
          if (s.kind === 'ui') {
            const target = pick(s.at);
            useUiStore.getState().openInspector(target?.id ?? '');
            useUiStore.getState().setSidebarOpen(s.at % 2 === 0);
          } else if (s.kind === 'add') {
            command = { type: 'add_block', block: block(s.type, { id: ids.newId() }), index: s.at % (blocks.length + 1) };
          } else if (s.kind === 'type' && blocks.length) {
            tick(s.gap);
            command = { type: 'update_block', id: pick(s.at).id, patch: { label: s.text } };
          } else if (s.kind === 'title') {
            tick(s.gap);
            command = { type: 'set_title', title: s.text };
          } else if (s.kind === 'delete' && blocks.length) {
            command = { type: 'delete_block', id: pick(s.at).id, rules: s.remove ? 'remove' : 'disable' };
          } else if (s.kind === 'duplicate' && blocks.length) {
            command = { type: 'duplicate_block', id: pick(s.at).id };
          } else if (s.kind === 'move' && blocks.length) {
            command = { type: 'move_block', from: s.from % blocks.length, to: s.to % blocks.length };
          } else if (s.kind === 'beside' && blocks.length && pick(s.host).id !== pick(s.other).id) {
            command = { type: 'place_beside', hostId: pick(s.host).id, source: { id: pick(s.other).id } };
          }
          if (!command) continue;
          const before = doc();
          expect(dispatch(command, ids).ok).toBe(true);
          if (doc() !== before) {
            const key = command.type === 'update_block' ? `label:${command.id}` : command.type === 'set_title' ? 'title' : null;
            if (key !== null && run?.key === key && now - run.at < COALESCE_MS) states[states.length - 1] = doc();
            else states.push(doc());
            run = key === null ? null : { key, at: now };
          }
          if (s.kind !== 'type' && s.kind !== 'title') tick(COALESCE_MS);
        }
        const end = doc();
        const depth = history().pastStates.length;
        expect(depth).toBe(states.length - 1);
        expect(depth).toBeLessThanOrEqual(HISTORY_LIMIT);
        for (let i = depth; i > 0; i -= 1) {
          undo();
          expect(doc()).toEqual(states[i - 1]);
        }
        expect(doc()).toEqual(start);
        for (let i = 0; i < depth; i += 1) redo();
        expect(doc()).toEqual(end);
      }),
      { numRuns: 150 },
    );
  });
});
