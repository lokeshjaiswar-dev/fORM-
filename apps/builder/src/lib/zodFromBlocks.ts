import { z } from 'zod';
import type { FormBlock } from '@/types/form';
import { isContentBlock } from '@/lib/fields';

function emptyToUndef(val: unknown) {
  if (val === '' || val === null || val === undefined) return undefined;
  return val;
}

function safeRegExp(pattern: string) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function patternError(pattern?: string) {
  return pattern && !safeRegExp(pattern) ? 'Invalid pattern; it is ignored until fixed' : null;
}

export function buildZodSchema(blocks: FormBlock[]) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const block of blocks) {
    if (isContentBlock(block.type) || block.type === 'hidden') continue;

    const v = block.validation ?? {};
    let schema: z.ZodTypeAny;

    switch (block.type) {
      case 'email': {
        const email = z.email('Enter a valid email');
        schema = v.required ? z.string().min(1, 'Required').pipe(email) : z.union([z.literal(''), email]);
        break;
      }
      case 'url': {
        const url = z.url('Enter a valid URL');
        schema = v.required ? z.string().min(1, 'Required').pipe(url) : z.union([z.literal(''), url]);
        break;
      }
      case 'number':
      case 'linear_scale':
      case 'nps': {
        let n = z.coerce.number();
        if (v.min !== undefined) n = n.min(v.min, `Min ${v.min}`);
        if (v.max !== undefined) n = n.max(v.max, `Max ${v.max}`);
        schema = z.preprocess(emptyToUndef, v.required ? n : n.optional());
        break;
      }
      case 'rating': {
        schema = z.preprocess(emptyToUndef, v.required ? z.coerce.number().min(1, 'Required') : z.coerce.number().optional());
        break;
      }
      case 'checkbox':
      case 'multi_select':
      case 'ranking': {
        const arr = z.array(z.string());
        schema = v.required ? arr.min(1, 'Select at least one') : arr;
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
        const msg = v.errorMessage || 'Required';
        let s = z.string();
        if (v.required) s = s.min(1, msg);
        if (v.min !== undefined) s = s.min(v.min, v.errorMessage || `Min ${v.min} characters`);
        if (v.max !== undefined) s = s.max(v.max, v.errorMessage || `Max ${v.max} characters`);
        const re = v.pattern ? safeRegExp(v.pattern) : null;
        if (re) s = s.regex(re, v.errorMessage || 'Invalid format');
        schema = s;
      }
    }

    shape[block.id] = schema;
  }

  return z.object(shape);
}

export function defaultValues(blocks: FormBlock[]) {
  const values: Record<string, unknown> = {};
  for (const block of blocks) {
    if (isContentBlock(block.type) || block.type === 'hidden') continue;
    if (block.type === 'checkbox' || block.type === 'multi_select' || block.type === 'ranking') {
      values[block.id] = block.type === 'ranking' ? (block.options ?? []).map((o) => o.value) : [];
    } else if (block.type === 'rating' || block.type === 'nps' || block.type === 'linear_scale') {
      values[block.id] = block.customize?.defaultValue ? Number(block.customize.defaultValue) : undefined;
    } else values[block.id] = block.customize?.defaultValue ?? '';
  }
  return values;
}
