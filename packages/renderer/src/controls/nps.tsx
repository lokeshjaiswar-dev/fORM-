import { Points } from './points.tsx';
import { range, useAnswer, type ControlProps } from './hooks.ts';

/** FLD-22: 0..10; unanswered selects nothing (B7). */
export function Nps({ block, field }: ControlProps<'nps'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <Points
      points={range(0, 10)}
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
