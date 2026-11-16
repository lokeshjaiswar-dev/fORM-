import { useContext } from 'react';
import { useEvaluation } from '../eval/context.ts';
import { DsText } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
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
  const c = block.config;
  const attrs = {
    id: field.ids.input,
    value: field.readOnly ? (fromRule ?? '') : (answer.value || fromRule || ''),
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
