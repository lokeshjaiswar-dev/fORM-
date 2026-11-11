import { DatePicker } from '@dmacq/ui';
import type { DateBound, IsoDate } from '@form/schema';
import { pickerAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): IsoDate | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

/**
 * FLD-16/17: dmacq-ui date field (typed DD/MM/YYYY plus calendar). Only absolute bounds become min/max hints.
 */
export function DateInput({ block, field }: ControlProps<'date'>) {
  const answer = useAnswer(block);
  const limits = block.config.limits;
  const min = absolute(limits?.min);
  const max = absolute(limits?.max);
  return (
    <DatePicker
      id={field.ids.input}
      value={answer.value ?? ''}
      onValueChange={(value) => answer.set(value ? (value as IsoDate) : undefined)}
      onBlur={answer.onBlur}
      {...(min ? { min } : {})}
      {...(max ? { max } : {})}
      {...pickerAttrs(field)}
    />
  );
}
