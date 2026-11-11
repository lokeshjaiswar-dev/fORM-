import type { EmailAddress } from '@form/schema';
import { DsText } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
import { sanitizeEmail } from './sanitize.ts';

export function Email({ block, field }: ControlProps<'email'>) {
  const answer = useAnswer(block);
  const c = block.config;
  return (
    <DsText
      id={field.ids.input}
      type="email"
      inputMode="email"
      autoComplete="email"
      value={answer.value?.address ?? ''}
      placeholder={c.placeholder}
      prefixText={c.prefix}
      suffixText={c.suffix}
      onChange={(e) => answer.set({ address: sanitizeEmail(e.target.value) as EmailAddress })}
      onBlur={answer.onBlur}
      {...inputAttrs(field)}
    />
  );
}
