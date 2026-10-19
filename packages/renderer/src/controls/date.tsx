import type { DateBound, IsoDate } from '@form/schema';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): IsoDate | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

/**
 * FLD-16/17 with the browser's date input (ISO value, locale display); the calendar and select pickers arrive with
 * the design work. Only absolute bounds become min/max hints; validation checks every bound.
 */
export function DateInput({ block, field }: ControlProps<'date'>) {
  const answer = useAnswer(block);
  const limits = block.config.limits;
  return (
    <input
      id={field.ids.input}
      className="fr-input fr-date"
      type="date"
      min={absolute(limits?.min)}
      max={absolute(limits?.max)}
      value={answer.value ?? ''}
      onChange={(e) => answer.set(e.target.value ? (e.target.value as IsoDate) : undefined)}
      onBlur={answer.onBlur}
      {...inputAttrs(field)}
    />
  );
}
