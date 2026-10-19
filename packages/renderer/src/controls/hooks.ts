import { useCallback, type ComponentType } from 'react';
import { useController, useFormContext } from 'react-hook-form';
import type { AvailableType } from '@form/registry';
import type { AnswerValue, AnswerValueMap, BlockOf, ChoiceOption, FieldBlockOf, LabelText, OptionId, ValueFieldType } from '@form/schema';
import { useRenderer } from '../context.ts';
import { useEvaluation } from '../eval/context.ts';
import type { RichTextResolvers } from '../richtext/RichTextView.tsx';
import { seededShuffle } from '../shuffle.ts';
import { labelText, pipeValue, type PipeContext } from '../text.ts';

/** DOM ids of one field: the control, its label, and what describes it. */
export interface FieldIds {
  base: string;
  input: string;
  label: string;
  description?: string;
  error?: string;
  /** Description and error ids, space separated, for `aria-describedby`. */
  describedBy?: string;
}

export interface FieldState {
  ids: FieldIds;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  autoFocus: boolean;
}

export interface ControlProps<T extends AvailableType> {
  block: BlockOf<T>;
  field: FieldState;
}

/**
 * How a control is labelled: `input` gets a `<label for>`, `group` a `<fieldset>` and `<legend>`, `radiogroup` a
 * `role="radiogroup"` named by the label (and carrying required and invalid), `content` renders itself, `none`
 * renders nothing (hidden fields still answer through logic captures).
 */
export type Labelling = 'input' | 'group' | 'radiogroup' | 'content' | 'none';

export interface Control<T extends AvailableType> {
  labelling: (block: BlockOf<T>) => Labelling;
  Component: ComponentType<ControlProps<T>>;
}

/** The control's answer from react-hook-form, typed by block type; `set(undefined)` clears it. */
export function useAnswer<T extends ValueFieldType>(block: FieldBlockOf<T>) {
  const { control } = useFormContext();
  const { revalidate } = useRenderer();
  const { field } = useController({ name: block.id, control });
  const raw = field.value as AnswerValue | null | undefined;
  const value = raw && raw.type === block.type ? (raw.value as AnswerValueMap[T]) : undefined;
  const { onChange } = field;
  const set = useCallback(
    (next: AnswerValueMap[T] | undefined) => {
      onChange(next === undefined ? null : { type: block.type, value: next });
      revalidate(block.id);
    },
    [onChange, revalidate, block.type, block.id],
  );
  return { value, set, onBlur: field.onBlur };
}

/** ARIA and state attributes every input-like control carries. */
export function inputAttrs(field: FieldState) {
  return {
    'aria-invalid': field.invalid || undefined,
    'aria-describedby': field.ids.describedBy,
    'aria-required': field.required || undefined,
    disabled: field.disabled,
    readOnly: field.readOnly || undefined,
    autoFocus: field.autoFocus || undefined,
  } as const;
}

/** Pipes in labels and rich text, resolved against the current evaluation. */
export function usePipes(): { ctx: PipeContext; text: (label: LabelText | undefined) => string; resolve: RichTextResolvers } {
  const { def, meta } = useRenderer();
  const { state } = useEvaluation();
  const ctx: PipeContext = { def, values: state.values, meta };
  return { ctx, text: (label) => labelText(label, ctx), resolve: { pipe: (attrs) => pipeValue(attrs, ctx) } };
}

/** Options as shown: logic-hidden ones removed, shuffled per session when the block asks (Other is not an option). */
export function useOptions(blockId: string, options: readonly ChoiceOption[], shuffle: false | { keepLast: number } | boolean | undefined): ChoiceOption[] {
  const { meta } = useRenderer();
  const { state } = useEvaluation();
  const hidden = new Set<OptionId>(state.hiddenOptions[blockId as keyof typeof state.hiddenOptions] ?? []);
  const visible = options.filter((o) => !hidden.has(o.id));
  if (!shuffle) return visible;
  return seededShuffle(visible, `${meta.shuffleSeed}:${blockId}`, typeof shuffle === 'object' ? shuffle.keepLast : 0);
}

export const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
