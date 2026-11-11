import { TimePicker } from '@dmacq/ui';
import type { IsoTime } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { pickerAttrs, useAnswer, type ControlProps } from './hooks.ts';

/** FLD-19: one time, or a start and an end when the range is on (`answer.end` exists only then). */
export function TimeInput({ block, field }: ControlProps<'time'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const range = c.range?.enabled === true;
  const start = answer.value?.start ?? '';
  const end = answer.value?.end ?? '';
  const write = (nextStart: string, nextEnd: string) =>
    answer.set(nextStart || nextEnd ? { start: nextStart as IsoTime, ...(range && nextEnd ? { end: nextEnd as IsoTime } : {}) } : undefined);
  const shared = { minuteStep: c.minuteStep, onBlur: answer.onBlur, ...pickerAttrs(field) };
  const { autoFocus, ...withoutFocus } = shared;
  if (!range) {
    return (
      <TimePicker
        id={field.ids.input}
        value={start}
        onValueChange={(value) => write(value, '')}
        {...(c.window?.from ? { min: c.window.from } : {})}
        {...(c.window?.to ? { max: c.window.to } : {})}
        {...shared}
      />
    );
  }
  const endId = `${field.ids.base}-end`;
  return (
    <div className="fr-range">
      <label className="fr-sublabel" htmlFor={field.ids.input}>{t(MESSAGES['time.start'])}</label>
      <TimePicker id={field.ids.input} value={start} onValueChange={(value) => write(value, end)} {...shared} />
      <label className="fr-sublabel" htmlFor={endId}>{t(MESSAGES['time.end'])}</label>
      <TimePicker id={endId} value={end} onValueChange={(value) => write(start, value)} {...withoutFocus} />
    </div>
  );
}
