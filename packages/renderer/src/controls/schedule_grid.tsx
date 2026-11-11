import type { IsoTime, Weekday } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { DsCheckCell } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const DAYS = ['schedule.sun', 'schedule.mon', 'schedule.tue', 'schedule.wed', 'schedule.thu', 'schedule.fri', 'schedule.sat'] as const;

/** Checkbox grid: weekday columns, time-slot rows. */
export function ScheduleGridField({ block, field }: ControlProps<'schedule_grid'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const picked = answer.value ?? [];
  const attrs = inputAttrs(field);
  const has = (day: Weekday, time: IsoTime) => picked.some((c) => c.weekday === day && c.time === time);

  const toggle = (day: Weekday, time: IsoTime, on: boolean) => {
    const next = on ? [...picked, { weekday: day, time }] : picked.filter((c) => !(c.weekday === day && c.time === time));
    answer.set(next.length === 0 ? undefined : next);
  };

  return (
    <div className="fr-schedule-wrap">
      <table className="fr-schedule">
        <thead>
          <tr>
            <th />
            {block.config.weekdays.map((day) => (
              <th key={day}>{t(MESSAGES[DAYS[day]!])}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.config.slots.map((slot, ri) => (
            <tr key={slot}>
              <th scope="row">{slot}</th>
              {block.config.weekdays.map((day, ci) => {
                const name = `${t(MESSAGES[DAYS[day]!])} ${slot}`;
                return (
                  <td key={day}>
                    <DsCheckCell
                      id={ri === 0 && ci === 0 ? field.ids.input : undefined}
                      checked={has(day, slot)}
                      disabled={attrs.disabled}
                      aria-invalid={attrs['aria-invalid']}
                      aria-label={name}
                      onChange={(on) => toggle(day, slot, on)}
                      onBlur={answer.onBlur}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
