import { jsonPointer, validateStructure } from '@form/schema';
import type { BlockType, FieldRegistry, FormDefinition, PublishIssue, StoredBlock, ValidateDefinition } from '@form/schema';
import { analyze, type Analysis } from './analyze.ts';
import { cycleIssues } from './cycles.ts';
import { boundIssues, pageOrder } from './pageOrder.ts';
import { buildGraph, topoSort, type StepGraph } from './plan.ts';

type Mode = 'save' | 'publish';
type Lint = (block: StoredBlock, def: FormDefinition) => PublishIssue[];

export interface CheckedDefinition {
  issues: PublishIssue[];
  analysis: Analysis;
  graph: StepGraph;
  /** Plan order (indices into graph.steps) of every step not on or behind a cycle. */
  order: number[];
}

/** Warnings for elements that start hidden while no enabled rule can show them. */
function neverShown(def: FormDefinition): PublishIssue[] {
  const shown = new Set<string>();
  for (const rule of def.logic.rules) {
    if (!rule.enabled) continue;
    for (const action of [...rule.then, ...(rule.else ?? [])]) if (action.type === 'show') for (const t of action.targets) shown.add(t);
  }
  const warn = (path: string, what: string): PublishIssue => ({
    severity: 'warning', code: 'initially_hidden_never_shown', path, message: `${what} starts hidden and no enabled rule shows it`,
  });
  const issues: PublishIssue[] = [];
  def.pages.forEach((page, i) => {
    if (page.initiallyHidden && !shown.has(page.id)) issues.push(warn(jsonPointer('pages', i, 'initiallyHidden'), `page '${page.id}'`));
  });
  for (const [id, block] of Object.entries(def.blocks)) {
    if (block && block.type !== 'unsupported' && block.initiallyHidden && !shown.has(id)) {
      issues.push(warn(jsonPointer('blocks', id, 'initiallyHidden'), `block '${id}'`));
    }
  }
  return issues;
}

export function checkDefinition(def: FormDefinition, mode: Mode, registry: FieldRegistry): CheckedDefinition {
  /* Lint severities are publish severities (registry README); a draft only gets warnings from them. */
  const draft = (issue: PublishIssue): PublishIssue => (mode === 'save' && issue.severity === 'error' ? { ...issue, severity: 'warning' } : issue);
  const issues = validateStructure(def, { mode });
  for (const block of Object.values(def.blocks)) {
    if (!block || block.type === 'unsupported') continue;
    const lint = registry[block.type as BlockType].lint as Lint;
    issues.push(...lint(block, def).map(draft));
  }
  const analysis = analyze(def, registry);
  issues.push(...analysis.issues.map((i) => (i.code === 'missing_capability' ? draft(i) : i)));
  const graph = buildGraph(analysis.steps);
  const { order, blocked } = topoSort(graph);
  issues.push(...cycleIssues(graph, blocked));
  const pages = pageOrder(graph, order, analysis.placement);
  issues.push(...pages.issues, ...boundIssues(graph, analysis.placement, pages.reach, analysis.bounds));
  issues.push(...neverShown(def));
  return { issues, analysis, graph, order };
}

/**
 * `validateDefinition(def, mode, registry)`: structure (I1, I3–I7, I12, I14), registry lints, the P0
 * logic subset and operand types, cycles, the page-order rule (I8) and validation bounds. In 'save' mode
 * registry lints and `missing_capability` are warnings; logic errors stay errors in both modes.
 */
export const validateDefinition: ValidateDefinition = (def, mode, registry) => checkDefinition(def, mode, registry).issues;
