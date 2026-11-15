import { valueDefinition } from '@form/registry';
import { toPlain, type Answers, type BlockId, type FieldBlock, type FormDefinition, type StoredBlock, type ValueFieldType } from '@form/schema';
import { storableText } from './text-safety.ts';

/** One line of a response as the Responses page lists it: the field's label and its answer as readable text. */
export interface DisplayRow {
  key: string;
  label: string;
  value: string;
}

const MAX_ROWS = 500;
const MAX_LABEL = 1000;
const MAX_VALUE = 10_000;

const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && 'compliance' in block;

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** Every placed block id in document order: the pages, then each container's children depth-first. */
function blockOrder(definition: FormDefinition): BlockId[] {
  const out: BlockId[] = [];
  const seen = new Set<BlockId>();
  const visit = (id: BlockId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    childrenOf(definition.blocks[id]).forEach(visit);
  };
  for (const page of definition.pages) page.children.forEach(visit);
  return out;
}

function readable(block: FieldBlock, value: unknown): string {
  try {
    const text = (valueDefinition(block.type as ValueFieldType).export.text as (v: unknown, b: unknown) => string)(value, block);
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The rows the server stores and shows for a response, built from the answers it validated and the version they were
 * validated against: the label is the field's own label, the text is what the field type's export says. The page's
 * own rows are never used (it can send any label and any value, such as "Approved by HR: Yes", next to answers that
 * say nothing of the kind), so a response can only show what the form asked and what was answered.
 */
export function displayRows(definition: FormDefinition, values: Answers): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const id of blockOrder(definition)) {
    const block = definition.blocks[id];
    if (!isField(block)) continue;
    const answer = (values as Record<string, { value?: unknown } | undefined>)[block.id];
    if (!answer) continue;
    rows.push({
      key: storableText(block.key),
      label: storableText(clip(toPlain(block.label).trim() || block.key, MAX_LABEL)),
      value: storableText(clip(readable(block, answer.value), MAX_VALUE)),
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}
