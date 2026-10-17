import type { FieldType, FormBlock, FormSchema } from '@/types/form';
import { defaultSettings } from '@/lib/defaultSettings';
import { useFormStore } from '@/store/useFormStore';

export function block(type: FieldType, patch: Partial<FormBlock> = {}): FormBlock {
  return { id: type, type, label: '', order: 0, ...patch };
}

export function formWith(blocks: FormBlock[]): FormSchema {
  return {
    id: 'test',
    title: 'Test form',
    description: '',
    blocks: blocks.map((b, i) => ({ ...b, order: i })),
    settings: { ...defaultSettings(), successAnimation: false },
  };
}

export function resetStore(blocks: FormBlock[] = []) {
  useFormStore.temporal.getState().resume();
  useFormStore.setState({
    form: formWith(blocks),
    activeBlockId: null,
    inspectorOpen: false,
    mode: 'edit',
    started: true,
  });
  useFormStore.temporal.getState().clear();
}
