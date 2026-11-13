import { type CSSProperties } from 'react';
import { CheckboxField } from '@dmacq/ui';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { ChoicePicture } from './choicePicture.tsx';
import { DsMultiSelect } from './ds.tsx';
import { useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';

const OTHER = '__other__';

/** FLD-11/13: checkboxes, or a multi-select; exclusive options clear the rest. */
export function MultiChoice({ block, field }: ControlProps<'multi_choice'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const options = useOptions(block.id, c.options, c.shuffle, block.apiOptions);
  const other = c.other?.enabled ? c.other : undefined;
  const otherLabel = other?.label?.trim() || t('system:other.label');
  const ids = answer.value?.optionIds ?? [];
  const otherOn = answer.value?.other !== undefined;
  const exclusive = new Set<OptionId>(c.exclusiveOptionIds ?? []);
  const locked = field.disabled || field.readOnly;

  const write = (optionIds: OptionId[], otherText: string | undefined) =>
    answer.set(optionIds.length || otherText !== undefined ? { optionIds, ...(otherText !== undefined ? { other: otherText } : {}) } : undefined);
  const toggle = (id: OptionId, on: boolean) => {
    if (!on) return write(ids.filter((x) => x !== id), answer.value?.other);
    if (exclusive.has(id)) return write([id], undefined);
    return write([...ids.filter((x) => !exclusive.has(x)), id], answer.value?.other);
  };
  const toggleOther = (on: boolean) => write(on ? ids.filter((x) => !exclusive.has(x)) : ids, on ? (answer.value?.other ?? '') : undefined);

  const applyIds = (next: string[]) => {
    const hasOther = next.includes(OTHER);
    const picked = next.filter((id) => id !== OTHER) as OptionId[];
    const last = picked[picked.length - 1];
    if (last && exclusive.has(last)) return write([last], undefined);
    const cleaned = picked.filter((id) => !exclusive.has(id));
    write(cleaned, hasOther ? (answer.value?.other ?? '') : undefined);
  };

  if (c.display === 'image') {
    return (
      <div className="fr-image-choices" style={{ '--fr-columns': c.columns ?? 2 } as CSSProperties}>
          {options.map((o, i) => (
            <label key={o.id} className="fr-image-choice" data-selected={ids.includes(o.id) ? 'true' : undefined}>
              <CheckboxField
                id={i === 0 ? field.ids.input : undefined}
                label=""
                checked={ids.includes(o.id)}
                disabled={locked}
                aria-invalid={field.invalid || undefined}
                onCheckedChange={(on) => toggle(o.id, on === true)}
                onBlur={answer.onBlur}
              />
              <ChoicePicture image={o.image} label={text(o.label)} />
              <span>{text(o.label)}</span>
            </label>
          ))}
      </div>
    );
  }

  if (c.display === 'dropdown') {
    const items = [
      ...options.map((o) => ({ value: o.id as string, label: text(o.label) })),
      ...(other ? [{ value: OTHER, label: otherLabel }] : []),
    ];
    const selected = [...ids, ...(otherOn ? [OTHER] : [])];
    return (
      <>
        <DsMultiSelect
          id={field.ids.input}
          value={selected}
          onChange={applyIds}
          options={items}
          placeholder={c.placeholder?.trim() || t('system:select.placeholder')}
          disabled={locked}
          aria-invalid={field.invalid || undefined}
          aria-describedby={field.ids.describedBy}
          aria-required={field.required || undefined}
          aria-labelledby={field.ids.label}
        />
        {other && otherOn ? (
          <input
            className="fr-input fr-other"
            type="text"
            aria-label={t(MESSAGES['choice.other_answer'], { label: otherLabel })}
            placeholder={other.placeholder?.trim() || t('system:other.placeholder')}
            maxLength={other.maxLength}
            value={answer.value?.other ?? ''}
            disabled={field.disabled}
            readOnly={field.readOnly || undefined}
            onChange={(e) => write(ids, e.target.value)}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="fr-choices" style={{ '--fr-columns': c.columns ?? 1 } as CSSProperties}>
      {options.map((o, i) => (
        <CheckboxField
          key={o.id}
          id={i === 0 ? field.ids.input : undefined}
          label={text(o.label)}
          checked={ids.includes(o.id)}
          disabled={locked}
          aria-invalid={field.invalid || undefined}
          onCheckedChange={(on) => toggle(o.id, on === true)}
          onBlur={answer.onBlur}
        />
      ))}
      {other ? (
        <CheckboxField
          label={otherLabel}
          checked={otherOn}
          disabled={locked}
          aria-invalid={field.invalid || undefined}
          onCheckedChange={(on) => toggleOther(on === true)}
        />
      ) : null}
      {other && otherOn ? (
        <input
          className="fr-input fr-other"
          type="text"
          aria-label={t(MESSAGES['choice.other_answer'], { label: otherLabel })}
          placeholder={other.placeholder?.trim() || t('system:other.placeholder')}
          maxLength={other.maxLength}
          value={answer.value?.other ?? ''}
          disabled={field.disabled}
          readOnly={field.readOnly || undefined}
          onChange={(e) => write(ids, e.target.value)}
        />
      ) : null}
    </div>
  );
}
