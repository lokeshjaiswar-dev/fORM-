import type { AnswerValue, Answers, BlockId, OptionId, StoredBlock } from '@form/schema';

/** What dependent (cascading) options leave on offer once every parent's answer is known. */
export interface DependentOptions {
  /** Options of each dependent block that the parent's current answer does not allow. */
  hiddenOptions: Partial<Record<BlockId, OptionId[]>>;
  /** Dependent blocks whose parent has no usable answer yet: they wait, disabled, until it has. */
  waiting: Set<BlockId>;
}

interface DependentChoice {
  dependsOn?: BlockId;
  options: ReadonlyArray<{ id: OptionId; parentOptionIds?: readonly OptionId[] }>;
}

function choiceConfig(block: StoredBlock | undefined): DependentChoice | undefined {
  if (block?.type !== 'single_choice' && block?.type !== 'multi_choice') return undefined;
  return block.config as DependentChoice;
}

function chosenOptions(answer: AnswerValue | undefined): OptionId[] {
  if (answer?.type === 'single_choice') return answer.value.optionId === null ? [] : [answer.value.optionId];
  if (answer?.type === 'multi_choice') return answer.value.optionIds;
  return [];
}

const hasOther = (answer: AnswerValue | undefined): boolean =>
  (answer?.type === 'single_choice' || answer?.type === 'multi_choice') && answer.value.other !== undefined;

/**
 * Works out dependent options in document order, so a chain (Country → State → District) resolves top down. A parent
 * counts only the options it still offers: when Country changes, the old State is no longer allowed, so District waits
 * again. A parent answered with only "Other" is answered, but matches no link, so only unlinked options are offered.
 * An option with no `parentOptionIds` is always offered. A dependent block whose parent has no usable answer (or is
 * itself waiting) is `waiting`.
 */
export function dependentOptions(order: readonly BlockId[], blocks: ReadonlyMap<string, StoredBlock>, values: Answers): DependentOptions {
  const hiddenOptions: Partial<Record<BlockId, OptionId[]>> = {};
  const waiting = new Set<BlockId>();
  for (const id of order) {
    const config = choiceConfig(blocks.get(id));
    const parentId = config?.dependsOn;
    if (!config || parentId === undefined || !choiceConfig(blocks.get(parentId))) continue;
    const parentHidden = new Set(hiddenOptions[parentId] ?? []);
    const answer = waiting.has(parentId) ? undefined : values[parentId];
    const chosen = chosenOptions(answer).filter((option) => !parentHidden.has(option));
    if (chosen.length === 0 && !hasOther(answer)) waiting.add(id);
    const allowed = new Set(chosen);
    const hidden = config.options.filter((option) => option.parentOptionIds?.length && !option.parentOptionIds.some((p) => allowed.has(p))).map((option) => option.id);
    if (hidden.length) hiddenOptions[id] = hidden;
  }
  return { hiddenOptions, waiting };
}

/** The ids of blocks whose options depend on another block, in document order. */
export function dependentBlockIds(order: readonly BlockId[], blocks: ReadonlyMap<string, StoredBlock>): BlockId[] {
  return order.filter((id) => choiceConfig(blocks.get(id))?.dependsOn !== undefined);
}

/**
 * The answers rules, calculations and checks may read: a dependent answer the parent's answer no longer allows is
 * dropped (a waiting block's answer entirely; disallowed options from a multi choice), so a stale State never reaches
 * a rule after Country changes, on the client or the server. Answers of every other block pass through untouched.
 */
export function admittedAnswers(order: readonly BlockId[], blocks: ReadonlyMap<string, StoredBlock>, answers: Answers): Answers {
  const dependants = dependentBlockIds(order, blocks);
  if (dependants.length === 0) return answers;
  const admitted: Answers = { ...answers };
  const { hiddenOptions, waiting } = dependentOptions(order, blocks, admitted);
  for (const id of dependants) {
    const answer = admitted[id];
    if (!answer) continue;
    if (waiting.has(id)) {
      delete admitted[id];
      continue;
    }
    const hidden = new Set(hiddenOptions[id] ?? []);
    if (answer.type === 'single_choice' && answer.value.optionId !== null && hidden.has(answer.value.optionId)) delete admitted[id];
    if (answer.type === 'multi_choice') {
      const optionIds = answer.value.optionIds.filter((o) => !hidden.has(o));
      if (optionIds.length === answer.value.optionIds.length) continue;
      if (optionIds.length === 0 && answer.value.other === undefined) delete admitted[id];
      else admitted[id] = { ...answer, value: { ...answer.value, optionIds } };
    }
  }
  return admitted;
}
