import { z } from 'zod';
import { compilePattern, patternProblem, withinBudget } from '@form/validation';
import type { FormBlock } from '@/types/form';
import { isContentBlock } from '@/lib/fields';

function emptyToUndef(val: unknown) {
  if (val === '' || val === null || val === undefined) return undefined;
  if (Array.isArray(val) && val.length === 0) return undefined;
  return val;
}

/** v1 patterns run through re2js (@form/validation), the engine the v2 runtime and the server use (B12, VAL-04). */
function safeRegExp(pattern: string) {
  const compiled = compilePattern({ source: pattern });
  return compiled.ok ? compiled : null;
}

export function patternError(pattern?: string) {
  if (!pattern) return null;
  const problem = patternProblem({ source: pattern });
  return problem ? `Invalid pattern; it is ignored until fixed (${problem})` : null;
}

/** Absent, '', null and [] are unanswered (I9): required says so, optional accepts it (B9, B14). */
function answer<T extends z.ZodTypeAny>(schema: T, required: boolean, message = 'Required') {
  return z.preprocess(emptyToUndef, required ? z.custom((v) => v !== undefined, { message }).pipe(schema) : schema.optional());
}

export function buildZodSchema(blocks: FormBlock[]) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const block of blocks) {
    if (isContentBlock(block.type) || block.type === 'hidden') continue;

    const v = block.validation ?? {};
    const re = v.pattern ? safeRegExp(v.pattern) : null;
    const matches = (s: string) => !re || (withinBudget(re, s) && re.test(s));
    let schema: z.ZodTypeAny;

    switch (block.type) {
      case 'email': {
        const email = z.email(v.errorMessage || 'Enter a valid email').refine(matches, v.errorMessage || 'Invalid format');
        schema = answer(email, !!v.required, v.errorMessage || 'Required');
        break;
      }
      case 'url': {
        schema = answer(z.url('Enter a valid URL'), !!v.required);
        break;
      }
      case 'number':
      case 'linear_scale':
      case 'nps': {
        let n = z.number('Enter a number');
        if (v.min !== undefined) n = n.min(v.min, `Min ${v.min}`);
        if (v.max !== undefined) n = n.max(v.max, `Max ${v.max}`);
        schema = answer(z.preprocess((x) => (typeof x === 'string' ? Number(x) : x), n), !!v.required);
        break;
      }
      case 'rating': {
        schema = answer(z.coerce.number().min(1, 'Required'), !!v.required);
        break;
      }
      case 'checkbox':
      case 'multi_select':
      case 'ranking': {
        schema = answer(z.array(z.string()), !!v.required, 'Select at least one');
        break;
      }
      case 'file_upload': {
        schema = v.required
          ? z.custom<FileList>((val) => typeof FileList !== 'undefined' && val instanceof FileList && val.length > 0, {
              message: 'Please attach a file',
            })
          : z.any().optional();
        break;
      }
      case 'signature': {
        schema = v.required ? z.string().min(20, 'Please sign') : z.string().optional();
        break;
      }
      default: {
        let s = z.string();
        if (v.min !== undefined) s = s.min(v.min, v.errorMessage || `Min ${v.min} characters`);
        if (v.max !== undefined) s = s.max(v.max, v.errorMessage || `Max ${v.max} characters`);
        schema = answer(re ? s.refine(matches, v.errorMessage || 'Invalid format') : s, !!v.required, v.errorMessage || 'Required');
      }
    }

    shape[block.id] = schema;
  }

  return z.object(shape);
}

/** A ranking has no value until the respondent orders it (B8); scales and ratings start unanswered (B7). */
export function defaultValues(blocks: FormBlock[]) {
  const values: Record<string, unknown> = {};
  for (const block of blocks) {
    if (isContentBlock(block.type) || block.type === 'hidden') continue;
    if (block.type === 'checkbox' || block.type === 'multi_select') {
      values[block.id] = [];
    } else if (block.type === 'ranking') {
      values[block.id] = undefined;
    } else if (block.type === 'rating' || block.type === 'nps' || block.type === 'linear_scale') {
      values[block.id] = block.customize?.defaultValue ? Number(block.customize.defaultValue) : undefined;
    } else values[block.id] = block.customize?.defaultValue ?? '';
  }
  return values;
}
