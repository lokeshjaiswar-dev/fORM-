import type { ScalarValue } from '@form/schema';
import { useContext } from 'react';
import { useRenderer } from '../context.ts';
import { useEvaluation } from '../eval/context.ts';
import { MESSAGES } from '../messages.ts';
import { DsText } from './ds.tsx';
import { inputAttrs, type ControlProps } from './hooks.ts';
import { RowContext } from './rowContext.ts';

const format = (value: ScalarValue | undefined): string => {
  if (!value || value.t === 'null') return '';
  if (value.t === 'number' || value.t === 'text' || value.t === 'date' || value.t === 'time') return String(value.v);
  if (value.t === 'boolean') return value.v ? 'Yes' : 'No';
  if (value.t === 'money') return value.v;
  return '';
};

/** FLD-33: a read-only result, shown in the same input as a short answer. */
export function Calculation({ block, field }: ControlProps<'calculation'>) {
  const { t } = useRenderer();
  const { state } = useEvaluation();
  const rowId = useContext(RowContext);
  /* Inside a list, the formula's result is per row; outside, it is the form-level answer. */
  const value = rowId !== undefined
    ? state.rowValues?.[block.id]?.[rowId]
    : (() => {
      const answer = state.values[block.id];
      return answer?.type === 'calculation' ? answer.value : undefined;
    })();
  return (
    <DsText
      type="text"
      id={field.ids.input}
      value={format(value)}
      placeholder={t(MESSAGES['field.answer'])}
      onChange={() => {}}
      {...inputAttrs(field)}
    />
  );
}
