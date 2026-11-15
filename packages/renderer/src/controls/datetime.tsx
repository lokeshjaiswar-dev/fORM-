import { useEffect, useState } from 'react';
import type { DateBound, IsoInstant, IsoLocalDateTime, TimeZone } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): string | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

const zoneOf = (configured: TimeZone | 'respondent'): TimeZone =>
  (configured === 'respondent' ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') : configured) as TimeZone;

/** The native date input always gives `YYYY-MM-DD` and the time input `HH:MM`; anything else is not a complete value yet. */
function pack(date: string, time: string, timeZone: TimeZone): { local: IsoLocalDateTime; timeZone: TimeZone; instant: IsoInstant } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return undefined;
  const local = `${date}T${time}`;
  const instant = new Date(`${local}:00`);
  if (Number.isNaN(instant.getTime())) return undefined;
  return { local: local as IsoLocalDateTime, timeZone, instant: instant.toISOString() as IsoInstant };
}

function partsOf(local: string | undefined): { date: string; time: string } {
  if (!local) return { date: '', time: '' };
  const [date = '', time = ''] = local.split('T');
  return { date, time: time.slice(0, 5) };
}

/**
 * FLD-18: a native date input and a native time input side by side (so a respondent can fill one and then the other);
 * the stored answer keeps local, zone and instant.
 */
export function DateTimeInput({ block, field }: ControlProps<'datetime'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const tz = zoneOf(block.config.timeZone);
  const limits = block.config.limits;
  const stored = partsOf(answer.value?.local);
  const [date, setDate] = useState(stored.date);
  const [time, setTime] = useState(stored.time);

  useEffect(() => {
    if (!answer.value?.local) return;
    setDate(stored.date);
    setTime(stored.time);
  }, [answer.value?.local, stored.date, stored.time]);

  const write = (nextDate: string, nextTime: string) => {
    setDate(nextDate);
    setTime(nextTime);
    answer.set(pack(nextDate, nextTime, tz));
  };

  const attrs = inputAttrs(field);
  const timeId = `${field.ids.base}-time`;
  return (
    <div className="fr-range">
      <input
        id={field.ids.input}
        className="fr-input fr-date"
        type="date"
        min={absolute(limits?.min)}
        max={absolute(limits?.max)}
        value={date}
        onChange={(e) => write(e.target.value, time)}
        onBlur={answer.onBlur}
        {...attrs}
      />
      <label className="fr-sublabel" htmlFor={timeId}>{t(MESSAGES['datetime.time'])}</label>
      <input
        id={timeId}
        className="fr-input fr-time"
        type="time"
        step={block.config.minuteStep * 60}
        value={time}
        onChange={(e) => write(date, e.target.value)}
        onBlur={answer.onBlur}
        {...attrs}
        autoFocus={undefined}
      />
    </div>
  );
}
