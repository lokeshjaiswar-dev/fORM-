import { z } from 'zod';

/*
 * Text Postgres can store. A NUL (U+0000) cannot be in a text value or in a jsonb string, and a lone surrogate cannot
 * be in jsonb; either one makes the INSERT fail, which is an internal error for a request that was only invalid. The
 * other C0 controls (bell, backspace, escape, ...) are never typed: they are used to corrupt a terminal or a CSV a
 * member opens later. Tab, line feed and carriage return are ordinary text and stay.
 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A UTF-16 surrogate with no partner: JSON.stringify writes it as an escape that Postgres refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why a string cannot be kept, or null when it can. */
export function unstorableText(text: string): 'control_character' | 'broken_unicode' | null {
  if (CONTROL.test(text)) return 'control_character';
  if (LONE_SURROGATE.test(text)) return 'broken_unicode';
  return null;
}

/** Text the server makes (from a form's own labels and options) made storable: control characters become spaces, a lone surrogate U+FFFD. */
export function storableText(text: string): string {
  return text.replace(new RegExp(CONTROL, 'g'), ' ').replace(new RegExp(LONE_SURROGATE, 'g'), '�');
}

/**
 * The path of the first string (a key or a value, at any depth) in a parsed JSON value that cannot be kept, or null.
 * Iterative, so a deeply nested body cannot exhaust the stack.
 */
export function firstUnstorable(value: unknown): Array<string | number> | null {
  const stack: Array<{ value: unknown; path: Array<string | number> }> = [{ value, path: [] }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value: current, path } = item;
    if (typeof current === 'string') {
      if (unstorableText(current)) return path;
    } else if (Array.isArray(current)) {
      current.forEach((child, i) => stack.push({ value: child, path: [...path, i] }));
    } else if (current !== null && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (unstorableText(key)) return [...path, key];
        stack.push({ value: child, path: [...path, key] });
      }
    }
  }
  return null;
}

/** A zod refinement for free-form JSON that will be stored: names the offending path in the issue. */
export function storableJson<T extends z.ZodType>(schema: T): T {
  return schema.superRefine((value, ctx) => {
    const path = firstUnstorable(value);
    if (path) ctx.addIssue({ code: 'custom', path, message: 'contains a character that cannot be stored (a control character or a broken surrogate)' });
  }) as unknown as T;
}

/** A string that can be stored: no NUL or other control character (tab, line feed and carriage return excepted), no lone surrogate. */
export const storableString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => unstorableText(text) === null, 'contains a character that cannot be stored (a control character or a broken surrogate)');
