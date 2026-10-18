import { contentHash, jsonPointer } from '@form/schema';
import type { BlockId, Capability, Compile, CompiledForm, DataClassification, FieldRegistry, FormDefinition, PublishIssue } from '@form/schema';
import type { StepInfo } from './plan.ts';
import type { Placement } from './structure.ts';
import { taintOf } from './taint.ts';
import { checkDefinition } from './validateDefinition.ts';

export const ENGINE = 'logic@2' as const;

const CLASSIFICATION_ORDER: readonly DataClassification[] = ['none', 'personal', 'sensitive'];

function dataInventory(def: FormDefinition, placement: Placement): CompiledForm['dataInventory'] {
  return def.privacy.purposes.map((purpose) => {
    const blockIds: BlockId[] = [];
    const classifications = new Set<DataClassification>();
    for (const id of placement.documentOrder) {
      const block = def.blocks[id];
      if (!block || !('compliance' in block) || !block.compliance.purposeIds.includes(purpose.id)) continue;
      blockIds.push(id);
      classifications.add(block.compliance.classification);
    }
    return { purposeId: purpose.id, blockIds, classifications: CLASSIFICATION_ORDER.filter((c) => classifications.has(c)) };
  });
}

function requirements(def: FormDefinition, registry: FieldRegistry, usesExpr: boolean): Capability[] {
  const caps = new Set<Capability>(['schema@2', 'logic@2', 'rich_text@1']);
  if (usesExpr) caps.add('expr@1');
  for (const block of Object.values(def.blocks)) {
    if (!block || block.type === 'unsupported') continue;
    const capability = registry[block.type].capability;
    if (capability) caps.add(capability);
  }
  if (def.i18n.locales.length > 1) caps.add('multi_locale');
  if (def.theme.layout === 'cards') caps.add('cards_layout');
  if (def.behavior.saveAndResume.enabled) caps.add('save_and_resume');
  return [...caps].sort();
}

/**
 * Enabled rules whose condition reads a block that does not exist (B21): compile disables them, as
 * migration does (schema §4.2), so the target keeps its initial state. I4 keeps the dangling id a
 * warning in a draft (validateStructure) and an error at publish, never a reason to refuse the preview.
 */
function danglingSourceRules(def: FormDefinition, issues: readonly PublishIssue[]): Set<number> {
  const out = new Set<number>();
  def.logic.rules.forEach((rule, i) => {
    const when = `${jsonPointer('logic', 'rules', i, 'when')}/`;
    if (rule.enabled && issues.some((issue) => issue.code === 'dangling_ref' && issue.path.startsWith(when) && issue.path.endsWith('/blockId'))) out.add(i);
  });
  return out;
}

/** Issues compile() refuses: any error and any `missing_capability` (registry stubs and logic outside the P0 subset alike; ADR-0002 §2). */
const isFatal = (issue: PublishIssue): boolean => issue.severity === 'error' || issue.code === 'missing_capability';

/**
 * `compile()` (schema §3.3): the engine gate for drafts (builder preview) and publishes alike. It runs
 * validateDefinition in 'save' mode and fails on any fatal issue, reporting every fatal issue as an
 * error; publish additionally requires validateDefinition(def, 'publish') to report no errors.
 */
export const compile: Compile = (def, registry) => {
  let checked = checkDefinition(def, 'save', registry);
  const disabled = danglingSourceRules(def, checked.issues);
  if (disabled.size) {
    const rules = def.logic.rules.map((rule, i) => (disabled.has(i) ? { ...rule, enabled: false } : rule));
    checked = checkDefinition({ ...def, logic: { ...def.logic, rules } }, 'save', registry);
  }
  if (checked.issues.some(isFatal)) {
    return { ok: false, issues: checked.issues.map((i) => (isFatal(i) && i.severity !== 'error' ? { ...i, severity: 'error' } : i)) };
  }
  const { analysis, graph, order } = checked;
  const plan = order.map((i) => graph.steps[i] as StepInfo);
  const compiled: CompiledForm = {
    engine: ENGINE,
    requires: requirements(def, registry, analysis.usesExpr),
    documentOrder: analysis.placement.documentOrder,
    parentOf: analysis.placement.parentOf,
    pageOf: analysis.placement.pageOf,
    plan: plan.map((s) => s.step),
    reads: Object.fromEntries(plan.map((s) => [s.key, s.reads])),
    dataInventory: dataInventory(def, analysis.placement),
    taint: taintOf(def, graph, order),
    definitionHash: contentHash(def),
  };
  return { ok: true, compiled };
};
