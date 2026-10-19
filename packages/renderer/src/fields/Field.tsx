import type { CSSProperties, ReactNode } from 'react';
import { useFormState } from 'react-hook-form';
import { isAvailable } from '@form/registry';
import type { BlockStyle, FieldBlock, StoredBlock } from '@form/schema';
import { useRenderer } from '../context.ts';
import { CONTROLS, type Control, type FieldIds, type FieldState } from '../controls/index.ts';
import { usePipes } from '../controls/hooks.ts';
import { useEvaluation } from '../eval/context.ts';
import { MESSAGES } from '../messages.ts';
import { RichTextView } from '../richtext/RichTextView.tsx';
import { cssColor } from '../theme/cssVars.ts';

const WEIGHTS: Readonly<Record<NonNullable<BlockStyle['labelWeight']>, number>> = { normal: 400, medium: 500, semibold: 600, bold: 700 };

/** PROP-14 block styles as CSS variables the field's label and input read. */
function styleVars(style: BlockStyle | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const vars: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined) vars[name] = value;
  };
  set('--fr-label-color', cssColor(style.labelColor));
  set('--fr-input-color', cssColor(style.inputTextColor));
  set('--fr-input-bg', cssColor(style.inputBg));
  set('--fr-input-border', cssColor(style.borderColor));
  set('--fr-placeholder', cssColor(style.placeholderColor));
  if (style.labelSizePx) vars['--fr-label-size'] = `${style.labelSizePx}px`;
  if (style.inputSizePx) vars['--fr-input-size'] = `${style.inputSizePx}px`;
  if (style.labelWeight) vars['--fr-label-weight'] = String(WEIGHTS[style.labelWeight]);
  if (style.align) vars['--fr-align'] = style.align;
  return vars as CSSProperties;
}

function RequiredMark() {
  const { t } = useRenderer();
  return (
    <>
      {' '}
      <span className="fr-required" aria-hidden="true">*</span>
      <span className="fr-sr-only">{t(MESSAGES['field.required'])}</span>
    </>
  );
}

/** One field: label, description, control and error, wired with ids for `htmlFor`, `aria-describedby` and focus. */
function FieldShell({ block, control }: { block: FieldBlock; control: Control<never> }) {
  const { idFor } = useRenderer();
  const { resolve } = usePipes();
  const { state } = useEvaluation();
  const { errors } = useFormState({ name: block.id });
  const error = errors[block.id]?.message as string | undefined;
  const base = idFor(block.id);
  const hasDescription = !!block.description?.content.length;
  const ids: FieldIds = {
    base,
    input: `${base}-input`,
    label: `${base}-label`,
    ...(hasDescription ? { description: `${base}-description` } : {}),
    ...(error ? { error: `${base}-error` } : {}),
  };
  const describedBy = [ids.description, ids.error].filter(Boolean).join(' ');
  if (describedBy) ids.describedBy = describedBy;
  const required = state.required.has(block.id);
  const field: FieldState = {
    ids,
    invalid: !!error,
    required,
    disabled: state.disabled.has(block.id),
    readOnly: block.readOnly === true,
    autoFocus: block.autoFocus === true,
  };
  const labelling = control.labelling(block as never);
  const Component = control.Component as (props: { block: FieldBlock; field: FieldState }) => ReactNode;
  const labelText = (
    <>
      <RichTextView doc={block.label} inline resolve={resolve} />
      {required ? <RequiredMark /> : null}
    </>
  );
  const labelClass = block.hideLabel ? 'fr-label fr-sr-only' : 'fr-label';
  const description = hasDescription && block.description ? (
    <div id={ids.description} className="fr-description fr-rich">
      <RichTextView doc={block.description} resolve={resolve} />
    </div>
  ) : null;
  const errorText = error ? <p id={ids.error} className="fr-error">{error}</p> : null;
  const common = { id: `${base}-field`, className: 'fr-field', 'data-type': block.type, 'data-invalid': error ? '' : undefined, style: styleVars(block.style) };

  if (labelling === 'group') {
    return (
      <fieldset {...common} aria-describedby={ids.describedBy}>
        <legend id={ids.label} className={labelClass}>{labelText}</legend>
        {description}
        <Component block={block} field={field} />
        {errorText}
      </fieldset>
    );
  }
  if (labelling === 'radiogroup') {
    return (
      <div {...common}>
        <div id={ids.label} className={labelClass}>{labelText}</div>
        {description}
        <div
          role="radiogroup"
          className="fr-group"
          aria-labelledby={ids.label}
          aria-describedby={ids.describedBy}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
        >
          <Component block={block} field={field} />
        </div>
        {errorText}
      </div>
    );
  }
  return (
    <div {...common}>
      <label id={ids.label} htmlFor={ids.input} className={labelClass}>{labelText}</label>
      {description}
      <Component block={block} field={field} />
      {errorText}
    </div>
  );
}

/** A block as the respondent sees it: nothing when logic hides it, it is concealed, hidden, or not available here. */
export function Block({ block }: { block: StoredBlock }) {
  const { state } = useEvaluation();
  if (block.type === 'unsupported' || !isAvailable(block.type) || !state.visible.has(block.id)) return null;
  const control = CONTROLS[block.type] as unknown as Control<never>;
  const labelling = control.labelling(block as never);
  if (labelling === 'none') return null;
  if (labelling === 'content') {
    const Component = control.Component as (props: { block: StoredBlock }) => ReactNode;
    return <Component block={block} />;
  }
  const fieldBlock = block as FieldBlock;
  if (fieldBlock.concealed) return null;
  return <FieldShell block={fieldBlock} control={control} />;
}
