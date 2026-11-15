import { useEffect, useState } from 'react';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';

/** One radio column for best and one for worst; commits when both sides are chosen. */
export function MaxDiffField({ block, field }: ControlProps<'maxdiff'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const options = useOptions(block.id, block.config.options, block.config.shuffle, block.apiOptions);
  const attrs = inputAttrs(field);
  const [best, setBest] = useState<OptionId | undefined>(answer.value?.best);
  const [worst, setWorst] = useState<OptionId | undefined>(answer.value?.worst);

  useEffect(() => {
    setBest(answer.value?.best);
    setWorst(answer.value?.worst);
  }, [answer.value?.best, answer.value?.worst]);

  const write = (part: 'best' | 'worst', id: OptionId) => {
    const nextBest = part === 'best' ? id : best;
    const nextWorst = part === 'worst' ? id : worst;
    setBest(nextBest);
    setWorst(nextWorst);
    if (nextBest && nextWorst) answer.set({ best: nextBest, worst: nextWorst });
    else answer.set(undefined);
  };

  return (
    <div className="fr-maxdiff-wrap">
      <table className="fr-maxdiff">
        <thead>
          <tr>
            <th>{t(MESSAGES['maxdiff.best'])}</th>
            <th />
            <th>{t(MESSAGES['maxdiff.worst'])}</th>
          </tr>
        </thead>
        <tbody>
          {options.map((option, i) => {
            const label = typeof option.label === 'string' ? option.label : text(option.label);
            return (
              <tr key={option.id}>
                <td>
                  <input
                    id={i === 0 ? field.ids.input : undefined}
                    type="radio"
                    name={`${field.ids.base}-best`}
                    value={option.id}
                    aria-label={`${t(MESSAGES['maxdiff.best'])}: ${label}`}
                    checked={best === option.id}
                    onChange={() => write('best', option.id)}
                    onBlur={answer.onBlur}
                    {...attrs}
                  />
                </td>
                <th scope="row">{label}</th>
                <td>
                  <input
                    type="radio"
                    name={`${field.ids.base}-worst`}
                    value={option.id}
                    aria-label={`${t(MESSAGES['maxdiff.worst'])}: ${label}`}
                    checked={worst === option.id}
                    onChange={() => write('worst', option.id)}
                    onBlur={answer.onBlur}
                    {...attrs}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
