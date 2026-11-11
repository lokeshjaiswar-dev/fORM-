import { DsText } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

export function Url({ block, field }: ControlProps<'url'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <DsText
      id={field.ids.input}
      type="url"
      inputMode="url"
      autoComplete="url"
      value={answer.value ?? ''}
      placeholder={c.placeholder}
      prefixText={c.prefix}
      suffixText={c.suffix}
      onChange={(e) => answer.set(e.target.value)}
      onBlur={answer.onBlur}
      {...inputAttrs(field)}
    />
  );
}
