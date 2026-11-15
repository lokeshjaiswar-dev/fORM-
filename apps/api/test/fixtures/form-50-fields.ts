import type { FormDefinition } from '@form/schema';
import { draftWith, fieldBlock } from '../publishable-draft.ts';

/*
 * The form of the WP-1.12 performance check: 50 fields on one page and 10 show/hide rules, which is about the heaviest
 * ordinary form (an admission or registration form). The evaluation, the validation and the INSERT all scale with it, so
 * its p95 is the figure the plan quotes ("p95 < 150 ms for a 50-field form at 50 RPS on one node").
 *
 *   f01..f30  short text (f01..f05 required)
 *   f31..f40  number
 *   f41..f50  email
 *
 * Rule `r01`..`r10`: when `fNN` (NN = 01..10) equals "hide", hide number field `f(30 + NN)`. `answersFor(n)` makes the
 * answers of respondent `n`: the even numbered ones fire all ten rules, the odd ones none, so a run evaluates both
 * outcomes, and the hidden fields are answered anyway (a page can send them; the server drops them).
 */

export const FIELD_COUNT = 50;
export const RULE_COUNT = 10;

const pad = (n: number): string => String(n).padStart(2, '0');
export const fieldId = (n: number): string => `f${pad(n)}`;

type Block = ReturnType<typeof fieldBlock>;

/** The 50 blocks, in page order. */
export function form50Blocks(): Block[] {
  const blocks: Block[] = [];
  for (let n = 1; n <= 30; n++) blocks.push(fieldBlock(fieldId(n), 'short_text', {}, { required: n <= 5 }));
  for (let n = 31; n <= 40; n++) blocks.push(fieldBlock(fieldId(n), 'number'));
  for (let n = 41; n <= 50; n++) blocks.push(fieldBlock(fieldId(n), 'email'));
  return blocks;
}

/** The ten rules: `fNN` equals "hide" hides `f(30 + NN)`. */
export function form50Rules(): unknown[] {
  return Array.from({ length: RULE_COUNT }, (_, i) => {
    const n = i + 1;
    return {
      id: `r${pad(n)}`,
      enabled: true,
      when: {
        kind: 'group',
        id: `g${pad(n)}`,
        combinator: 'all',
        children: [
          {
            kind: 'condition',
            id: `c${pad(n)}`,
            left: { kind: 'ref', ref: { kind: 'answer', blockId: fieldId(n) } },
            op: 'eq',
            right: { kind: 'literal', value: { type: 'text', value: 'hide' } },
          },
        ],
      },
      then: [{ type: 'hide', targets: [fieldId(30 + n)] }],
    };
  });
}

/** The definition to save as the draft of form `formId`. */
export function form50Draft(formId: string, title = 'Fifty fields'): FormDefinition {
  const draft = draftWith(formId, form50Blocks(), title);
  return { ...draft, logic: { ...draft.logic, rules: form50Rules() } } as unknown as FormDefinition;
}

/** The answers of respondent `n`: all 50 fields, valid for the form whichever rules fire. */
export function answersFor(n: number): Record<string, unknown> {
  const fire = n % 2 === 0;
  const answers: Record<string, unknown> = {};
  for (let f = 1; f <= 30; f++) answers[fieldId(f)] = { type: 'short_text', value: f <= RULE_COUNT && fire ? 'hide' : `answer ${f} of respondent ${n}` };
  for (let f = 31; f <= 40; f++) answers[fieldId(f)] = { type: 'number', value: String(n * 100 + f) };
  for (let f = 41; f <= 50; f++) answers[fieldId(f)] = { type: 'email', value: { address: `r${n}-f${f}@example.test` } };
  return answers;
}

/** The ids of the fields a respondent whose rules fire does not get stored (`f31..f40`), for a spot check of the rules' effect. */
export const hiddenWhenFired = (): string[] => Array.from({ length: RULE_COUNT }, (_, i) => fieldId(31 + i));
