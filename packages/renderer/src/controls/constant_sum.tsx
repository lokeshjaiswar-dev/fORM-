import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, usePipes, type ControlProps } from './hooks.ts';

/** Number inputs per option; running total is shown against the target. */
export function ConstantSumField({ block, field }: ControlProps<'constant_sum'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const values = answer.value ?? {};
  const total = Object.values(values).reduce((a, n) => a + (typeof n === 'number' ? n : 0), 0);
  const attrs = inputAttrs(field);

  const setPart = (id: OptionId, raw: string) => {
    const next = { ...values };
    if (raw === '') delete next[id];
    else {
      const n = Number(raw);
      if (!Number.isInteger(n)) return;
      next[id] = n;
    }
    answer.set(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="fr-sum">
      {block.config.options.map((option, i) => {
        const label = typeof option.label === 'string' ? option.label : text(option.label);
        return (
          <div key={option.id} className="fr-sum-row">
            <label className="fr-label" htmlFor={i === 0 ? field.ids.input : `${field.ids.base}-${option.id}`}>{label}</label>
            <input
              id={i === 0 ? field.ids.input : `${field.ids.base}-${option.id}`}
              className="fr-input"
              type="number"
              inputMode="numeric"
              min={block.config.allowZero ? 0 : 1}
              max={block.config.target}
              value={values[option.id] ?? ''}
              onChange={(e) => setPart(option.id, e.target.value)}
              onBlur={answer.onBlur}
              {...attrs}
            />
          </div>
        );
      })}
      <p className="fr-sum-total">{t(MESSAGES['constant_sum.total'], { total, target: block.config.target })}</p>
    </div>
  );
}
