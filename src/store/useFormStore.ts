import { create } from 'zustand';
import { useStore } from 'zustand';
import { temporal, type TemporalState } from 'zundo';
import type { BuilderMode, FieldType, FormBlock, FormSchema } from '@/types/form';
import { createBlock } from '@/lib/fields';
import { defaultSettings } from '@/lib/defaultSettings';
import { uid } from '@/lib/utils';

function emptyForm(id: string = uid()): FormSchema {
  return {
    id,
    title: '',
    description: '',
    blocks: [],
    settings: defaultSettings(),
  };
}

function reindex(blocks: FormBlock[]) {
  return blocks.map((b, i) => ({ ...b, order: i }));
}

let resumeTimer: ReturnType<typeof setTimeout> | undefined;
function pauseForTyping() {
  const temporalApi = useFormStore.temporal.getState();
  temporalApi.pause();
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => useFormStore.temporal.getState().resume(), 600);
}

interface FormStore {
  form: FormSchema;
  activeBlockId: string | null;
  inspectorOpen: boolean;
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
  mode: BuilderMode;
  sidebarOpen: boolean;
  started: boolean;
  insertFocusKey: number;
  setMode: (mode: BuilderMode) => void;
  setSidebarOpen: (open: boolean) => void;
  startBlank: () => void;
  requestInsertFocus: () => void;
  setActiveBlock: (id: string | null) => void;
  openInspector: (id: string) => void;
  closeInspector: () => void;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  addBlock: (type: FieldType, atIndex?: number) => string;
  placeBeside: (hostId: string, payload: { type: FieldType } | { id: string }) => void;
  updateBlock: (id: string, patch: Partial<FormBlock>) => void;
  deleteBlock: (id: string) => void;
  duplicateBlock: (id: string) => void;
  reorderBlocks: (fromIndex: number, toIndex: number) => void;
  loadTemplate: (schema: FormSchema) => void;
  updateSettings: (patch: Partial<FormSchema['settings']>) => void;
}

export const useFormStore = create<FormStore>()(
  temporal(
    (set, get) => ({
      form: emptyForm('demo'),
      activeBlockId: null,
      inspectorOpen: false,
      inspectorWidth: 400,
      setInspectorWidth: (inspectorWidth) => set({ inspectorWidth: Math.min(640, Math.max(280, inspectorWidth)) }),
      mode: 'edit',
      sidebarOpen: false,
      started: false,
      insertFocusKey: 0,
      startBlank: () => set({ started: true, activeBlockId: null, insertFocusKey: get().insertFocusKey + 1 }),
      requestInsertFocus: () => set((s) => ({ activeBlockId: null, insertFocusKey: s.insertFocusKey + 1 })),
      setMode: (mode) => set({ mode }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setActiveBlock: (id) => set({ activeBlockId: id }),
      openInspector: (id) => set({ activeBlockId: id, inspectorOpen: true }),
      closeInspector: () => set({ inspectorOpen: false }),
      setTitle: (title) => {
        pauseForTyping();
        set((s) => ({ form: { ...s.form, title } }));
      },
      setDescription: (description) => {
        pauseForTyping();
        set((s) => ({ form: { ...s.form, description } }));
      },
      addBlock: (type, atIndex) => {
        const { form } = get();
        const index = atIndex ?? form.blocks.length;
        const block = createBlock(type, index);
        const blocks = [...form.blocks];
        blocks.splice(index, 0, block);
        set({ form: { ...form, blocks: reindex(blocks) }, activeBlockId: block.id, started: true });
        return block.id;
      },
      updateBlock: (id, patch) => {
        pauseForTyping();
        set((s) => ({
          form: {
            ...s.form,
            blocks: s.form.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
          },
        }));
      },
      deleteBlock: (id) =>
        set((s) => ({
          form: { ...s.form, blocks: reindex(s.form.blocks.filter((b) => b.id !== id)) },
          activeBlockId: s.activeBlockId === id ? null : s.activeBlockId,
          inspectorOpen: s.activeBlockId === id ? false : s.inspectorOpen,
        })),
      duplicateBlock: (id) =>
        set((s) => {
          const index = s.form.blocks.findIndex((b) => b.id === id);
          if (index < 0) return s;
          const source = s.form.blocks[index];
          const copy: FormBlock = {
            ...source,
            id: uid(),
            options: source.options?.map((o) => ({ ...o, id: uid() })),
          };
          const blocks = [...s.form.blocks];
          blocks.splice(index + 1, 0, copy);
          return { form: { ...s.form, blocks: reindex(blocks) }, activeBlockId: copy.id };
        }),
      placeBeside: (hostId, payload) =>
        set((s) => {
          const blocks = [...s.form.blocks];
          const hostIndex = blocks.findIndex((b) => b.id === hostId);
          if (hostIndex < 0) return s;
          blocks[hostIndex] = {
            ...blocks[hostIndex],
            customize: { ...blocks[hostIndex].customize, width: 'half', besidePrevious: false },
          };
          let activeId = s.activeBlockId;
          if ('type' in payload) {
            const block = createBlock(payload.type, hostIndex + 1);
            block.customize = { ...block.customize, width: 'half', besidePrevious: true };
            blocks.splice(hostIndex + 1, 0, block);
            activeId = block.id;
          } else if (payload.id !== hostId) {
            const from = blocks.findIndex((b) => b.id === payload.id);
            if (from < 0) return s;
            const [moved] = blocks.splice(from, 1);
            const hostNow = blocks.findIndex((b) => b.id === hostId);
            moved.customize = { ...moved.customize, width: 'half', besidePrevious: true };
            blocks.splice(hostNow + 1, 0, moved);
            activeId = moved.id;
          }
          return { form: { ...s.form, blocks: reindex(blocks) }, activeBlockId: activeId, started: true };
        }),
      reorderBlocks: (fromIndex, toIndex) =>
        set((s) => {
          const blocks = [...s.form.blocks];
          const follower = blocks[fromIndex + 1];
          const [moved] = blocks.splice(fromIndex, 1);
          moved.customize = { ...moved.customize, besidePrevious: false };
          if (follower?.customize?.besidePrevious) {
            const fi = blocks.findIndex((b) => b.id === follower.id);
            if (fi >= 0) blocks[fi] = { ...blocks[fi], customize: { ...blocks[fi].customize, besidePrevious: false } };
          }
          blocks.splice(toIndex, 0, moved);
          return { form: { ...s.form, blocks: reindex(blocks) } };
        }),
      loadTemplate: (schema) =>
        set({
          form: {
            ...schema,
            id: get().form.id,
            blocks: schema.blocks.map((b) => ({ ...b, options: b.options?.map((o) => ({ ...o })) })),
          },
          activeBlockId: null,
          inspectorOpen: false,
          started: true,
        }),
      updateSettings: (patch) => {
        pauseForTyping();
        set((s) => ({ form: { ...s.form, settings: { ...s.form.settings, ...patch } } }));
      },
    }),
    {
      limit: 50,
      partialize: (state) => ({ form: state.form }) as FormStore,
    },
  ),
);

export function useTemporalStore<T>(selector: (state: TemporalState<FormStore>) => T) {
  return useStore(useFormStore.temporal, selector);
}
