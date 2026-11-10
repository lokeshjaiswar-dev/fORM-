import type { MatchingPromptId, OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';

/** Pair each prompt with one option; exclusive rows hide already chosen options. */
export function MatchingField({ block, field }: ControlProps<'matching'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const options = useOptions(block.id, block.config.options, block.config.shuffle);
  const pairs = answer.value ?? {};
  const taken = new Set(block.config.exclusive ? Object.values(pairs) : []);
  const attrs = inputAttrs(field);

  const setPair = (promptId: MatchingPromptId, optionId: OptionId | '') => {
    const next = { ...pairs };
    if (optionId === '') delete next[promptId];
    else next[promptId] = optionId;
    answer.set(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="fr-matching">
      {block.config.prompts.map((prompt, i) => {
        const chosen = pairs[prompt.id] ?? '';
        const choices = options.filter((o) => o.id === chosen || !taken.has(o.id));
        return (
          <div key={prompt.id} className="fr-matching-row">
            <label className="fr-label" htmlFor={i === 0 ? field.ids.input : `${field.ids.base}-${prompt.id}`}>{prompt.label}</label>
            <select
              id={i === 0 ? field.ids.input : `${field.ids.base}-${prompt.id}`}
              className="fr-input"
              value={chosen}
              onChange={(e) => setPair(prompt.id, e.target.value as OptionId | '')}
              onBlur={answer.onBlur}
              {...attrs}
            >
              <option value="">{t(MESSAGES['matching.pick'])}</option>
              {choices.map((option) => (
                <option key={option.id} value={option.id}>{typeof option.label === 'string' ? option.label : text(option.label)}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
