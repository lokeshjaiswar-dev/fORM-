import { useCallback, useEffect, useState, type ComponentType } from 'react';
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
  const { control, setError, clearErrors } = useFormContext();
  const { revalidate, t, remote } = useRenderer();
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
  const onBlur = useCallback(() => {
    field.onBlur();
    if (!block.apiValidation || !remote?.check) return;
    const check = remote.check;
    const current = field.value as AnswerValue | null | undefined;
    const payload = current && current.type === block.type ? current.value : undefined;
    if (payload === undefined || payload === null || payload === '') return;
    if (typeof payload === 'string' && payload.trim() === '') return;
    const failed = block.messages?.api_failed ?? t('system:api_failed');
    check(block.id, payload, new AbortController().signal).then(
      (result) => {
        if (result.ok) clearErrors(block.id);
        else setError(block.id, { type: 'api_failed', message: failed });
      },
      () => setError(block.id, { type: 'api_failed', message: failed }),
    );
  }, [block.apiValidation, block.id, block.messages, block.type, clearErrors, field, remote, setError, t]);
  return { value, set, onBlur };
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

/** The option list a field loads through the host's remote source (`apiOptions` is a `{ remote: true }` marker on a public form). */
function useFetchedOptions(blockId: string, api: unknown): ChoiceOption[] | undefined {
  const { remote } = useRenderer();
  const wanted = Boolean(api) && remote?.options !== undefined;
  const [rows, setRows] = useState<ChoiceOption[] | undefined>();
  useEffect(() => {
    if (!wanted || !remote?.options) {
      setRows(undefined);
      return;
    }
    const controller = new AbortController();
    remote.options(blockId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setRows(next.length ? next : undefined);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [blockId, remote, wanted]);
  return rows;
}

/** Options as shown: API list when configured, then logic-hidden ones removed, shuffled per session when the block asks. */
export function useOptions(
  blockId: string,
  options: readonly ChoiceOption[],
  shuffle: false | { keepLast: number } | boolean | undefined,
  api?: unknown,
): ChoiceOption[] {
  const { meta } = useRenderer();
  const { state } = useEvaluation();
  const loaded = useFetchedOptions(blockId, api);
  const source = loaded ?? options;
  const hidden = new Set<OptionId>(state.hiddenOptions[blockId as keyof typeof state.hiddenOptions] ?? []);
  const visible = source.filter((o) => !hidden.has(o.id));
  if (!shuffle) return visible;
  return seededShuffle(visible, `${meta.shuffleSeed}:${blockId}`, typeof shuffle === 'object' ? shuffle.keepLast : 0);
}

export const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** The words of an inline document (a question label), for naming a question in a hint. */
function inlineWords(doc: unknown): string {
  const words: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') words.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return words.join('').trim();
}

/**
 * Dependent (cascading) options for a single or multi choice. While the parent question has no usable answer the
 * block waits (the engine disables it) and this returns the parent's name for a "Choose … first" hint. Whenever the
 * parent's answer stops allowing a chosen option, that choice is cleared, so a cleared State in turn empties District.
 */
export function useDependentChoice(
  block: FieldBlockOf<'single_choice'> | FieldBlockOf<'multi_choice'>,
  offered: readonly ChoiceOption[],
  disabled: boolean,
): { waitingFor?: string } {
  const { def } = useRenderer();
  const { state } = useEvaluation();
  const { control } = useFormContext();
  const { field } = useController({ name: block.id, control });
  /* Options loaded from an API have their own ids, which option links never name: such a block is not filtered here. */
  const parentId = block.apiOptions ? undefined : block.config.dependsOn;
  /* The engine drops answers a parent no longer allows before it evaluates, so a parent missing from the values has
     no usable answer: exactly when the engine makes this block wait. */
  const waiting = parentId !== undefined && disabled && state.values[parentId] === undefined;
  const offeredKey = offered.map((o) => o.id).join('\u0000');
  const raw = field.value as AnswerValue | null | undefined;
  const { onChange } = field;
  useEffect(() => {
    if (parentId === undefined || !raw) return;
    if (waiting) {
      onChange(null);
      return;
    }
    const allowed = new Set(offeredKey.split('\u0000'));
    if (raw.type === 'single_choice' && raw.value.optionId !== null && !allowed.has(raw.value.optionId)) onChange(null);
    if (raw.type === 'multi_choice') {
      const kept = raw.value.optionIds.filter((id) => allowed.has(id));
      if (kept.length !== raw.value.optionIds.length) onChange(kept.length || raw.value.other !== undefined ? { ...raw, value: { ...raw.value, optionIds: kept } } : null);
    }
  }, [parentId, raw, waiting, offeredKey, onChange]);
  if (!waiting || parentId === undefined) return {};
  const parent = def.blocks[parentId];
  return { waitingFor: parent && 'label' in parent ? inlineWords(parent.label) : '' };
}
