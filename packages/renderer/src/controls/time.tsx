import type { IsoTime } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

/** FLD-19: one time, or a start and an end when the range is on (`answer.end` exists only then). */
export function TimeInput({ block, field }: ControlProps<'time'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const range = c.range?.enabled === true;
  const start = answer.value?.start ?? '';
  const end = answer.value?.end ?? '';
  const step = c.minuteStep * 60;
  const write = (nextStart: string, nextEnd: string) =>
    answer.set(nextStart || nextEnd ? { start: nextStart as IsoTime, ...(range && nextEnd ? { end: nextEnd as IsoTime } : {}) } : undefined);
  const attrs = inputAttrs(field);
  if (!range) {
    return (
      <input
        id={field.ids.input}
        className="fr-input fr-time"
        type="time"
        step={step}
        min={c.window?.from}
        max={c.window?.to}
        value={start}
        onChange={(e) => write(e.target.value, '')}
        onBlur={answer.onBlur}
        {...attrs}
      />
    );
  }
  const endId = `${field.ids.base}-end`;
  return (
    <div className="fr-range">
      <label className="fr-sublabel" htmlFor={field.ids.input}>{t(MESSAGES['time.start'])}</label>
      <input id={field.ids.input} className="fr-input fr-time" type="time" step={step} value={start} onChange={(e) => write(e.target.value, end)} onBlur={answer.onBlur} {...attrs} />
      <label className="fr-sublabel" htmlFor={endId}>{t(MESSAGES['time.end'])}</label>
      <input id={endId} className="fr-input fr-time" type="time" step={step} value={end} onChange={(e) => write(start, e.target.value)} onBlur={answer.onBlur} {...attrs} autoFocus={undefined} />
    </div>
  );
}
