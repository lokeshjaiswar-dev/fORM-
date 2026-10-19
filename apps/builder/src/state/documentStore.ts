import { create, useStore } from 'zustand';
import { temporal, type TemporalState } from 'zundo';
import { defaultSettings } from '@/lib/defaultSettings';
import type { FormSchema } from '@/types/form';

/*
 * The document store holds the form being edited and nothing else, so undo history (zundo) only ever records
 * document changes (B17). It is written only through the command layer (`commands/dispatch.ts`) and by
 * `loadDocument`. The document is the v1 shape the builder UI still edits; WP-0.11b swaps it for a v2 definition.
 */

export interface DocumentState {
  doc: FormSchema;
}

export const HISTORY_LIMIT = 100;

export function emptyForm(id: string): FormSchema {
  return { id, title: '', description: '', blocks: [], settings: defaultSettings() };
}

export const useDocumentStore = create<DocumentState>()(
  temporal(() => ({ doc: emptyForm('') }), {
    limit: HISTORY_LIMIT,
    partialize: (state) => ({ doc: state.doc }),
    equality: (a, b) => a.doc === b.doc,
  }),
);

/** The document as of now, outside React. */
export const currentDoc = (): FormSchema => useDocumentStore.getState().doc;

/** Reads part of the document in a component; re-renders only when the selected value changes. */
export function useDoc<T>(selector: (doc: FormSchema) => T): T {
  return useDocumentStore((state) => selector(state.doc));
}

export function useHistoryStore<T>(selector: (state: TemporalState<DocumentState>) => T): T {
  return useStore(useDocumentStore.temporal, selector);
}
