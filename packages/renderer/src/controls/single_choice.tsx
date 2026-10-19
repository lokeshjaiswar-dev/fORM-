import type { CSSProperties } from 'react';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';

const OTHER = '__other__';

/** FLD-10/12: radios, or a native select (the accessible dropdown); Other takes a typed answer. Image display arrives with the asset store. */
export function SingleChoice({ block, field }: ControlProps<'single_choice'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const options = useOptions(block.id, c.options, c.shuffle);
  const other = c.other?.enabled ? c.other : undefined;
  const otherLabel = other?.label?.trim() || t('system:other.label');
  const selected = answer.value ? (answer.value.optionId ?? (answer.value.other !== undefined ? OTHER : '')) : '';
  const locked = field.disabled || field.readOnly;
  const choose = (value: string) => {
    if (value === '') answer.set(undefined);
    else if (value === OTHER) answer.set({ optionId: null, other: answer.value?.other ?? '' });
    else answer.set({ optionId: value as OptionId });
  };
  const otherInput = other && selected === OTHER ? (
    <input
      id={`${field.ids.base}-other`}
      className="fr-input fr-other"
      type="text"
      aria-label={t(MESSAGES['choice.other_answer'], { label: otherLabel })}
      placeholder={other.placeholder?.trim() || t('system:other.placeholder')}
      maxLength={other.maxLength}
      value={answer.value?.other ?? ''}
      disabled={field.disabled}
      readOnly={field.readOnly || undefined}
      onChange={(e) => answer.set({ optionId: null, other: e.target.value })}
    />
  ) : null;

  if (c.display === 'dropdown') {
    const { readOnly: _readOnly, ...selectAttrs } = inputAttrs(field);
    return (
      <>
        <select
          id={field.ids.input}
          className="fr-input fr-select"
          value={selected}
          onChange={(e) => choose(e.target.value)}
          onBlur={answer.onBlur}
          {...selectAttrs}
          disabled={locked}
        >
          <option value="">{c.placeholder?.trim() || t('system:select.placeholder')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{text(o.label)}</option>
          ))}
          {other ? <option value={OTHER}>{otherLabel}</option> : null}
        </select>
        {otherInput}
      </>
    );
  }

  const items = [...options.map((o) => ({ value: o.id as string, label: text(o.label) })), ...(other ? [{ value: OTHER, label: otherLabel }] : [])];
  return (
    <>
      <div className="fr-choices" style={{ '--fr-columns': c.columns ?? 1 } as CSSProperties}>
        {items.map((item, i) => (
          <label key={item.value} className="fr-choice">
            <input
              type="radio"
              id={i === 0 ? field.ids.input : undefined}
              name={field.ids.base}
              value={item.value}
              checked={selected === item.value}
              disabled={locked}
              onChange={() => choose(item.value)}
              onBlur={answer.onBlur}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
      {otherInput}
    </>
  );
}
