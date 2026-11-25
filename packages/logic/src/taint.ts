import type { BlockId, CompiledForm, DataClassification, FormDefinition, PurposeId } from '@form/schema';
import { parseCell } from './cells.ts';
import type { StepGraph } from './plan.ts';

/*
 * Taint (I13, schema §3.3.10): a derived cell (a variable, a calculation, a captured or set value) carries
 * the highest classification and the union of purposes of every data cell it reads, transitively.
 * Lowering it needs an explicit `declassify` with a reason.
 *
 * A rule that writes a value (`set_value`, WP-2.01) taints its targets with every data cell its condition and its value
 * read: the written value, and whether it was written, carry them. Several writers of one cell (two rules setting the
 * same field) merge: the cell carries the highest classification and every purpose of any of them.
 */

const RANK: Record<DataClassification, number> = { none: 0, personal: 1, sensitive: 2 };
type Taint = { classification: DataClassification; purposeIds: PurposeId[] };

const DATA_CELLS = new Set(['value', 'var']);

export function taintOf(def: FormDefinition, graph: StepGraph, order: readonly number[]): CompiledForm['taint'] {
  const taint: Record<string, Taint> = {};
  const writtenBy = new Map<string, Taint>();
  const ownTaint = (blockId: string): Taint | null => {
    const block = def.blocks[blockId as BlockId];
    return block && 'compliance' in block ? { classification: block.compliance.classification, purposeIds: block.compliance.purposeIds } : null;
  };
  for (const s of order) {
    const step = graph.steps[s];
    if (!step || step.step.kind === 'on_path') continue;
    const written = step.writes.filter((c) => DATA_CELLS.has(parseCell(c).kind));
    if (!written.length) continue;
    const data = step.reads.filter((c) => DATA_CELLS.has(parseCell(c).kind));
    if (!data.length) continue;
    let classification: DataClassification = 'none';
    const purposes = new Set<PurposeId>();
    for (const c of data) {
      const parsed = parseCell(c);
      const sources = [writtenBy.get(c), parsed.kind === 'value' ? ownTaint(parsed.id) : null];
      for (const t of sources) {
        if (!t) continue;
        if (RANK[t.classification] > RANK[classification]) classification = t.classification;
        for (const p of t.purposeIds) purposes.add(p);
      }
    }
    for (const c of written) {
      const before = writtenBy.get(c);
      const merged: Taint = before
        ? {
          classification: RANK[before.classification] > RANK[classification] ? before.classification : classification,
          purposeIds: [...new Set([...before.purposeIds, ...purposes])].sort(),
        }
        : { classification, purposeIds: [...purposes].sort() };
      taint[c] = merged;
      writtenBy.set(c, merged);
    }
  }
  return taint;
}
