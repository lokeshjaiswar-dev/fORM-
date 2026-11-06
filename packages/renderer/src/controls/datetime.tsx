import type { DateBound, IsoInstant, IsoLocalDateTime, TimeZone } from '@form/schema';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): string | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

const zoneOf = (configured: TimeZone | 'respondent'): TimeZone =>
  (configured === 'respondent' ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') : configured) as TimeZone;

function pack(local: string, timeZone: TimeZone): { local: IsoLocalDateTime; timeZone: TimeZone; instant: IsoInstant } | undefined {
  if (!local) return undefined;
  const instant = new Date(`${local}:00`).toISOString() as IsoInstant;
  return { local: local as IsoLocalDateTime, timeZone, instant };
}

/** FLD-18: native datetime-local; the stored answer keeps local, zone and instant. */
export function DateTimeInput({ block, field }: ControlProps<'datetime'>) {
  const answer = useAnswer(block);
  const tz = zoneOf(block.config.timeZone);
  const limits = block.config.limits;
  return (
    <input
      id={field.ids.input}
      className="fr-input fr-datetime"
      type="datetime-local"
      step={block.config.minuteStep * 60}
      min={absolute(limits?.min) ? `${absolute(limits?.min)}T00:00` : undefined}
      max={absolute(limits?.max) ? `${absolute(limits?.max)}T23:59` : undefined}
      value={answer.value?.local ?? ''}
      onChange={(e) => answer.set(pack(e.target.value, tz))}
      onBlur={answer.onBlur}
      {...inputAttrs(field)}
    />
  );
}
