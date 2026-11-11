import { useEffect, useState } from 'react';
import { DatePicker } from '@dmacq/ui';
import type { DateBound, IsoDate } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { pickerAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): IsoDate | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

/** Two dmacq-ui date fields that commit only when both sides are filled. */
export function DateRangeField({ block, field }: ControlProps<'date_range'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const limits = block.config.limits;
  const min = absolute(limits?.min);
  const max = absolute(limits?.max);
  const [start, setStart] = useState(answer.value?.start ?? '');
  const [end, setEnd] = useState(answer.value?.end ?? '');

  useEffect(() => {
    setStart(answer.value?.start ?? '');
    setEnd(answer.value?.end ?? '');
  }, [answer.value?.start, answer.value?.end]);

  const commit = (nextStart: string, nextEnd: string) => {
    setStart(nextStart);
    setEnd(nextEnd);
    if (nextStart && nextEnd) answer.set({ start: nextStart as IsoDate, end: nextEnd as IsoDate });
    else answer.set(undefined);
  };

  const shared = { onBlur: answer.onBlur, ...pickerAttrs(field) };
  const endMin = start || min;
  return (
    <div className="fr-date-range">
      <label className="fr-label" htmlFor={field.ids.input}>{t(MESSAGES['date_range.start'])}</label>
      <DatePicker
        id={field.ids.input}
        value={start}
        onValueChange={(value) => commit(value, end)}
        {...(min ? { min } : {})}
        {...(max ? { max } : {})}
        {...shared}
      />
      <label className="fr-label" htmlFor={`${field.ids.input}-end`}>{t(MESSAGES['date_range.end'])}</label>
      <DatePicker
        id={`${field.ids.input}-end`}
        value={end}
        onValueChange={(value) => commit(start, value)}
        {...(endMin ? { min: endMin } : {})}
        {...(max ? { max } : {})}
        {...shared}
      />
    </div>
  );
}
