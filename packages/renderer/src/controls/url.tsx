import { Affix } from './Affix.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

export function Url({ block, field }: ControlProps<'url'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input
        id={field.ids.input}
        className="fr-input"
        type="url"
        inputMode="url"
        autoComplete="url"
        value={answer.value ?? ''}
        placeholder={c.placeholder}
        onChange={(e) => answer.set(e.target.value)}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
      />
    </Affix>
  );
}
