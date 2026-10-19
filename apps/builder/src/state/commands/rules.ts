import type { Action, BlockId, Condition, ConditionGroup, FormDefinition, OptionId, PageId, Rule, StoredBlock } from '@form/schema';

/*
 * Rules are form-level (logic@2): a block is read by rules whose conditions or computed values name it, and targeted
 * by rules whose actions name it. These helpers keep the two apart, so a delete can ask about the readers (B21) and
 * quietly drop the deleted element from targets.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;

/** Whether `value` names block `id` anywhere (answer refs, option operands, anchors). */
function mentions(value: unknown, id: string): boolean {
  const stack: unknown[] = [value];
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    if (Array.isArray(v)) stack.push(...(v as unknown[]));
    else if (isRec(v)) {
      if (v['blockId'] === id) return true;
      stack.push(...Object.values(v));
    }
  }
  return false;
}

/** What an action reads, apart from its targets: computed values and option sets. */
function actionReads(action: Action): unknown {
  switch (action.type) {
    case 'set_value':
    case 'set_variable':
      return action.value;
    case 'block_submit':
      return action.anchorBlockId === undefined ? null : { blockId: action.anchorBlockId };
    default:
      return null;
  }
}

/** Whether the rule's conditions or values read block `id` (its targets do not count). */
export function ruleReads(rule: Rule, id: BlockId): boolean {
  return mentions(rule.when, id) || [...rule.then, ...(rule.else ?? [])].some((a) => mentions(actionReads(a), id));
}

/** The elements (blocks and pages) an action changes. */
export function actionTargets(action: Action): string[] {
  switch (action.type) {
    case 'show':
    case 'hide':
    case 'require':
    case 'unrequire':
    case 'enable':
    case 'disable':
    case 'clear_value':
      return [...action.targets];
    case 'set_value':
    case 'show_options':
    case 'hide_options':
      return [action.target];
    case 'skip_to_page':
      return [action.from, action.to];
    case 'skip_to_end':
      return [action.from];
    default:
      return [];
  }
}

export const ruleTargets = (rule: Rule): string[] => [...rule.then, ...(rule.else ?? [])].flatMap(actionTargets);

/** Rules that read block `id` (in authored order). */
export const rulesReading = (def: FormDefinition, id: BlockId): Rule[] => def.logic.rules.filter((r) => ruleReads(r, id));

/** Rules with an action on element `id` (a block or a page). */
export const rulesTargeting = (def: FormDefinition, id: string): Rule[] => def.logic.rules.filter((r) => ruleTargets(r).includes(id));

/** The action without element `id`; null when nothing is left for it to act on. */
function withoutTarget(action: Action, id: string): Action | null {
  if (!actionTargets(action).includes(id)) return action;
  if ('targets' in action) {
    const targets = action.targets.filter((t) => t !== id);
    return targets.length ? ({ ...action, targets } as Action) : null;
  }
  return null;
}

/** Drops element `id` from every rule's actions; a rule left with no action is removed. */
export function dropTarget(def: FormDefinition, id: string): void {
  def.logic.rules = def.logic.rules.flatMap((rule) => {
    if (!ruleTargets(rule).includes(id)) return [rule];
    const then = rule.then.map((a) => withoutTarget(a, id)).filter((a) => a !== null);
    const otherwise = (rule.else ?? []).map((a) => withoutTarget(a, id)).filter((a) => a !== null);
    if (!then.length && !otherwise.length) return [];
    const { else: _else, ...rest } = rule;
    return [{ ...rest, then, ...(otherwise.length ? { else: otherwise } : {}) }];
  });
}

/** Drops option ids of `id` not in `kept` from the operands under `node`; false when an operand is left with none. */
function pruneOperands(node: Condition | ConditionGroup, id: BlockId, kept: ReadonlySet<string>): boolean {
  if (node.kind === 'group') return node.children.map((child) => pruneOperands(child, id, kept)).every(Boolean);
  let whole = true;
  for (const operand of [node.left, node.right, node.right2]) {
    if (operand?.kind !== 'options' || operand.blockId !== id) continue;
    const optionIds = operand.optionIds.filter((o) => kept.has(o));
    if (optionIds.length !== operand.optionIds.length) operand.optionIds = optionIds;
    if (!optionIds.length) whole = false;
  }
  return whole;
}

/**
 * After block `id`'s options changed, rules forget the options it no longer has: option operands and show or hide
 * option actions drop them. A condition left with no option disables its rule, as deleting a read block does (B21);
 * an option action left with none is dropped. Returns the elements of the rules it disabled.
 */
export function pruneOptions(def: FormDefinition, id: BlockId, options: ReadonlyArray<{ id: OptionId }>): string[] {
  const kept = new Set<string>(options.map((o) => o.id));
  const touched: string[] = [];
  def.logic.rules = def.logic.rules.flatMap((rule) => {
    if (!pruneOperands(rule.when, id, kept) && rule.enabled) {
      rule.enabled = false;
      touched.push(...ruleTargets(rule));
    }
    const prune = (actions: Action[]) =>
      actions.flatMap((a) => {
        if ((a.type !== 'show_options' && a.type !== 'hide_options') || a.target !== id) return [a];
        const optionIds = a.optionIds.filter((o) => kept.has(o));
        if (!optionIds.length) return [];
        if (optionIds.length !== a.optionIds.length) a.optionIds = optionIds;
        return [a];
      });
    const then = prune(rule.then);
    const otherwise = prune(rule.else ?? []);
    if (then.length === rule.then.length && otherwise.length === (rule.else?.length ?? 0)) return [rule];
    if (!then.length && !otherwise.length) return [];
    rule.then = then;
    if (otherwise.length) rule.else = otherwise;
    else delete rule.else;
    return [rule];
  });
  return touched;
}

/** Elements an enabled rule can show. */
function shownElements(def: FormDefinition): Set<string> {
  const shown = new Set<string>();
  for (const rule of def.logic.rules) {
    if (!rule.enabled) continue;
    for (const action of [...rule.then, ...(rule.else ?? [])]) if (action.type === 'show') action.targets.forEach((t) => shown.add(t));
  }
  return shown;
}

/**
 * D2: an element starts hidden exactly while an enabled rule can show it. The builder sets and clears
 * `initiallyHidden` for the elements a rule change touched, so "show when …" keeps meaning hidden until then.
 */
export function syncInitiallyHidden(def: FormDefinition, ids: Iterable<string>): void {
  const shown = shownElements(def);
  for (const id of ids) {
    const block: StoredBlock | undefined = def.blocks[id as BlockId];
    const page = def.pages.find((p) => p.id === (id as PageId));
    const element = block && block.type !== 'unsupported' ? block : page;
    if (!element) continue;
    if (shown.has(id)) element.initiallyHidden = true;
    else delete element.initiallyHidden;
  }
}
