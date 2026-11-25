import { useContext } from 'react';
import { useEvaluation } from '../eval/context.ts';
import { Affix } from './Affix.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
import { useLookup } from './lookupContext.tsx';
import { LookupCombobox } from './LookupCombobox.tsx';
import { RowContext } from './rowContext.ts';
import { sanitizePreset } from './sanitize.ts';

function isFillBlank(placeholder: string | undefined): boolean {
  return placeholder === '_____';
}

export function ShortText({ block, field }: ControlProps<'short_text'>) {
  const answer = useAnswer(block);
  const { state } = useEvaluation();
  const rowId = useContext(RowContext);
  /* A value a rule or a row formula fills (set_value, row calculation) shows in place of the typed one. */
  const fromRow = rowId === undefined ? undefined : state.rowValues?.[block.id]?.[rowId];
  const filled = state.values[block.id];
  const fromRule = fromRow?.t === 'text' ? fromRow.v : filled?.type === 'short_text' ? filled.value : undefined;
  /* Server-side lookup: the picker field of a lookup becomes a searchable combobox (only when the host gave a source). */
  const lookup = useLookup()?.byPicker[block.id];
  const c = block.config;
  const attrs = {
    id: field.ids.input,
    type: 'text' as const,
    value: fromRule || answer.value || '',
    onChange: (e: { target: { value: string } }) => answer.set(sanitizePreset(e.target.value, c.preset, c.maxLength)),
    onBlur: answer.onBlur,
    ...inputAttrs(field),
  };
  if (lookup && !isFillBlank(c.placeholder)) {
    const { type: _type, ...inputProps } = attrs;
    return (
      <LookupCombobox
        source={lookup}
        inputProps={inputProps}
        value={attrs.value}
        placeholder={c.placeholder}
        onType={(text) => {
          answer.set(sanitizePreset(text, c.preset, c.maxLength));
          if (text === '') lookup.apply(null);
        }}
        onPick={(row) => {
          answer.set(row.label);
          lookup.apply(row);
        }}
        onBlur={answer.onBlur}
      />
    );
  }
  if (isFillBlank(c.placeholder)) {
    return (
      <span className="fr-blank-line">
        {c.prefix ? <span className="fr-blank-words">{c.prefix}</span> : null}
        <input className="fr-blank-input" placeholder="" {...attrs} />
        {c.suffix ? <span className="fr-blank-words">{c.suffix}</span> : null}
      </span>
    );
  }
  return (
    <Affix prefix={c.prefix} suffix={c.suffix}>
      <input className="fr-input" placeholder={c.placeholder} {...attrs} />
    </Affix>
  );
}
