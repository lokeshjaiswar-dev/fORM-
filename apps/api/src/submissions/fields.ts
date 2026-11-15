import { valueDefinition } from '@form/registry';
import type { BlockId, CompiledForm, FieldBlock, FormDefinition, StoredBlock, ValueFieldType } from '@form/schema';

/** `CompiledForm.taint` of a version: the highest classification a derived cell carries, by cell (`value:<blockId>`, `var:<id>`). */
export type Taint = CompiledForm['taint'];

const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && 'compliance' in block;

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** The placed field blocks of a definition in document order: the pages, then each container's children depth-first. */
export function fieldBlocksOf(definition: FormDefinition): FieldBlock[] {
  const out: FieldBlock[] = [];
  const seen = new Set<BlockId>();
  const visit = (id: BlockId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const block = definition.blocks[id];
    if (isField(block)) out.push(block);
    childrenOf(block).forEach(visit);
  };
  for (const page of definition.pages) page.children.forEach(visit);
  return out;
}

/**
 * Whether the answer to a block must stay out of text the server hands to a reader or to the search index: the field
 * is `encrypt` or `sensitive`; its value is derived (a calculation, a set value) from a sensitive one (the version's
 * taint, I13); or it is a repeating group with such a field among its children, because a group's text is the text of
 * its rows' values, whatever their own classification.
 */
export function isProtected(block: FieldBlock, definition: FormDefinition, taint: Taint | undefined, seen: Set<BlockId> = new Set()): boolean {
  if (block.compliance.encrypt || block.compliance.classification === 'sensitive') return true;
  if (taint?.[`value:${block.id}`]?.classification === 'sensitive') return true;
  if (block.type !== 'repeating_group' || seen.has(block.id)) return false;
  seen.add(block.id);
  return block.config.children.some((id) => {
    const child = definition.blocks[id];
    return isField(child) && isProtected(child, definition, taint, seen);
  });
}

/** What the field type's export says an answer reads as, in one line of text; an answer it cannot read is the empty string. */
export function exportText(block: FieldBlock, value: unknown): string {
  try {
    const text = (valueDefinition(block.type as ValueFieldType).export.text as (v: unknown, b: unknown) => string)(value, block);
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}
