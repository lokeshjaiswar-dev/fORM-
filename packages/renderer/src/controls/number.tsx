import type { DecimalString } from '@form/schema';
import { DsText, Slider } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
import { sanitizeDecimal } from './sanitize.ts';

/** The answer is the typed text as a decimal string; validation reports anything that is not one (not_a_number). */
export function NumberInput({ block, field }: ControlProps<'number'>) {
  const answer = useAnswer(block);
  const c = block.config;
  const stepper = c.display === 'stepper';
  const slider = stepper && c.min !== undefined && c.max !== undefined;
  const step = c.step ?? (c.integerOnly ? '1' : 'any');
  const attrs = inputAttrs(field);
  if (slider) {
    const min = Number(c.min);
    const max = Number(c.max);
    const numeric = Number(answer.value ?? min);
    return (
      <div className="fr-slider">
        {c.prefix ? <span className="fr-affix-text">{c.prefix}</span> : null}
        <span className="fr-slider-edge">{c.min}</span>
        <Slider
          min={min}
          max={max}
          step={step === 'any' ? 1 : Number(step) || 1}
          value={[Number.isFinite(numeric) ? numeric : min]}
          onValueChange={(next) => answer.set(String(next[0] ?? min) as DecimalString)}
          disabled={attrs.disabled}
          invalid={field.invalid}
          {...(attrs['aria-describedby'] !== undefined ? { 'aria-describedby': attrs['aria-describedby'] } : {})}
          aria-labelledby={field.ids.label}
          showValue="active"
        />
        <span className="fr-slider-edge">{c.max}</span>
        {c.suffix ? <span className="fr-affix-text">{c.suffix}</span> : null}
      </div>
    );
  }
  return (
    <DsText
      id={field.ids.input}
      type={stepper ? 'number' : 'text'}
      inputMode={c.integerOnly ? 'numeric' : 'decimal'}
      min={stepper ? c.min : undefined}
      max={stepper ? c.max : undefined}
      step={stepper ? step : undefined}
      value={answer.value ?? ''}
      placeholder={c.placeholder}
      prefixText={c.prefix}
      suffixText={c.suffix}
      onChange={(e) => answer.set(sanitizeDecimal(e.target.value, c.integerOnly === true, c.allowNegative !== false) as DecimalString)}
      onBlur={answer.onBlur}
      {...attrs}
    />
  );
}
