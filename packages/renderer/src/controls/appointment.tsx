import { useMemo, useState } from 'react';
import { Chip } from '@dmacq/ui';
import { slotsOf } from './appointmentSlots.ts';
import type { IsoDate, IsoInstant, TimeZone } from '@form/schema';
import { useRenderer } from '../context.ts';
import { DsSelect } from './ds.tsx';
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
  const { i18n } = useRenderer();
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
      <DsSelect
        id={field.ids.input}
        value={day ?? ''}
        allowEmpty={false}
        onChange={(next) => setDay((next || undefined) as IsoDate | undefined)}
        onBlur={answer.onBlur}
        options={days.map((d) => ({ value: d, label: i18n.formatDate(d, 'D MMM YYYY') || d }))}
        disabled={attrs.disabled}
        aria-invalid={attrs['aria-invalid']}
        aria-describedby={attrs['aria-describedby']}
        aria-required={attrs['aria-required']}
      />
      <div className="fr-appointment-slots" role="list">
        {shown.map((slot) => (
          <Chip
            key={slot.start}
            kind="filter"
            size="md"
            color="primary"
            selected={selectedStart === slot.start}
            role="listitem"
            aria-label={`${i18n.formatTime(slot.time, 'h12')} ${i18n.formatDate(slot.day, 'D MMM YYYY')}`}
            disabled={attrs.disabled || attrs.readOnly}
            onClick={() => pick(slot.start, slot.end)}
            onBlur={answer.onBlur}
          >
            {i18n.formatTime(slot.time, 'h12')}
          </Chip>
        ))}
      </div>
    </div>
  );
}
