import { formatUniqueId } from '@form/registry';
import { useEvaluation } from '../eval/context.ts';
import { type ControlProps } from './hooks.ts';

/** FLD-32: read-only serial filled by capture (preview uses prefix + startAt). */
export function UniqueIdField({ block, field }: ControlProps<'unique_id'>) {
  const { state } = useEvaluation();
  const answer = state.values[block.id];
  const value = answer?.type === 'unique_id' ? answer.value : formatUniqueId(block.config);
  return (
    <output id={field.ids.input} className="fr-input fr-computed">
      {value}
    </output>
  );
}
