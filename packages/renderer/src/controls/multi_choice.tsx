import { useState, type CSSProperties } from 'react';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';

/** FLD-11/13: checkboxes, or a disclosure that opens the same checkboxes (multi-select dropdown); exclusive options clear the rest. */
export function MultiChoice({ block, field }: ControlProps<'multi_choice'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const options = useOptions(block.id, c.options, c.shuffle);
  const other = c.other?.enabled ? c.other : undefined;
  const otherLabel = other?.label?.trim() || t('system:other.label');
  const [open, setOpen] = useState(false);
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

  const panelId = `${field.ids.base}-options`;
  const dropdown = c.display === 'dropdown';
  const list = (
    <div id={panelId} className="fr-choices" hidden={dropdown && !open} style={{ '--fr-columns': c.columns ?? 1 } as CSSProperties}>
      {options.map((o, i) => (
        <label key={o.id} className="fr-choice">
          <input
            type="checkbox"
            id={i === 0 ? field.ids.input : undefined}
            value={o.id}
            checked={ids.includes(o.id)}
            disabled={locked}
            aria-invalid={field.invalid || undefined}
            onChange={(e) => toggle(o.id, e.target.checked)}
            onBlur={answer.onBlur}
          />
          <span>{text(o.label)}</span>
        </label>
      ))}
      {other ? (
        <label className="fr-choice">
          <input type="checkbox" checked={otherOn} disabled={locked} aria-invalid={field.invalid || undefined} onChange={(e) => toggleOther(e.target.checked)} />
          <span>{otherLabel}</span>
        </label>
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
  if (!dropdown) return list;
  const count = ids.length + (otherOn ? 1 : 0);
  return (
    <div className="fr-disclosure">
      <button type="button" className="fr-input fr-select fr-disclosure-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        {t(MESSAGES['dropdown.summary'], { count })}
      </button>
      {list}
    </div>
  );
}
