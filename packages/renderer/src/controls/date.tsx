import { useRef, useState } from 'react';
import type { DateBound, DatePattern, IsoDate } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { NUMERIC, formatDate, parseDate, type DateFormat } from './dateFormat.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const absolute = (bound: DateBound | undefined): IsoDate | undefined => (bound?.kind === 'absolute' ? bound.date : undefined);

const NAME = { D: MESSAGES['date.day'], M: MESSAGES['date.month'], Y: MESSAGES['date.year'] } as const;

const patternOf = (pattern: DatePattern, separator: string | undefined): DateFormat | undefined => {
  const base = NUMERIC[pattern];
  return base && separator ? { ...base, separator } : base;
};

/**
 * FLD-16/17. The value is always ISO. With picker `native` (or a month-name pattern) it is the browser's own date
 * input, shown in the respondent's locale. Otherwise the field shows the block's pattern (DD-MM-YYYY by default, as DMS
 * stores and shows it, and as the builder canvas draws it), takes typed dates in that order, and its calendar button
 * opens the browser's own picker. Only absolute bounds become min/max hints; validation checks every bound.
 */
export function DateInput({ block, field }: ControlProps<'date'>) {
  const answer = useAnswer(block);
  const c = block.config;
  const limits = c.limits;
  const format = c.picker === 'native' ? undefined : patternOf(c.pattern, c.separator);
  if (!format) {
    return (
      <input
        id={field.ids.input}
        className="fr-input fr-date"
        type="date"
        min={absolute(limits?.min)}
        max={absolute(limits?.max)}
        value={answer.value ?? ''}
        onChange={(e) => answer.set(e.target.value ? (e.target.value as IsoDate) : undefined)}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
      />
    );
  }
  return <PatternDate block={block} field={field} format={format} answer={answer} />;
}

function PatternDate({ field, format, answer, block }: ControlProps<'date'> & { format: DateFormat; answer: ReturnType<typeof useAnswer<'date'>> }) {
  const { t } = useRenderer();
  const value = answer.value ?? undefined;
  const [text, setText] = useState(() => (value ? formatDate(value, format) : ''));
  const [seen, setSeen] = useState(value);
  const picker = useRef<HTMLInputElement>(null);
  const attrs = inputAttrs(field);
  const locked = field.disabled || field.readOnly;

  /* A value set from outside (the calendar, a default, a reset) shows in the pattern; half-typed text is left alone. */
  if (seen !== value) {
    setSeen(value);
    const typed = parseDate(text, format);
    if (typed !== value) setText(value ? formatDate(value, format) : typed ? '' : text);
  }

  /* The author's own placeholder (Date settings) replaces the pattern hint ("dd/mm/yyyy"). */
  const placeholder = block.config.placeholder?.trim() || format.order.map((p) => t(NAME[p])).join(format.separator);
  const limits = block.config.limits;
  return (
    <div className="fr-date-field">
      <input
        id={field.ids.input}
        className="fr-input fr-date fr-date-text"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          answer.set(parseDate(e.target.value, format));
        }}
        onBlur={() => {
          const parsed = parseDate(text, format);
          if (parsed) setText(formatDate(parsed, format));
          answer.onBlur();
        }}
        {...attrs}
      />
      <button
        type="button"
        className="fr-date-button"
        aria-label={t(MESSAGES['date.open_calendar'])}
        disabled={locked}
        tabIndex={-1}
        onClick={() => {
          const el = picker.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 2.5v3M17 2.5v3M3.5 8.5h17M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5z" />
        </svg>
      </button>
      <input
        ref={picker}
        className="fr-date-picker"
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        min={absolute(limits?.min)}
        max={absolute(limits?.max)}
        value={value ?? ''}
        disabled={locked}
        onChange={(e) => {
          const next = e.target.value ? (e.target.value as IsoDate) : undefined;
          setText(next ? formatDate(next, format) : '');
          answer.set(next);
        }}
      />
    </div>
  );
}
