import { useMemo, useState, type CSSProperties } from 'react';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { ChoicePicture } from './choicePicture.tsx';
import { inputAttrs, useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';
import { NativeSelect } from './native.tsx';

const OTHER = '__other__';

/**
 * A searchable dropdown shows its search box only from this many options. Below it the box is a second input that
 * looks like a field of its own above a short list (the "extra field" DMS users saw on every dropdown); the
 * native select already jumps by typed letters.
 */
export const SEARCH_FROM_OPTIONS = 8;

/**
 * FLD-10/12: radios, a native select (the accessible dropdown) with an optional search box above it, or image tiles;
 * Other takes a typed answer.
 */
export function SingleChoice({ block, field }: ControlProps<'single_choice'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const options = useOptions(block.id, c.options, c.shuffle, block.apiOptions);
  const other = c.other?.enabled ? c.other : undefined;
  const otherLabel = other?.label?.trim() || t('system:other.label');
  const selected = answer.value ? (answer.value.optionId ?? (answer.value.other !== undefined ? OTHER : '')) : '';
  const locked = field.disabled || field.readOnly;
  const [query, setQuery] = useState('');
  const searchable = c.searchable === true && options.length >= SEARCH_FROM_OPTIONS;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchable || q === '') return options;
    /* The chosen option stays listed while the search narrows the rest, so the select never shows a blank for it. */
    return options.filter((o) => o.id === selected || text(o.label).toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [searchable, options, query, selected, text]);
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
        <div className="fr-image-choices" style={{ '--fr-columns': c.columns ?? 2 } as CSSProperties}>
          {options.map((o, i) => (
            <label key={o.id} className="fr-image-choice" data-selected={selected === o.id ? 'true' : undefined}>
              <input
                type="radio"
                id={i === 0 ? field.ids.input : undefined}
                name={field.ids.base}
                value={o.id}
                checked={selected === o.id}
                disabled={locked}
                onChange={() => choose(o.id)}
                onBlur={answer.onBlur}
              />
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
    const placeholder = c.placeholder?.trim() || t('system:select.placeholder');
    const items = [...filtered.map((o) => ({ value: o.id as string, label: text(o.label) })), ...(other ? [{ value: OTHER, label: otherLabel }] : [])];
    return (
      <>
        {searchable ? (
          <input
            className="fr-input fr-search"
            type="search"
            value={query}
            placeholder={t(MESSAGES['dropdown.search'])}
            onChange={(e) => setQuery(e.target.value)}
            disabled={locked}
            aria-label={t(MESSAGES['dropdown.search'])}
          />
        ) : null}
        <NativeSelect
          id={field.ids.input}
          value={selected}
          onChange={choose}
          onBlur={answer.onBlur}
          options={items}
          placeholder={placeholder}
          disabled={locked}
          autoFocus={selectAttrs.autoFocus}
          aria-invalid={selectAttrs['aria-invalid']}
          aria-describedby={selectAttrs['aria-describedby']}
          aria-required={selectAttrs['aria-required']}
        />
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
