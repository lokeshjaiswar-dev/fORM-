import type { ClientAction, FormDefinition, ProjectForRuntime, PublicFormDefinition, Rule, RuntimeFormVersion } from '@form/schema';
import { isClientAction } from './analyze.ts';
import { stepKey } from './cells.ts';

/** An `Origin` stamp: exactly `{ bindingId, sourceId }` (a block or option whose id is 'origin' is not one). */
const isOrigin = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === 'bindingId,sourceId';

/** Drops every `origin` stamp at any depth; TranslationEntry.origin is a string and stays. */
function stripOrigins<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripOrigins) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => (key === 'origin' && isOrigin(v) ? [] : [[key, stripOrigins(v)]]))) as T;
}

/** Rules keep only client actions; a rule left with no actions is dropped. */
function clientRules(rules: readonly Rule[]): Array<Rule<ClientAction>> {
  return rules.flatMap((rule) => {
    const then = rule.then.filter(isClientAction);
    const otherwise = rule.else?.filter(isClientAction);
    if (!then.length && !otherwise?.length) return [];
    const { else: _else, ...rest } = rule;
    return [otherwise?.length ? { ...rest, then, else: otherwise } : { ...rest, then }];
  });
}

/**
 * The runtime projection (I11): no builder notes, origin stamps or server actions; the compiled form
 * keeps `reads` for incremental evaluation but only for the steps of rules it keeps, and drops `dataInventory` and `taint`.
 */
export const projectForRuntime: ProjectForRuntime = (version, status, publicConfig) => {
  const def = version.definition as FormDefinition;
  const blocks = Object.fromEntries(Object.entries(def.blocks).map(([id, block]) => {
    if (!block || block.type === 'unsupported') return [id, block];
    const { note: _note, ...rest } = block;
    return [id, rest];
  }));
  const rules = clientRules(def.logic.rules);
  const definition = stripOrigins({ ...def, blocks, logic: { ...def.logic, rules } }) as PublicFormDefinition;
  const { dataInventory: _inventory, taint: _taint, plan, reads, ...compiled } = version.compiled;
  /* Steps of dropped rules go too: server-only rules, and rules with no actions at all. */
  const kept = new Set<string>(rules.map((r) => r.id));
  const clientPlan = plan.filter((step): step is Exclude<typeof step, { scope: 'server' }> =>
    step.kind !== 'rule' || (step.scope !== 'server' && kept.has(step.ruleId)));
  const clientReads = Object.fromEntries(clientPlan.flatMap((step) => {
    const key = stepKey(step);
    const cells = reads[key];
    return cells ? [[key, cells]] : [];
  }));
  const runtime: RuntimeFormVersion = {
    versionId: version.id,
    formId: version.formId,
    contentHash: version.contentHash,
    definition,
    compiled: { ...compiled, plan: clientPlan, reads: clientReads },
    status,
    publicConfig,
  };
  return runtime;
};
