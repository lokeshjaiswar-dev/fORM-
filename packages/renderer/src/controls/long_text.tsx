import { graphemeLength } from '@form/i18n';
import { wordCount } from '@form/registry';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

export function LongText({ block, field }: ControlProps<'long_text'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const text = answer.value ?? '';
  const words = c.limit?.unit === 'words';
  const count = words ? wordCount(text) : graphemeLength(text);
  const max = c.limit?.max;
  const counterId = `${field.ids.base}-counter`;
  const counter = c.showCounter
    ? max === undefined
      ? t(words ? MESSAGES['counter.words_open'] : MESSAGES['counter.characters_open'], { count })
      : t(words ? MESSAGES['counter.words'] : MESSAGES['counter.characters'], { count, max })
    : null;
  const describedBy = [field.ids.describedBy, counter === null ? undefined : counterId].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <textarea
        id={field.ids.input}
        className="fr-input fr-textarea"
        rows={c.rows ?? 4}
        value={text}
        placeholder={c.placeholder}
        onChange={(e) => answer.set(e.target.value)}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
        aria-describedby={describedBy}
      />
      {counter === null ? null : (
        <p id={counterId} className="fr-counter" data-over={max !== undefined && count > max ? '' : undefined}>
          {counter}
        </p>
      )}
    </>
  );
}
