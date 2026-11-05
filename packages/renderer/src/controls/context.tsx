import { useEvaluation } from '../eval/context.ts';
import { type ControlProps } from './hooks.ts';

/** FLD-31: a read-only session fact filled by capture. */
export function ContextField({ block, field }: ControlProps<'context'>) {
  const { state } = useEvaluation();
  const answer = state.values[block.id];
  const value = answer?.type === 'context' ? answer.value : '—';
  return (
    <output id={field.ids.input} className="fr-input fr-computed">
      {value}
    </output>
  );
}
