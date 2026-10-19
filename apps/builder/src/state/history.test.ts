import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AvailableType } from '@form/registry';
import type { BlockId, ChoiceOption, FormDefinition, OptionId, PageId } from '@form/schema';
import { addBlock, setTitle, updateBlock } from '@/state/actions';
import { dispatch } from '@/state/commands/dispatch';
import type { Command } from '@/state/commands/types';
import { HISTORY_LIMIT, useDocumentStore } from '@/state/documentStore';
import { COALESCE_MS, loadDocument, redo, setHistoryClock, undo } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { blockOrder, inlineDoc } from '@/lib/definition';
import { block, blockIds, counter, doc, formWith, resetStore } from '@/test/fixtures';

const history = () => useDocumentStore.temporal.getState();
const SHORT = { type: 'short_text', configOverrides: {} } as const;
const label = (id: string) => (doc().blocks[id as BlockId] as { label?: unknown }).label;
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
    const id = addBlock(SHORT) as BlockId;
    history().clear();
    for (const text of ['N', 'Na', 'Nam']) {
      tick(100);
      updateBlock(id, { label: inlineDoc(text) });
    }
    expect(history().pastStates).toHaveLength(1);
    expect(history().pastStates[0]?.doc?.blocks[id]).toMatchObject({ label: inlineDoc('') });
    dispatch({ type: 'delete_block', id, rules: 'disable' });
    expect(history().pastStates).toHaveLength(2);
    expect(history().pastStates[1]?.doc?.blocks[id]).toMatchObject({ label: inlineDoc('Nam') });
  });

  it(`starts a new step after a ${COALESCE_MS} ms pause, in another field, or after an undo`, () => {
    const id = addBlock(SHORT) as BlockId;
    history().clear();
    updateBlock(id, { label: inlineDoc('N') });
    tick(COALESCE_MS);
    updateBlock(id, { label: inlineDoc('Na') });
    updateBlock(id, { hideLabel: true });
    setTitle('T');
    expect(history().pastStates).toHaveLength(4);
    undo();
    setTitle('U');
    expect(history().pastStates).toHaveLength(4);
    expect(history().futureStates).toHaveLength(0);
  });

  it('typing in two blocks makes two steps even within the window', () => {
    resetStore([block('short_text', 'a'), block('short_text', 'b')]);
    updateBlock('a' as BlockId, { label: inlineDoc('x') });
    updateBlock('b' as BlockId, { label: inlineDoc('y') });
    updateBlock('a' as BlockId, { label: inlineDoc('xx') });
    expect(history().pastStates).toHaveLength(3);
  });

  it('typing an option label, then removing an option within the window, makes two steps', () => {
    const options = (...labels: string[]): ChoiceOption[] => labels.map((l, i) => ({ id: `o${i + 1}` as OptionId, label: l }));
    resetStore([block('single_choice', 'c', { config: { display: 'radio', options: options('A', 'B') } })]);
    const labels = () => (doc().blocks['c' as BlockId] as { config: { options: ChoiceOption[] } }).config.options.map((o) => o.label);
    const set = (opts: ChoiceOption[]) => updateBlock('c' as BlockId, { config: { display: 'radio', options: opts } });
    set(options('Ab', 'B'));
    tick(100);
    set(options('Abc', 'B'));
    tick(100);
    set(options('Abc'));
    expect(history().pastStates).toHaveLength(2);
    undo();
    expect(labels()).toEqual(['Abc', 'B']);
    undo();
    expect(labels()).toEqual(['A', 'B']);
  });

  it('loading a document starts an empty history that cannot undo the load', () => {
    addBlock(SHORT);
    loadDocument(formWith([block('email', 'm')]));
    expect(history().pastStates).toHaveLength(0);
    undo();
    expect(blockIds()).toEqual(['m']);
  });

  it('random command sequences: undo^n then redo^n returns the same documents; UI changes never enter history', () => {
    const types: AvailableType[] = ['short_text', 'email', 'single_choice', 'rating', 'heading'];
    const step = fc.oneof(
      fc.record({ kind: fc.constant('add' as const), type: fc.constantFrom(...types), at: fc.nat() }),
      fc.record({ kind: fc.constant('type' as const), at: fc.nat(), text: fc.string({ maxLength: 4 }), gap: fc.integer({ min: 0, max: 2 * COALESCE_MS }) }),
      fc.record({ kind: fc.constant('title' as const), text: fc.string({ maxLength: 4 }), gap: fc.integer({ min: 0, max: 2 * COALESCE_MS }) }),
      fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), remove: fc.boolean() }),
      fc.record({ kind: fc.constant('duplicate' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('move' as const), from: fc.nat(), to: fc.nat() }),
      fc.record({ kind: fc.constant('beside' as const), host: fc.nat(), other: fc.nat() }),
      fc.record({ kind: fc.constant('break' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('merge' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('ui' as const), at: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        resetStore([block('short_text', 'seed', { label: 'Seed' })]);
        const ids = counter('b');
        const start = doc();
        const states: FormDefinition[] = [start];
        /* The model of coalescing, kept apart from history.ts: a typing step joins the previous one only when it has
         * the same key and comes within COALESCE_MS of it, with nothing else in between. */
        let run = null as { key: string; at: number } | null;
        for (const s of steps) {
          const order = blockOrder(doc());
          const page = doc().pages[0] as FormDefinition['pages'][number];
          const pick = (i: number) => order[i % Math.max(1, order.length)] as BlockId;
          const labelled = order.filter((b) => 'label' in (doc().blocks[b] ?? {}));
          let command: Command | null = null;
          if (s.kind === 'ui') {
            useUiStore.getState().openInspector(pick(s.at));
            useUiStore.getState().setSidebarOpen(s.at % 2 === 0);
          } else if (s.kind === 'add') {
            const added = block(s.type, ids.newId(), { key: `k_${ids.newId()}` });
            command = { type: 'apply_ops', ops: [{ op: 'add_block', block: added, parent: { pageId: page.id }, index: s.at % (page.children.length + 1) }] };
          } else if (s.kind === 'type' && labelled.length) {
            tick(s.gap);
            command = { type: 'update_block', id: labelled[s.at % labelled.length] as BlockId, patch: { label: inlineDoc(s.text) } };
          } else if (s.kind === 'title') {
            tick(s.gap);
            command = { type: 'set_title', title: s.text };
          } else if (s.kind === 'delete' && order.length) {
            command = { type: 'delete_block', id: pick(s.at), rules: s.remove ? 'remove' : 'disable' };
          } else if (s.kind === 'duplicate' && order.length) {
            command = { type: 'duplicate_block', id: pick(s.at) };
          } else if (s.kind === 'move' && page.children.length) {
            const moved = page.children[s.from % page.children.length] as BlockId;
            command = { type: 'move_block', id: moved, to: { pageId: page.id, index: s.to % page.children.length } };
          } else if (s.kind === 'beside' && order.length && pick(s.host) !== pick(s.other)) {
            command = { type: 'place_beside', hostId: pick(s.host), source: { id: pick(s.other) } };
          } else if (s.kind === 'break') {
            command = { type: 'split_page', pageId: page.id, index: s.at % (page.children.length + 1), newPageId: ids.newId() as PageId };
          } else if (s.kind === 'merge' && doc().pages.length > 1) {
            command = { type: 'merge_page', pageId: (doc().pages[1 + (s.at % (doc().pages.length - 1))] as { id: PageId }).id };
          }
          if (!command) continue;
          const before = doc();
          const result = dispatch(command, ids);
          expect(result.ok, result.ok ? '' : result.error).toBe(true);
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
        expect(label('seed')).toEqual(inlineDoc('Seed'));
        for (let i = 0; i < depth; i += 1) redo();
        expect(doc()).toEqual(end);
      }),
      { numRuns: 120 },
    );
  });
});
