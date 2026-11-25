import { REGISTRY } from '@form/registry';
import type { BlockId, FieldBlock, FieldBlockOf, UniqueIdConfig } from '@form/schema';
import { replaceDocument } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';

/** An auto-increment number: 1, 2, 3 … with no prefix or padding, starting at 1 and never reset. */
export const AUTO_INCREMENT: UniqueIdConfig = { prefix: [], padTo: 1, startAt: 1, resetEvery: 'never', showOnEnding: false };

/**
 * Turns a number field into an auto-numbered one (the serial `unique_id` type) or back, keeping its place, key, label,
 * description, look and privacy settings, in one undoable step. What only makes sense for a typed answer is dropped:
 * required, read-only, uniqueness, an API check and custom messages (a serial is assigned, never typed).
 */
export function switchFieldType(id: BlockId, to: 'number' | 'unique_id'): void {
  const doc = currentDoc();
  const block = doc.blocks[id] as FieldBlock | undefined;
  if (!block || (block.type !== 'number' && block.type !== 'unique_id') || block.type === to) return;
  const { type: _type, config: _config, required: _required, readOnly: _readOnly, unique: _unique, apiValidation: _api, messages: _messages, ...kept } = block;
  const next =
    to === 'unique_id'
      ? ({ ...kept, type: 'unique_id', required: false, config: { ...AUTO_INCREMENT } } as FieldBlockOf<'unique_id'>)
      : ({ ...kept, type: 'number', required: false, config: REGISTRY.number.defaultConfig(doc.i18n.defaultLocale) } as FieldBlockOf<'number'>);
  const result = replaceDocument({ ...doc, blocks: { ...doc.blocks, [id]: next } });
  /* Replacing the document closes the panel; the author is still editing this block, so keep it open on it. */
  if (result.ok) useUiStore.getState().openInspector(id);
}
