import type { BlockId, PublishIssue } from '@form/schema';
import { PAGE_SCOPED, parseCell } from './cells.ts';
import type { StepGraph } from './plan.ts';
import type { Placement } from './structure.ts';

/*
 * Page-order rule (I8, schema §3.3.5): a step that writes visible, enabled, required, optionHidden, jump or
 * submitBlock for page P may only read cells on pages ≤ P, transitively through every cell it reads.
 * Validation bounds that reference another block obey the same rule (validation_bound_page_order).
 */

interface Reach { page: number; chain: string[] }
const NOWHERE: Reach = { page: -1, chain: [] };

/** Page index of a cell, or -1 for cells that belong to no page (variables, the ending, server effects). */
export function cellPage(placement: Placement, key: string): number {
  const { kind, id } = parseCell(key);
  switch (kind) {
    case 'visible':
    case 'enabled':
    case 'required':
    case 'value':
    case 'optionHidden': {
      const page = placement.pageIndex.get(id) ?? placement.pageIndex.get(placement.pageOf[id as BlockId] ?? '');
      return page ?? -1;
    }
    case 'onPath':
    case 'jump':
      return placement.pageIndex.get(id) ?? -1;
    case 'submitBlock':
      return id === 'form' ? Number.POSITIVE_INFINITY : (placement.pageIndex.get(id) ?? -1);
    default:
      return -1;
  }
}

const pageName = (placement: Placement, page: number) => {
  for (const [id, index] of placement.pageIndex) if (index === page) return `page ${page + 1} (${id})`;
  return `page ${page + 1}`;
};

export interface PageOrder {
  /** Farthest page each step reads, transitively, with the cells and steps that lead there. */
  reach: ReadonlyArray<Reach>;
  issues: PublishIssue[];
}

function reachOf(graph: StepGraph, placement: Placement, reach: ReadonlyArray<Reach | undefined>, reads: readonly string[], self = -1): Reach {
  let best = NOWHERE;
  /* On a tie, name the answer that is read rather than the visibility or path cells it implies. */
  const better = (page: number, c: string) => page > best.page
    || (page === best.page && page >= 0 && parseCell(c).kind === 'value' && best.chain.length === 1 && parseCell(best.chain[0] ?? '').kind !== 'value');
  for (const c of reads) {
    const page = cellPage(placement, c);
    if (better(page, c)) best = { page, chain: [c] };
    for (const w of graph.writersOf.get(c) ?? []) {
      const r = w === self ? undefined : reach[w];
      if (r && r.page > best.page) best = { page: r.page, chain: [c, graph.steps[w]?.key ?? '', ...r.chain] };
    }
  }
  return best;
}

export function pageOrder(graph: StepGraph, order: readonly number[], placement: Placement): PageOrder {
  const reach: Array<Reach | undefined> = graph.steps.map(() => undefined);
  const issues: PublishIssue[] = [];
  for (const s of order) {
    const step = graph.steps[s];
    if (!step) continue;
    const r = reachOf(graph, placement, reach, step.reads, s);
    reach[s] = r;
    for (const c of step.writes) {
      if (!PAGE_SCOPED.has(parseCell(c).kind)) continue;
      const target = cellPage(placement, c);
      if (target < 0 || r.page <= target) continue;
      issues.push({
        severity: 'error',
        code: 'page_order_violation',
        path: step.pointer,
        message: `${step.key} sets ${c} on ${pageName(placement, target)} but reads ${r.chain.join(' ← ')} on ${pageName(placement, r.page)}; `
          + 'logic for a page may only read the same or earlier pages',
      });
      break;
    }
  }
  return { reach: reach.map((r) => r ?? NOWHERE), issues };
}

export interface BoundCheck { pointer: string; blockId: BlockId; reads: readonly string[] }

export function boundIssues(graph: StepGraph, placement: Placement, reach: ReadonlyArray<Reach>, bounds: readonly BoundCheck[]): PublishIssue[] {
  const issues: PublishIssue[] = [];
  for (const bound of bounds) {
    const target = placement.pageIndex.get(placement.pageOf[bound.blockId] ?? '') ?? -1;
    const r = reachOf(graph, placement, reach, bound.reads);
    if (target < 0 || r.page <= target) continue;
    issues.push({
      severity: 'error',
      code: 'validation_bound_page_order',
      path: bound.pointer,
      message: `the bound of '${bound.blockId}' on ${pageName(placement, target)} reads ${r.chain.join(' ← ')} on ${pageName(placement, r.page)}`,
    });
  }
  return issues;
}
