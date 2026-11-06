import { Affix } from './Affix.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

function isFillBlank(placeholder: string | undefined): boolean {
  return placeholder === '_____';
}

export function ShortText({ block, field }: ControlProps<'short_text'>) {
  const answer = useAnswer(block);
  const c = block.config;
  const attrs = {
    id: field.ids.input,
    type: 'text' as const,
    value: answer.value ?? '',
    onChange: (e: { target: { value: string } }) => answer.set(e.target.value),
    onBlur: answer.onBlur,
    ...inputAttrs(field),
  };
  if (isFillBlank(c.placeholder)) {
    return (
      <span className="fr-blank-line">
        {c.prefix ? <span className="fr-blank-words">{c.prefix}</span> : null}
        <input className="fr-blank-input" placeholder="" {...attrs} />
        {c.suffix ? <span className="fr-blank-words">{c.suffix}</span> : null}
      </span>
    );
  }
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input className="fr-input" placeholder={c.placeholder} {...attrs} />
    </Affix>
  );
}
