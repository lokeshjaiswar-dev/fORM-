import type { PublishIssue } from '@form/schema';
import type { StepGraph } from './plan.ts';

/** Strongly connected components among `nodes` (iterative Tarjan), each in ascending index order. */
function components(graph: StepGraph, nodes: readonly number[]): number[][] {
  const inside = new Set(nodes);
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: number; succ: number[]; next: number }> = [];
    const open = (node: number) => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, succ: [...(graph.next[node] ?? [])].filter((n) => inside.has(n)).sort((a, b) => a - b), next: 0 });
    };
    open(root);
    while (work.length) {
      const frame = work[work.length - 1] as { node: number; succ: number[]; next: number };
      const to = frame.succ[frame.next];
      if (to !== undefined) {
        frame.next += 1;
        if (!index.has(to)) open(to);
        else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(to) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      if (low.get(frame.node) === index.get(frame.node)) {
        const scc: number[] = [];
        for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
          onStack.delete(n);
          scc.push(n);
          if (n === frame.node) break;
        }
        out.push(scc.sort((a, b) => a - b));
      }
    }
  }
  return out;
}

/** Shortest cycle through `start` inside one component (breadth first, smallest successor first). */
function cycleThrough(graph: StepGraph, start: number, members: ReadonlySet<number>): number[] {
  const parent = new Map<number, number>();
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] as number;
    for (const to of [...(graph.next[node] ?? [])].sort((a, b) => a - b)) {
      if (!members.has(to)) continue;
      if (to === start) {
        const path = [node];
        for (let p = parent.get(node); p !== undefined; p = parent.get(p)) path.push(p);
        return path.reverse();
      }
      if (!parent.has(to) && to !== start) {
        parent.set(to, node);
        queue.push(to);
      }
    }
  }
  return [start];
}

/**
 * `logic_cycle` for every cycle in the step graph, reported with its path. When an edge on the
 * cycle exists only because two rules write the same cell, the message says so ("conflicting writers").
 */
export function cycleIssues(graph: StepGraph, blocked: readonly number[]): PublishIssue[] {
  const issues: PublishIssue[] = [];
  for (const scc of components(graph, blocked)) {
    const first = scc[0];
    if (first === undefined) continue;
    if (scc.length === 1 && !graph.next[first]?.has(first)) continue;
    const members = new Set(scc);
    const start = scc.reduce((best, n) => {
      const a = graph.steps[n];
      const b = graph.steps[best];
      return a && b && (a.ruleIndex - b.ruleIndex || a.order - b.order) < 0 ? n : best;
    }, first);
    const cycle = cycleThrough(graph, start, members);
    const parts: string[] = [];
    const conflicts: string[] = [];
    cycle.forEach((from, i) => {
      const to = cycle[(i + 1) % cycle.length] as number;
      const edge = graph.edges.get(`${from}>${to}`);
      parts.push(graph.steps[from]?.key ?? String(from));
      if (!edge) return;
      parts.push(edge.kind === 'writers' ? `(writes ${edge.cell} before)` : `(${edge.cell})`);
      if (edge.kind === 'writers') conflicts.push(`${graph.steps[from]?.key} and ${graph.steps[to]?.key} both write ${edge.cell}`);
    });
    parts.push(graph.steps[start]?.key ?? String(start));
    const hint = conflicts.length
      ? `; conflicting writers: ${conflicts.join('; ')} (the later rule must run last, so reorder or merge the rules)`
      : '';
    issues.push({ severity: 'error', code: 'logic_cycle', path: graph.steps[start]?.pointer ?? '', message: `logic cycle: ${parts.join(' → ')}${hint}` });
  }
  return issues;
}
