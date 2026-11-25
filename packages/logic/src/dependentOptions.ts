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

export function chosenOptions(answer: AnswerValue | undefined): OptionId[] {
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
