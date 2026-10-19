import { useEffect } from 'react';
import type { FormSchema } from '@/types/form';
import { useDocumentStore, useHistoryStore } from '@/state/documentStore';

/*
 * Undo history over the document store (zundo). Typing coalesces: consecutive commands with the same key (one block
 * path, or one form field) within COALESCE_MS of each other are one history step. Any other change, an undo or a redo
 * ends the run, so a structural change right after typing is its own step (B18).
 */

export const COALESCE_MS = 600;

let clock: () => number = () => Date.now();
let last: { key: string; at: number; doc: FormSchema } | null = null;

/** Tests pin the clock that decides whether typing coalesces. */
export function setHistoryClock(now: () => number): void {
  clock = now;
}

const temporal = () => useDocumentStore.temporal.getState();

/** Writes a new document as one history step, or folds it into the current typing run. */
export function commit(doc: FormSchema, key: string | null): void {
  const before = useDocumentStore.getState().doc;
  if (doc === before) return;
  const now = clock();
  const history = temporal();
  const merge = key !== null && history.isTracking && last !== null && last.key === key && last.doc === before && now - last.at < COALESCE_MS;
  if (merge) history.pause();
  useDocumentStore.setState({ doc });
  if (merge) history.resume();
  last = key === null ? null : { key, at: now, doc };
}

export function undo(): void {
  last = null;
  temporal().undo();
}

export function redo(): void {
  last = null;
  temporal().redo();
}

/** Opens a document: replaces it and starts with an empty history (loading is not an undoable change). */
export function loadDocument(doc: FormSchema): void {
  last = null;
  const history = temporal();
  history.pause();
  useDocumentStore.setState({ doc });
  history.resume();
  history.clear();
}

export function useCanUndo(): boolean {
  return useHistoryStore((s) => s.pastStates.length > 0);
}

export function useCanRedo(): boolean {
  return useHistoryStore((s) => s.futureStates.length > 0);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

/**
 * Mod+Z undoes, Mod+Shift+Z and Mod+Y redo, except while focus is in a text field or editor: those keys then belong
 * to the field's own text history (B22).
 */
export function useHistoryShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      if ((!isUndo && !isRedo) || isTyping(e.target)) return;
      e.preventDefault();
      if (isUndo) undo();
      else redo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
