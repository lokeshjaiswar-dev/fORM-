import { useMemo, useState } from 'react';
import { slotsOf } from './appointmentSlots.ts';
import type { IsoDate, IsoInstant, TimeZone } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

function respondentZone(): TimeZone {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone as TimeZone;
  } catch {
    return 'UTC' as TimeZone;
  }
}

/** FLD-35: pick a day, then a slot generated from weekly hours. */
export function AppointmentField({ block, field }: ControlProps<'appointment'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const attrs = inputAttrs(field);
  const slots = useMemo(() => slotsOf(block.config), [block.config]);
  const days = [...new Set(slots.map((s) => s.day))];
  const selectedStart = answer.value?.start;
  const selectedDay = (slots.find((s) => s.start === selectedStart)?.day ?? days[0]) as IsoDate | undefined;
  const [day, setDay] = useState<IsoDate | undefined>(selectedDay);
  const shown = slots.filter((s) => s.day === (day ?? selectedDay));
  const zone = block.config.allowRespondentTimeZone ? respondentZone() : block.config.timeZone;

  const pick = (start: IsoInstant, end: IsoInstant) => {
    answer.set({ start, end, respondentTimeZone: zone });
  };

  return (
    <div className="fr-appointment">
      <label className="fr-label" htmlFor={`${field.ids.input}-day`}>{t(MESSAGES['appointment.day'])}</label>
      <select
        id={`${field.ids.input}-day`}
        className="fr-input"
        value={day ?? ''}
        onChange={(e) => setDay((e.target.value || undefined) as IsoDate | undefined)}
        onBlur={answer.onBlur}
        {...attrs}
      >
        {days.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <div className="fr-appointment-slots" role="list">
        {shown.map((slot) => (
          <button
            key={slot.start}
            type="button"
            role="listitem"
            className="fr-appointment-slot"
            aria-pressed={selectedStart === slot.start}
            aria-label={`${slot.time} ${slot.day}`}
            disabled={attrs.disabled || attrs.readOnly}
            onClick={() => pick(slot.start, slot.end)}
          >
            {slot.time}
          </button>
        ))}
      </div>
    </div>
  );
}
