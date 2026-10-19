import { createBlock } from '@/lib/fields';
import type { FieldType, FormBlock, FormSchema, FormSettings } from '@/types/form';
import { dispatch, type CommandResult } from '@/state/commands/dispatch';
import { rulesReading } from '@/state/commands/blocks';
import type { BlockPatch, RuleFate } from '@/state/commands/types';
import { currentDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';

/*
 * What the builder UI calls: each action dispatches one command, then moves the selection, and returns the command's
 * result. The selection lives in the UI store, so it never enters undo history.
 */

const ui = () => useUiStore.getState();

export function setTitle(title: string): CommandResult {
  return dispatch({ type: 'set_title', title });
}

export function updateSettings(patch: Partial<FormSettings>): CommandResult {
  return dispatch({ type: 'update_settings', patch });
}

/** Adds a block of `type` (at the end by default), selects it and returns its id. */
export function addBlock(type: FieldType, atIndex?: number, patch?: Partial<FormBlock>): string {
  const index = atIndex ?? currentDoc().blocks.length;
  const block = { ...createBlock(type, index), ...patch };
  const result = dispatch({ type: 'add_block', block, index });
  if (!result.ok) return '';
  useUiStore.setState({ activeBlockId: block.id, started: true });
  return block.id;
}

export function updateBlock(id: string, patch: BlockPatch): CommandResult {
  return dispatch({ type: 'update_block', id, patch });
}

export function setBlockWidth(id: string, width: 'full' | 'half'): CommandResult {
  return dispatch({ type: 'set_width', id, width });
}

export function deleteBlock(id: string, rules: RuleFate = 'disable'): CommandResult {
  const result = dispatch({ type: 'delete_block', id, rules });
  if (!result.ok) return result;
  const { activeBlockId, pendingDelete } = ui();
  useUiStore.setState({
    ...(activeBlockId === id ? { activeBlockId: null, inspectorOpen: false } : {}),
    ...(pendingDelete === id ? { pendingDelete: null } : {}),
  });
  return result;
}

/** Deletes at once, or first asks what to do with the rules that read the block (B21). */
export function requestDeleteBlock(id: string): void {
  if (rulesReading(currentDoc().blocks, id).length) ui().setPendingDelete(id);
  else deleteBlock(id);
}

export function duplicateBlock(id: string): CommandResult {
  const result = dispatch({ type: 'duplicate_block', id });
  if (result.ok && result.created) ui().setActiveBlock(result.created);
  return result;
}

export function moveBlock(from: number, to: number): CommandResult {
  return dispatch({ type: 'move_block', from, to });
}

export function placeBeside(hostId: string, payload: { type: FieldType } | { id: string }): CommandResult {
  const index = currentDoc().blocks.findIndex((b) => b.id === hostId) + 1;
  const source = 'type' in payload ? { block: createBlock(payload.type, index) } : payload;
  const result = dispatch({ type: 'place_beside', hostId, source });
  if (result.ok) useUiStore.setState({ activeBlockId: result.created ?? ui().activeBlockId, started: true });
  return result;
}

/** Replaces the whole form (a template) and keeps its id; one undoable step. */
export function replaceDocument(doc: FormSchema): CommandResult {
  const result = dispatch({ type: 'replace_document', doc: { ...doc, id: currentDoc().id } });
  if (result.ok) useUiStore.setState({ activeBlockId: null, inspectorOpen: false, started: true });
  return result;
}
