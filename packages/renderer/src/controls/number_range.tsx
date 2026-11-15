import { useEffect, useState } from 'react';
import type { DecimalString } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
import { sanitizeDecimal } from './sanitize.ts';

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Two numeric inputs that commit when both sides parse as decimals. */
export function NumberRangeField({ block, field }: ControlProps<'number_range'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const [from, setFrom] = useState(answer.value?.from ?? '');
  const [to, setTo] = useState(answer.value?.to ?? '');

  useEffect(() => {
    setFrom(answer.value?.from ?? '');
    setTo(answer.value?.to ?? '');
  }, [answer.value?.from, answer.value?.to]);

  const digits = (raw: string) => sanitizeDecimal(raw, block.config.integerOnly === true, block.config.allowNegative !== false);

  const commit = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (DECIMAL.test(nextFrom) && DECIMAL.test(nextTo)) answer.set({ from: nextFrom as DecimalString, to: nextTo as DecimalString });
    else answer.set(undefined);
  };

  const attrs = inputAttrs(field);
  return (
    <div className="fr-number-range">
      <label className="fr-label" htmlFor={field.ids.input}>{t(MESSAGES['number_range.from'])}</label>
      <input
        id={field.ids.input}
        className="fr-input"
        type="text"
        inputMode={block.config.integerOnly ? 'numeric' : 'decimal'}
        value={from}
        onChange={(e) => commit(digits(e.target.value), to)}
        onBlur={answer.onBlur}
        {...attrs}
      />
      <label className="fr-label" htmlFor={`${field.ids.input}-to`}>{t(MESSAGES['number_range.to'])}</label>
      <input
        id={`${field.ids.input}-to`}
        className="fr-input"
        type="text"
        inputMode={block.config.integerOnly ? 'numeric' : 'decimal'}
        value={to}
        onChange={(e) => commit(from, digits(e.target.value))}
        onBlur={answer.onBlur}
        {...attrs}
      />
    </div>
  );
}
