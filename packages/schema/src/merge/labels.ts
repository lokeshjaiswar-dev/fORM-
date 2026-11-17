import type { FieldBlock, StoredBlock } from '../v2/blocks.ts';
import type { InlineDoc, LabelText, RichDoc } from '../v2/rich-text.ts';
import { toPlain } from '../richtext/toPlain.ts';

export function normalizeLabel(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function plainLabelText(value: LabelText | InlineDoc | RichDoc | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('');
  return toPlain(value);
}

export const isFieldBlock = (block: StoredBlock | undefined): block is FieldBlock =>
  block !== undefined && block.type !== 'unsupported' && 'compliance' in block;

export function fieldMatchKey(block: FieldBlock): string {
  return `${normalizeLabel(plainLabelText(block.label))}::${block.type}`;
}

export function parseMatchKey(key: string): { label: string; type: string } {
  const at = key.lastIndexOf('::');
  return { label: key.slice(0, at), type: key.slice(at + 2) };
}
