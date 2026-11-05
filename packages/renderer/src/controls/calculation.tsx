import type { ScalarValue } from '@form/schema';
import { useEvaluation } from '../eval/context.ts';
import { type ControlProps } from './hooks.ts';

const format = (value: ScalarValue | undefined): string => {
  if (!value || value.t === 'null') return '—';
  if (value.t === 'number' || value.t === 'text' || value.t === 'date' || value.t === 'time') return String(value.v);
  if (value.t === 'boolean') return value.v ? 'Yes' : 'No';
  if (value.t === 'money') return value.v;
  return '—';
};

/** FLD-33: a read-only result filled by capture. */
export function Calculation({ block, field }: ControlProps<'calculation'>) {
  const { state } = useEvaluation();
  const answer = state.values[block.id];
  const value = answer?.type === 'calculation' ? answer.value : undefined;
  return (
    <output id={field.ids.input} className="fr-input fr-computed">
      {format(value)}
    </output>
  );
}
