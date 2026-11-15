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

type SlotPick = { start: IsoInstant; end: IsoInstant };

/** FLD-35: the field name stays on the first row; date, then times, stack below it. */
export function AppointmentField({ block, field }: ControlProps<'appointment'>) {
  const { i18n, t } = useRenderer();
  const answer = useAnswer(block);
  const attrs = inputAttrs(field);
  const slots = useMemo(() => slotsOf(block.config), [block.config]);
  const days = [...new Set(slots.map((s) => s.day))];
  const selected = answer.value?.slots ?? (answer.value?.start ? [{ start: answer.value.start, end: answer.value.end }] : []);
  const selectedDay = (slots.find((s) => selected.some((pick) => pick.start === s.start))?.day ?? days[0]) as IsoDate | undefined;
  const [day, setDay] = useState<IsoDate | undefined>(selectedDay);
  const shown = slots.filter((s) => s.day === (day ?? selectedDay));
  const zone = block.config.allowRespondentTimeZone ? respondentZone() : block.config.timeZone;
  const many = block.config.allowMultipleTimes === true;

  const write = (next: SlotPick[]) => {
    const first = next[0];
    if (!first) {
      answer.set(undefined);
      return;
    }
    answer.set({
      start: first.start,
      end: first.end,
      respondentTimeZone: zone,
      ...(many && next.length > 0 ? { slots: next } : {}),
    });
  };

  const pick = (start: IsoInstant, end: IsoInstant) => {
    if (!many) {
      write([{ start, end }]);
      return;
    }
    const exists = selected.some((slot) => slot.start === start);
    write(exists ? selected.filter((slot) => slot.start !== start) : [...selected, { start, end }]);
  };

  return (
    <div className="fr-appointment">
      <label className="fr-appointment-date">
        <span className="fr-appointment-caption">{t(MESSAGES['appointment.day'])}</span>
        <input
          id={field.ids.input}
          className="fr-input"
          type="date"
          value={day ?? ''}
          min={days[0]}
          max={days[days.length - 1]}
          disabled={attrs.disabled}
          aria-invalid={attrs['aria-invalid']}
          aria-describedby={attrs['aria-describedby']}
          aria-required={attrs['aria-required']}
          onChange={(e) => {
            const next = (e.target.value || undefined) as IsoDate | undefined;
            setDay(next);
            if (many) return;
            if (answer.value) answer.set(undefined);
          }}
          onBlur={answer.onBlur}
        />
      </label>
      <div className="fr-appointment-slots" role="list">
        {shown.map((slot) => (
          <button
            key={slot.start}
            type="button"
            role="listitem"
            className="fr-appointment-slot"
            aria-pressed={selected.some((pick) => pick.start === slot.start)}
            aria-label={`${i18n.formatTime(slot.time, 'h12')} ${i18n.formatDate(slot.day, 'D MMM YYYY')}`}
            disabled={attrs.disabled || attrs.readOnly}
            onClick={() => pick(slot.start, slot.end)}
            onBlur={answer.onBlur}
          >
            {i18n.formatTime(slot.time, 'h12')}
          </button>
        ))}
      </div>
    </div>
  );
}
