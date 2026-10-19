import { Points } from './points.tsx';
import { range, useAnswer, type ControlProps } from './hooks.ts';

/** FLD-21: min (0 or 1) to max (at most 10); unanswered selects nothing (B7). */
export function LinearScale({ block, field }: ControlProps<'linear_scale'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <Points
      points={range(c.min, Math.min(10, Math.max(c.min + 1, c.max)))}
      value={answer.value}
      onChange={answer.set}
      onBlur={answer.onBlur}
      disabled={field.disabled || field.readOnly}
      inputId={field.ids.input}
      render={(n) => n}
      low={c.lowLabel}
      high={c.highLabel}
      variant="boxes"
    />
  );
}
