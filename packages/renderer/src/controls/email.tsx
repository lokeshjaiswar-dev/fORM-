import type { EmailAddress } from '@form/schema';
import { Affix } from './Affix.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

export function Email({ block, field }: ControlProps<'email'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input
        id={field.ids.input}
        className="fr-input"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={answer.value?.address ?? ''}
        placeholder={c.placeholder}
        onChange={(e) => answer.set({ address: e.target.value as EmailAddress })}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
      />
    </Affix>
  );
}
