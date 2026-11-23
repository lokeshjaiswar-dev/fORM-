import { type CSSProperties } from 'react';
import { RadioField, RadioGroup } from '@dmacq/ui';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { ChoicePicture } from './choicePicture.tsx';
import { DsCombobox, DsSelect } from './ds.tsx';
import { inputAttrs, useAnswer, useDependentChoice, useOptions, usePipes, type ControlProps } from './hooks.ts';

const OTHER = '__other__';

/** FLD-10/12: radios, a searchable or plain dropdown, or image tiles; Other takes a typed answer. */
export function SingleChoice({ block, field }: ControlProps<'single_choice'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const options = useOptions(block.id, c.options, c.shuffle, block.apiOptions);
  const { waitingFor } = useDependentChoice(block, options, field.disabled);
  const waitHint = waitingFor === undefined ? undefined : waitingFor ? t(MESSAGES['choice.choose_first'], { question: waitingFor }) : t(MESSAGES['choice.answer_above_first']);
  const hint = waitHint ? <p className="fr-hint fr-choice-wait">{waitHint}</p> : null;
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

  if (c.display === 'image') {
    return (
      <>
        {hint}
        <div className="fr-image-choices" style={{ '--fr-columns': c.columns ?? 2 } as CSSProperties}>
          {options.map((o, i) => (
            <label key={o.id} className="fr-image-choice" data-selected={selected === o.id ? 'true' : undefined}>
              <RadioGroup value={selected === o.id ? o.id : undefined} onValueChange={() => choose(o.id)} disabled={locked}>
                <RadioField id={i === 0 ? field.ids.input : undefined} value={o.id} label="" onBlur={answer.onBlur} />
              </RadioGroup>
              <ChoicePicture image={o.image} label={text(o.label)} />
              <span>{text(o.label)}</span>
            </label>
          ))}
        </div>
        {otherInput}
      </>
    );
  }

  if (c.display === 'dropdown') {
    const { readOnly: _readOnly, ...selectAttrs } = inputAttrs(field);
    const items = [...options.map((o) => ({ value: o.id as string, label: text(o.label) })), ...(other ? [{ value: OTHER, label: otherLabel }] : [])];
    const placeholder = waitHint ?? (c.placeholder?.trim() || t('system:select.placeholder'));
    const shared = {
      id: field.ids.input,
      value: selected,
      onChange: choose,
      options: items,
      placeholder,
      disabled: locked,
      'aria-invalid': selectAttrs['aria-invalid'],
      'aria-describedby': selectAttrs['aria-describedby'],
      'aria-required': selectAttrs['aria-required'],
    };
    return (
      <>
        {c.searchable ? <DsCombobox {...shared} searchPlaceholder={placeholder} /> : <DsSelect {...shared} onBlur={answer.onBlur} />}
        {otherInput}
      </>
    );
  }

  const items = [...options.map((o) => ({ value: o.id as string, label: text(o.label) })), ...(other ? [{ value: OTHER, label: otherLabel }] : [])];
  return (
    <>
      {hint}
      <RadioGroup
        className="fr-choices"
        style={{ '--fr-columns': c.columns ?? 1 } as CSSProperties}
        value={selected || undefined}
        onValueChange={choose}
        disabled={locked}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
      >
        {items.map((item, i) => (
          <RadioField key={item.value} id={i === 0 ? field.ids.input : undefined} value={item.value} label={item.label} onBlur={answer.onBlur} />
        ))}
      </RadioGroup>
      {otherInput}
    </>
  );
}
