import { useEffect, useState } from 'react';
import type { DateBound, IsoDate } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): IsoDate | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

/** Two native date inputs that commit only when both sides are filled. */
export function DateRangeField({ block, field }: ControlProps<'date_range'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const limits = block.config.limits;
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

  const attrs = inputAttrs(field);
  return (
    <div className="fr-date-range">
      <label className="fr-label" htmlFor={field.ids.input}>{t(MESSAGES['date_range.start'])}</label>
      <input
        id={field.ids.input}
        className="fr-input fr-date"
        type="date"
        min={absolute(limits?.min)}
        max={absolute(limits?.max)}
        value={start}
        onChange={(e) => commit(e.target.value, end)}
        onBlur={answer.onBlur}
        {...attrs}
      />
      <label className="fr-label" htmlFor={`${field.ids.input}-end`}>{t(MESSAGES['date_range.end'])}</label>
      <input
        id={`${field.ids.input}-end`}
        className="fr-input fr-date"
        type="date"
        min={start || absolute(limits?.min)}
        max={absolute(limits?.max)}
        value={end}
        onChange={(e) => commit(start, e.target.value)}
        onBlur={answer.onBlur}
        {...attrs}
        autoFocus={undefined}
      />
    </div>
  );
}
