import type { BlockId, CompiledForm, DataClassification, FormDefinition, PurposeId } from '@form/schema';
import { parseCell } from './cells.ts';
import type { StepGraph } from './plan.ts';

/*
 * Taint (I13, schema §3.3.10): a derived cell (a variable, a calculation, a captured or set value) carries
 * the highest classification and the union of purposes of every data cell it reads, transitively.
 * Lowering it needs an explicit `declassify` with a reason.
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
    if (!step || step.step.kind === 'rule' || step.step.kind === 'on_path') continue;
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
    const entry: Taint = { classification, purposeIds: [...purposes].sort() };
    for (const c of step.writes) {
      if (!DATA_CELLS.has(parseCell(c).kind)) continue;
      taint[c] = entry;
      writtenBy.set(c, entry);
    }
  }
  return taint;
}
