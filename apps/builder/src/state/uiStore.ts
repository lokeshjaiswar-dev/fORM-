import { create } from 'zustand';

/*
 * Builder UI state: selection, panels, dialogs and session banners. None of it is part of the document, so none of
 * it reaches undo history (B17) or storage. The edit/preview mode is not here: the URL is its only source (B23).
 */

/** A note shown after a load or an import: a repair of the stored document, or what the v2 migration changes. */
export interface LoadNote {
  code: string;
  path: string;
  detail: string;
}

/** Another tab has this form open, or saved it after this tab loaded it. */
export type TabConflict = 'open_elsewhere' | 'saved_elsewhere';

export type SaveState = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: string } | { state: 'error'; message: string };

export interface UiState {
  activeBlockId: string | null;
  inspectorOpen: boolean;
  inspectorWidth: number;
  sidebarOpen: boolean;
  started: boolean;
  insertFocusKey: number;
  /** A block whose delete waits for the author to choose what happens to the rules that read it. */
  pendingDelete: string | null;
  notes: LoadNote[];
  conflict: TabConflict | null;
  save: SaveState;
  setActiveBlock: (id: string | null) => void;
  openInspector: (id: string) => void;
  closeInspector: () => void;
  setInspectorWidth: (width: number) => void;
  setSidebarOpen: (open: boolean) => void;
  startBlank: () => void;
  requestInsertFocus: () => void;
  setPendingDelete: (id: string | null) => void;
  dismissNotes: () => void;
  dismissConflict: () => void;
}

export const INITIAL_UI = {
  activeBlockId: null,
  inspectorOpen: false,
  inspectorWidth: 400,
  sidebarOpen: false,
  started: false,
  insertFocusKey: 0,
  pendingDelete: null,
  notes: [],
  conflict: null,
  save: { state: 'idle' },
} satisfies Partial<UiState>;

export const useUiStore = create<UiState>()((set) => ({
  ...INITIAL_UI,
  setActiveBlock: (activeBlockId) => set({ activeBlockId }),
  openInspector: (id) => set({ activeBlockId: id, inspectorOpen: true }),
  closeInspector: () => set({ inspectorOpen: false }),
  setInspectorWidth: (width) => set({ inspectorWidth: Math.min(640, Math.max(280, width)) }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  startBlank: () => set((s) => ({ started: true, activeBlockId: null, insertFocusKey: s.insertFocusKey + 1 })),
  requestInsertFocus: () => set((s) => ({ activeBlockId: null, insertFocusKey: s.insertFocusKey + 1 })),
  setPendingDelete: (pendingDelete) => set({ pendingDelete }),
  dismissNotes: () => set({ notes: [] }),
  dismissConflict: () => set({ conflict: null }),
}));

/** A fresh UI for a newly opened form; the sidebar width and visibility are kept. */
export function resetUi(patch: Partial<Pick<UiState, 'started' | 'notes'>> = {}): void {
  useUiStore.setState((s) => ({ ...INITIAL_UI, inspectorWidth: s.inspectorWidth, sidebarOpen: s.sidebarOpen, ...patch }));
}
