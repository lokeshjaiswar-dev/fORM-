import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { RatingIcon } from './icons.tsx';
import { Points } from './points.tsx';
import { range, useAnswer, type ControlProps } from './hooks.ts';

/** FLD-20: 1..max (at most 10, B28). */
export function Rating({ block, field }: ControlProps<'rating'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const max = Math.min(10, Math.max(1, c.max));
  return (
    <Points
      points={range(1, max)}
      value={answer.value}
      onChange={answer.set}
      onBlur={answer.onBlur}
      disabled={field.disabled || field.readOnly}
      inputId={field.ids.input}
      label={(n) => t(MESSAGES['scale.point'], { value: n, max })}
      render={(n, filled) => <RatingIcon icon={c.icon} filled={filled} value={n} />}
      low={c.lowLabel}
      high={c.highLabel}
      variant={c.icon === 'number' ? 'boxes' : 'icons'}
    />
  );
}
