import type { PlanStep } from '@form/schema';

/*
 * Cells (schema §3.3.1): every piece of state a step reads or writes, keyed by a stable string so the
 * compiled plan's `reads` stays plain JSON. Ids are block, page, option, variable or notification ids.
 */

export const cell = {
  visible: (blockOrPage: string) => `visible:${blockOrPage}`,
  onPath: (page: string) => `onPath:${page}`,
  enabled: (block: string) => `enabled:${block}`,
  required: (block: string) => `required:${block}`,
  value: (block: string) => `value:${block}`,
  variable: (variable: string) => `var:${variable}`,
  optionHidden: (block: string, option: string) => `optionHidden:${block}/${option}`,
  jump: (page: string) => `jump:${page}`,
  ending: () => 'ending',
  submitBlock: (page: string) => `submitBlock:${page}`,
  recipients: (notification: string) => `recipients:${notification}`,
  variant: (notification: string) => `variant:${notification}`,
  effect: (kind: string, id: string) => `effect:${kind}:${id}`,
} as const;

export type CellKind =
  | 'visible' | 'onPath' | 'enabled' | 'required' | 'value' | 'var' | 'optionHidden' | 'jump' | 'ending' | 'submitBlock' | 'recipients' | 'variant'
  | 'effect';

export interface ParsedCell { kind: CellKind; id: string }

export function parseCell(key: string): ParsedCell {
  const at = key.indexOf(':');
  if (at < 0) return { kind: key as CellKind, id: '' };
  const kind = key.slice(0, at) as CellKind;
  const rest = key.slice(at + 1);
  return { kind, id: kind === 'optionHidden' ? rest.slice(0, rest.indexOf('/')) : rest };
}

/** Cells that decide what a page shows, requires or blocks: they obey the page-order rule (I8). */
export const PAGE_SCOPED: ReadonlySet<CellKind> = new Set<CellKind>(['visible', 'enabled', 'required', 'optionHidden', 'jump', 'submitBlock']);

/** The key of a plan step in `CompiledForm.reads` and in traces. */
export function stepKey(step: PlanStep): string {
  switch (step.kind) {
    case 'rule':
      return `rule:${step.ruleId}`;
    case 'on_path':
      return `on_path:${step.pageId}`;
    case 'variable':
      return `variable:${step.varId}`;
    default:
      return `${step.kind}:${step.blockId}`;
  }
}
