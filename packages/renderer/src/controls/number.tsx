import type { CSSProperties } from 'react';
import type { DecimalString } from '@form/schema';
import { Affix } from './Affix.tsx';
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
    const current = Number.isFinite(numeric) ? numeric : min;
    /* How far the thumb is along the track, for the filled part of the track (styles.css reads `--fr-fill`). */
    const fill = max > min ? Math.min(100, Math.max(0, ((current - min) / (max - min)) * 100)) : 0;
    return (
      <div className="fr-slider">
        {c.prefix ? <span className="fr-affix-text">{c.prefix}</span> : null}
        <span className="fr-slider-edge">{c.min}</span>
        <input
          id={field.ids.input}
          className="fr-range-input"
          type="range"
          min={c.min}
          max={c.max}
          step={step}
          value={String(current)}
          style={{ '--fr-fill': `${fill}%` } as CSSProperties}
          onChange={(e) => answer.set(e.target.value.trim() as DecimalString)}
          onBlur={answer.onBlur}
          {...attrs}
          /* A range input has no read-only state: lock it instead, so a read-only field cannot be moved. */
          disabled={field.disabled || field.readOnly}
        />
        <span className="fr-slider-edge">{c.max}</span>
        {c.suffix ? <span className="fr-affix-text">{c.suffix}</span> : null}
        <output className="fr-slider-value" htmlFor={field.ids.input}>{current}</output>
      </div>
    );
  }
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input
        id={field.ids.input}
        className="fr-input"
        type={stepper ? 'number' : 'text'}
        inputMode={c.integerOnly ? 'numeric' : 'decimal'}
        min={stepper ? c.min : undefined}
        max={stepper ? c.max : undefined}
        step={stepper ? step : undefined}
        value={answer.value ?? ''}
        placeholder={c.placeholder}
        onChange={(e) => answer.set(sanitizeDecimal(e.target.value, c.integerOnly === true, c.allowNegative !== false) as DecimalString)}
        onBlur={answer.onBlur}
        {...attrs}
      />
    </Affix>
  );
}
