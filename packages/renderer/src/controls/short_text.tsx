import { useContext } from 'react';
import { useEvaluation } from '../eval/context.ts';
import { DsSelect, DsText } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
import { useLookup } from './lookupContext.tsx';
import { RowContext } from './rowContext.ts';
import { sanitizePreset } from './sanitize.ts';

function isFillBlank(placeholder: string | undefined): boolean {
  return placeholder === '_____';
}

export function ShortText({ block, field }: ControlProps<'short_text'>) {
  const answer = useAnswer(block);
  const { state } = useEvaluation();
  const rowId = useContext(RowContext);
  const fromRow = rowId === undefined ? undefined : state.rowValues?.[block.id]?.[rowId];
  const filled = state.values[block.id];
  const fromRule = fromRow?.t === 'text' ? fromRow.v : filled?.type === 'short_text' ? filled.value : undefined;
  const lookup = useLookup()?.byPicker[block.id];
  const c = block.config;
  if (lookup && lookup.rows.length > 0 && !isFillBlank(c.placeholder)) {
    const selected = lookup.rows.find((row) => row.label === (answer.value ?? ''));
    return (
      <DsSelect
        id={field.ids.input}
        value={selected ? String(selected.index) : ''}
        onChange={(id) => {
          if (id === '') {
            answer.set(undefined);
            lookup.apply(null);
            return;
          }
          const row = lookup.rows.find((item) => String(item.index) === id);
          if (!row) return;
          answer.set(row.label);
          lookup.apply(row.index);
        }}
        options={lookup.rows.map((row) => ({ value: String(row.index), label: row.label }))}
        placeholder={c.placeholder || 'Select…'}
        disabled={field.disabled || field.readOnly}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field.ids.describedBy}
        aria-required={field.required || undefined}
      />
    );
  }
  const attrs = {
    id: field.ids.input,
    value: fromRule || answer.value || '',
    onChange: (e: { target: { value: string } }) => answer.set(sanitizePreset(e.target.value, c.preset, c.maxLength)),
    onBlur: answer.onBlur,
    ...inputAttrs(field),
  };
  if (isFillBlank(c.placeholder)) {
    return (
      <span className="fr-blank-line">
        {c.prefix ? <span className="fr-blank-words">{c.prefix}</span> : null}
        <input className="fr-blank-input" placeholder="" type="text" {...attrs} />
        {c.suffix ? <span className="fr-blank-words">{c.suffix}</span> : null}
      </span>
    );
  }
  return <DsText type="text" placeholder={c.placeholder} prefixText={c.prefix} suffixText={c.suffix} {...attrs} />;
}
