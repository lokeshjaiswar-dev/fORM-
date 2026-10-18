import { canonicalJson } from '@form/schema';
import type { EvalState, PageId, PlanStep } from '@form/schema';

/** One LOG-22 trace row: the step, whether a rule fired (null for other steps or skipped rules), and diagnostics. */
export type TraceEntry = NonNullable<EvalState['trace']>[number];

export function traceEntry(step: PlanStep, fired: boolean | null, diagnostics: readonly string[]): TraceEntry {
  return diagnostics.length ? { step, fired, diagnostics: [...diagnostics] } : { step, fired };
}

const sorted = <T extends string>(set: ReadonlySet<T>): T[] => [...set].sort();

/**
 * Canonical JSON of an EvalState (RFC 8785 key order, sets as sorted arrays, `nextPage` tabulated for
 * every page). The determinism job diffs these bytes between Node, Chromium, Firefox and WebKit.
 */
export function evalStateJson(state: EvalState, pages: readonly PageId[]): string {
  return canonicalJson({
    visible: sorted(state.visible),
    required: sorted(state.required),
    disabled: sorted(state.disabled),
    hiddenOptions: state.hiddenOptions,
    values: state.values,
    variables: state.variables,
    submitBlocks: state.submitBlocks,
    path: state.path,
    next: Object.fromEntries(pages.map((p) => [p, state.nextPage(p)])),
    endingId: state.endingId,
    serverEffects: state.serverEffects,
    ...(state.trace ? { trace: state.trace } : {}),
  });
}
