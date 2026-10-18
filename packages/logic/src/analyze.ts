import { SERVER_ONLY_ACTION_TYPES, jsonPointer } from '@form/schema';
import type { Action, BlockId, ClientAction, ConditionGroup, FieldRegistry, FormDefinition, PlanStep, PublishIssue, StoredBlock } from '@form/schema';
import { cell, stepKey } from './cells.ts';
import type { BoundCheck } from './pageOrder.ts';
import type { StepInfo } from './plan.ts';
import { placementOf, valueReadsOf, type Placement } from './structure.ts';
import { checkGroup, typeExpr, type TypeContext } from './subset.ts';

/** Client actions in the P0 subset; every other action is `missing_capability` until WP-2.01–2.03. */
const P0_ACTIONS: ReadonlySet<Action['type']> = new Set<Action['type']>(['show', 'hide', 'require', 'unrequire', 'enable', 'disable']);
const SERVER_ONLY: ReadonlySet<string> = new Set(SERVER_ONLY_ACTION_TYPES);
export const isClientAction = (action: Action): action is ClientAction => !SERVER_ONLY.has(action.type);

/** The cells a P0 action writes and the value it writes; targets that do not exist write nothing. */
export function actionWrites(def: Pick<FormDefinition, 'blocks' | 'pages'>, action: Action): Array<[string, boolean]> {
  const exists = (id: string) => def.blocks[id as BlockId] !== undefined || def.pages.some((p) => p.id === id);
  switch (action.type) {
    case 'show':
    case 'hide':
      return action.targets.filter(exists).map((t) => [cell.visible(t), action.type === 'show']);
    case 'require':
    case 'unrequire':
      return action.targets.filter(exists).map((t) => [cell.required(t), action.type === 'require']);
    case 'enable':
    case 'disable':
      return action.targets.filter(exists).map((t) => [cell.enabled(t), action.type === 'enable']);
    default:
      return [];
  }
}

const hasExprOperand = (group: ConditionGroup): boolean =>
  group.children.some((c) => (c.kind === 'group' ? hasExprOperand(c) : [c.left, c.right, c.right2].some((o) => o?.kind === 'expr')));

export interface Analysis {
  placement: Placement;
  steps: StepInfo[];
  bounds: BoundCheck[];
  issues: PublishIssue[];
  usesExpr: boolean;
}

/** Steps, reads and writes of every page path, capture and enabled rule, with the P0-subset and typing issues (§3.3.2). */
export function analyze(def: FormDefinition, registry: FieldRegistry): Analysis {
  const placement = placementOf(def);
  const issues: PublishIssue[] = [];
  const steps: StepInfo[] = [];
  const bounds: BoundCheck[] = [];
  let usesExpr = false;
  const ctx: TypeContext = {
    def,
    registry,
    valueReads: (blockId) => valueReadsOf(placement, blockId),
    issue: (code, path, message) => issues.push({ severity: 'error', code, path, message }),
  };

  /* onPath(p) reads the path so far: visibility of this and every earlier page, their jumps and onPath of the previous page. */
  def.pages.forEach((page, i) => {
    if (placement.pageIndex.get(page.id) !== i) return;
    const reads = def.pages.slice(0, i + 1).map((p) => cell.visible(p.id));
    for (const p of def.pages.slice(0, i)) reads.push(cell.jump(p.id));
    const previous = def.pages[i - 1];
    if (previous) reads.push(cell.onPath(previous.id));
    const step: PlanStep = { kind: 'on_path', pageId: page.id };
    steps.push({
      step, key: stepKey(step), reads: [...new Set(reads)].sort(), writes: [cell.onPath(page.id)], ruleIndex: -1,
      order: placement.elementOrder.get(page.id) ?? 0, pointer: jsonPointer('pages', i),
    });
  });

  for (const blockId of placement.documentOrder) {
    const block = def.blocks[blockId] as StoredBlock;
    const at = (...rest: Array<string | number>) => jsonPointer('blocks', blockId, 'config', ...rest);
    if (block.type === 'hidden') {
      const source = block.config.source;
      const reads = new Set<string>();
      if (source.kind === 'static' && source.value.some((part) => typeof part !== 'string')) {
        ctx.issue('missing_capability', at('source', 'value'), 'hidden values with pipes or template variables need expressions (WP-2.01)');
      }
      if (source.kind === 'expr') {
        usesExpr = true;
        const typed = typeExpr(ctx, source.expr, at('source', 'expr'), reads);
        if (typed && typed.kind !== 'text' && typed.kind !== 'null') {
          ctx.issue('expr_type_error', at('source', 'expr'), `a hidden value is text, not ${typed.kind}`);
        }
      }
      const step: PlanStep = { kind: 'capture', blockId };
      steps.push({
        step, key: stepKey(step), reads: [...reads].sort(), writes: [cell.value(blockId)], ruleIndex: -1,
        order: placement.elementOrder.get(blockId) ?? 0, pointer: at('source'),
      });
    }
    if (block.type === 'date' || block.type === 'datetime') {
      for (const side of ['min', 'max'] as const) {
        const bound = block.config.limits?.[side];
        if (bound?.kind === 'field' && def.blocks[bound.blockId]) {
          bounds.push({ pointer: at('limits', side), blockId, reads: valueReadsOf(placement, bound.blockId) });
        }
      }
    }
  }

  const seen = new Set<string>();
  def.logic.rules.forEach((rule, index) => {
    if (!rule.enabled || seen.has(rule.id)) return;
    seen.add(rule.id);
    const at = jsonPointer('logic', 'rules', index);
    if (rule.scope) ctx.issue('missing_capability', `${at}/scope`, 'row-scoped rules need repeating groups, which are not available yet');
    const reads = new Set<string>();
    checkGroup(ctx, rule.when, `${at}/when`, reads);
    usesExpr ||= hasExprOperand(rule.when);
    const writes = new Set<string>();
    const actions = [...rule.then, ...(rule.else ?? [])];
    const branch = (list: readonly Action[] | undefined, name: 'then' | 'else') => list?.forEach((action, j) => {
      if (!P0_ACTIONS.has(action.type)) {
        ctx.issue('missing_capability', `${at}/${name}/${j}`, `'${action.type}' actions are not available yet; P0 logic shows, hides, requires and enables`);
        return;
      }
      for (const [c] of actionWrites(def, action)) writes.add(c);
    });
    branch(rule.then, 'then');
    branch(rule.else, 'else');
    const server = actions.length > 0 && !actions.some(isClientAction);
    const step: PlanStep = { kind: 'rule', ruleId: rule.id, scope: server ? 'server' : 'client+server' };
    steps.push({ step, key: stepKey(step), reads: [...reads].sort(), writes: [...writes], ruleIndex: index, order: 0, pointer: at });
  });

  def.logic.variables.forEach((_, i) => {
    ctx.issue('missing_capability', jsonPointer('logic', 'variables', i), 'logic variables (LOG-20) are not available yet');
  });
  return { placement, steps, bounds, issues, usesExpr };
}
