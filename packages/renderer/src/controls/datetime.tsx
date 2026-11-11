import { useEffect, useState } from 'react';
import { DatePicker, TimePicker } from '@dmacq/ui';
import type { DateBound, IsoInstant, IsoLocalDateTime, TimeZone } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { pickerAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): string | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

const zoneOf = (configured: TimeZone | 'respondent'): TimeZone =>
  (configured === 'respondent' ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') : configured) as TimeZone;

function isoDateOf(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!dmy) return '';
  const day = dmy[1]!.padStart(2, '0');
  const month = dmy[2]!.padStart(2, '0');
  const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
  return `${year}-${month}-${day}`;
}

function hhmmOf(raw: string): string {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return /^\d{2}:\d{2}$/.test(raw.trim()) ? raw.trim() : '';
  let hour = Number(match[1]);
  const minute = match[2]!;
  const mer = match[3]?.toUpperCase();
  if (mer === 'PM' && hour < 12) hour += 12;
  if (mer === 'AM' && hour === 12) hour = 0;
  if (hour > 23) return '';
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function pack(date: string, time: string, timeZone: TimeZone): { local: IsoLocalDateTime; timeZone: TimeZone; instant: IsoInstant } | undefined {
  const day = isoDateOf(date);
  const clock = hhmmOf(time);
  if (!day || !clock) return undefined;
  const local = `${day}T${clock}`;
  const instant = new Date(`${local}:00`);
  if (Number.isNaN(instant.getTime())) return undefined;
  return { local: local as IsoLocalDateTime, timeZone, instant: instant.toISOString() as IsoInstant };
}

function partsOf(local: string | undefined): { date: string; time: string } {
  if (!local) return { date: '', time: '' };
  const [date = '', time = ''] = local.split('T');
  return { date, time: time.slice(0, 5) };
}

/** FLD-18: dmacq-ui date and time pickers; the stored answer keeps local, zone and instant. */
export function DateTimeInput({ block, field }: ControlProps<'datetime'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const tz = zoneOf(block.config.timeZone);
  const limits = block.config.limits;
  const min = absolute(limits?.min);
  const max = absolute(limits?.max);
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

  const shared = { onBlur: answer.onBlur, ...pickerAttrs(field) };
  const { autoFocus, ...withoutFocus } = shared;
  const timeId = `${field.ids.base}-time`;
  return (
    <div className="fr-range">
      <DatePicker
        id={field.ids.input}
        value={date}
        onValueChange={(value) => write(value, time)}
        {...(min ? { min } : {})}
        {...(max ? { max } : {})}
        {...shared}
      />
      <label className="fr-sublabel" htmlFor={timeId}>{t(MESSAGES['datetime.time'])}</label>
      <TimePicker
        id={timeId}
        value={time}
        onValueChange={(value) => write(date, value)}
        minuteStep={block.config.minuteStep}
        hour12={block.config.hourCycle === 'h12'}
        {...withoutFocus}
      />
    </div>
  );
}
