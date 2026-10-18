import type { PlanStep } from '@form/schema';

/** A compile step with its cells (schema §3.3.2). */
export interface StepInfo {
  step: PlanStep;
  key: string;
  reads: string[];
  writes: string[];
  /** Authored rule index; -1 for steps that are not rules (they run before rules on ties). */
  ruleIndex: number;
  /** Position of the step's element (page or block) in render order. */
  order: number;
  /** JSON pointer for issues about this step. */
  pointer: string;
}

export type EdgeKind = 'data' | 'writers';

export interface StepGraph {
  steps: readonly StepInfo[];
  /** Successors of each step. */
  next: ReadonlyArray<ReadonlySet<number>>;
  /** `${from}>${to}` → why the edge exists: a read of a written cell, or two writers of one cell in authored order. */
  edges: ReadonlyMap<string, { kind: EdgeKind; cell: string }>;
  /** Writers of each cell, in authored order. */
  writersOf: ReadonlyMap<string, readonly number[]>;
}

const authored = (steps: readonly StepInfo[]) => (a: number, b: number): number => {
  const x = steps[a];
  const y = steps[b];
  if (!x || !y) return a - b;
  return x.ruleIndex - y.ruleIndex || x.order - y.order || a - b;
};

export function buildGraph(steps: readonly StepInfo[]): StepGraph {
  const byAuthored = authored(steps);
  const writersOf = new Map<string, number[]>();
  steps.forEach((s, i) => {
    for (const c of s.writes) {
      const list = writersOf.get(c);
      if (list) list.push(i);
      else writersOf.set(c, [i]);
    }
  });
  for (const list of writersOf.values()) list.sort(byAuthored);

  const next = steps.map(() => new Set<number>());
  const edges = new Map<string, { kind: EdgeKind; cell: string }>();
  const add = (from: number, to: number, kind: EdgeKind, c: string) => {
    next[from]?.add(to);
    const key = `${from}>${to}`;
    if (!edges.has(key) || kind === 'data') edges.set(key, { kind, cell: c });
  };
  /* Same-cell writers: w(i) → w(i+1) in authored order, so "last write wins in authored order" holds (§3.3.3). */
  for (const [c, list] of writersOf) for (let i = 1; i < list.length; i += 1) add(list[i - 1] as number, list[i] as number, 'writers', c);
  steps.forEach((s, to) => {
    for (const c of s.reads) for (const from of writersOf.get(c) ?? []) add(from, to, 'data', c);
  });
  return { steps, next, edges, writersOf };
}

/** Binary min-heap of step indices. */
class Heap {
  private readonly items: number[] = [];
  private readonly less: (a: number, b: number) => number;
  constructor(less: (a: number, b: number) => number) {
    this.less = less;
  }
  push(item: number): void {
    const items = this.items;
    items.push(item);
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i] as number, items[parent] as number) >= 0) break;
      [items[i], items[parent]] = [items[parent] as number, items[i] as number];
      i = parent;
    }
  }
  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length && last !== undefined) {
      items[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l] as number, items[m] as number) < 0) m = l;
        if (r < items.length && this.less(items[r] as number, items[m] as number) < 0) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m] as number, items[i] as number];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Kahn's topological sort; among ready steps, the lowest authored rule index wins, then render order
 * (§3.3.6). Returns the total order and the steps left over, which all lie on or behind a cycle.
 */
export function topoSort(graph: StepGraph): { order: number[]; blocked: number[] } {
  const indegree = graph.steps.map(() => 0);
  for (const succ of graph.next) for (const to of succ) indegree[to] = (indegree[to] ?? 0) + 1;
  const ready = new Heap(authored(graph.steps));
  indegree.forEach((d, i) => d === 0 && ready.push(i));
  const order: number[] = [];
  for (let i = ready.pop(); i !== undefined; i = ready.pop()) {
    order.push(i);
    for (const to of graph.next[i] ?? []) {
      const d = (indegree[to] ?? 0) - 1;
      indegree[to] = d;
      if (d === 0) ready.push(to);
    }
  }
  const done = new Set(order);
  return { order, blocked: graph.steps.map((_, i) => i).filter((i) => !done.has(i)) };
}
