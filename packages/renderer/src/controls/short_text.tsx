import { Affix } from './Affix.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

export function ShortText({ block, field }: ControlProps<'short_text'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input
        id={field.ids.input}
        className="fr-input"
        type="text"
        value={answer.value ?? ''}
        placeholder={c.placeholder}
        onChange={(e) => answer.set(e.target.value)}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
      />
    </Affix>
  );
}
