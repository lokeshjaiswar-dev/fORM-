import { create, useStore } from 'zustand';
import { temporal, type TemporalState } from 'zundo';
import type { BlockId, FormDefinition, StoredBlock } from '@form/schema';
import { blankDefinition } from '@/lib/definition';

/*
 * The document store holds the v2 definition being edited and nothing else, so undo history (zundo) only ever records
 * document changes (B17). It is written only through the command layer (`commands/dispatch.ts`) and by
 * `loadDocument`. Commands are immer recipes, so an edit shares every untouched object with the previous document:
 * components select the part they show (`useBlock`) and re-render only when that part changes (FND-13).
 */

export interface DocumentState {
  doc: FormDefinition;
}

export const HISTORY_LIMIT = 100;

const counter = () => {
  let n = 0;
  return { newId: () => `blank_${(n += 1)}` };
};

export const useDocumentStore = create<DocumentState>()(
  temporal(() => ({ doc: blankDefinition('blank', counter()) }), {
    limit: HISTORY_LIMIT,
    partialize: (state) => ({ doc: state.doc }),
    equality: (a, b) => a.doc === b.doc,
  }),
);

/** The document as of now, outside React. */
export const currentDoc = (): FormDefinition => useDocumentStore.getState().doc;

/** Reads part of the document in a component; re-renders only when the selected value changes. */
export function useDoc<T>(selector: (doc: FormDefinition) => T): T {
  return useDocumentStore((state) => selector(state.doc));
}

/** One block; the component re-renders only when this block changes (per-block selector). */
export function useBlock(id: BlockId): StoredBlock | undefined {
  return useDocumentStore((state) => state.doc.blocks[id]);
}

export function useHistoryStore<T>(selector: (state: TemporalState<DocumentState>) => T): T {
  return useStore(useDocumentStore.temporal, selector);
}
