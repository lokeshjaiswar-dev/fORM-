import type { DecimalString } from '@form/schema';
import { Affix } from './Affix.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

/** The answer is the typed text as a decimal string; validation reports anything that is not one (not_a_number). */
export function NumberInput({ block, field }: ControlProps<'number'>) {
  const answer = useAnswer(block);
  const c = block.config;
  const stepper = c.display === 'stepper';
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input
        id={field.ids.input}
        className="fr-input"
        type={stepper ? 'number' : 'text'}
        inputMode={c.integerOnly ? 'numeric' : 'decimal'}
        min={stepper ? c.min : undefined}
        max={stepper ? c.max : undefined}
        step={stepper ? (c.step ?? (c.integerOnly ? '1' : 'any')) : undefined}
        value={answer.value ?? ''}
        placeholder={c.placeholder}
        onChange={(e) => answer.set(e.target.value.trim() as DecimalString)}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
      />
    </Affix>
  );
}
