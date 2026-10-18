import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildZodSchema, defaultValues, patternError } from '@/lib/zodFromBlocks';
import type { BlockValidation, FieldType, FormBlock } from '@/types/form';
import { block } from '@/test/fixtures';

const options = [
  { id: 'o1', label: 'One', value: 'one' },
  { id: 'o2', label: 'Two', value: 'two' },
];

function check(b: FormBlock, value: unknown) {
  return buildZodSchema([b]).safeParse({ [b.id]: value });
}

function messages(b: FormBlock, value: unknown) {
  const result = check(b, value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

function field(type: FieldType, validation: BlockValidation = {}, patch: Partial<FormBlock> = {}) {
  return block(type, { id: 'f', validation, ...patch });
}

describe('buildZodSchema', () => {
  it('has a key for every input block and skips content and hidden blocks', () => {
    const blocks = (['heading', 'paragraph', 'divider', 'page_break', 'thank_you', 'hidden', 'text', 'email', 'rating'] as const).map((t) =>
      block(t, { id: t }),
    );
    expect(Object.keys(buildZodSchema(blocks).shape)).toEqual(['text', 'email', 'rating']);
  });

  it('text: required, min, max and pattern use errorMessage when set', () => {
    expect(messages(field('text', { required: true }), '')).toEqual(['Required']);
    expect(messages(field('text', { required: true, errorMessage: 'Name please' }), '')).toContain('Name please');
    expect(messages(field('text', { min: 3 }), 'ab')).toEqual(['Min 3 characters']);
    expect(messages(field('text', { max: 3 }), 'abcd')).toEqual(['Max 3 characters']);
    expect(messages(field('text', { pattern: '^[0-9]+$' }), 'abc')).toEqual(['Invalid format']);
    expect(messages(field('text', { pattern: '^[0-9]+$', errorMessage: 'Digits' }), 'abc')).toEqual(['Digits']);
    expect(check(field('text', { pattern: '^[0-9]+$' }), '123').success).toBe(true);
  });

  it('dropdown, phone, date and time fall through to the text schema', () => {
    for (const type of ['dropdown', 'multiple_choice', 'phone', 'date', 'time', 'long_text'] as const) {
      expect(messages(field(type, { required: true }), '')).toEqual(['Required']);
      expect(check(field(type), '').success).toBe(true);
    }
  });

  it('email: optional accepts an empty string, required rejects it', () => {
    expect(check(field('email'), '').success).toBe(true);
    expect(check(field('email'), 'a@b.co').success).toBe(true);
    expect(messages(field('email'), 'nope')).toEqual(['Enter a valid email']);
    expect(messages(field('email', { required: true }), '')).toEqual(['Required']);
  });

  it('url: optional accepts an empty string, required rejects it', () => {
    expect(check(field('url'), '').success).toBe(true);
    expect(check(field('url'), 'https://example.com').success).toBe(true);
    expect(messages(field('url'), 'nope')).toEqual(['Enter a valid URL']);
    expect(messages(field('url', { required: true }), '')).toEqual(['Required']);
  });

  it('number: coerces strings and checks min and max', () => {
    const result = check(field('number', { min: 1, max: 10 }), '5');
    expect(result.success && result.data.f).toBe(5);
    expect(messages(field('number', { min: 1 }), '0')).toEqual(['Min 1']);
    expect(messages(field('number', { max: 10 }), '11')).toEqual(['Max 10']);
    expect(check(field('number'), '').success).toBe(true);
  });

  it('rating: required rejects 0 and empty', () => {
    expect(messages(field('rating', { required: true }), 0)).toEqual(['Required']);
    expect(check(field('rating', { required: true }), 3).success).toBe(true);
    expect(check(field('rating'), '').success).toBe(true);
  });

  it('checkbox and multi_select: required needs one selection', () => {
    for (const type of ['checkbox', 'multi_select'] as const) {
      expect(messages(field(type, { required: true }), [])).toEqual(['Select at least one']);
      expect(check(field(type, { required: true }), ['one']).success).toBe(true);
      expect(check(field(type), []).success).toBe(true);
    }
  });

  it('file_upload: required needs a non-empty FileList', () => {
    expect(messages(field('file_upload', { required: true }), [])).toEqual(['Please attach a file']);
    expect(check(field('file_upload'), undefined).success).toBe(true);
  });

  it('signature: required needs a data string of at least 20 characters', () => {
    expect(messages(field('signature', { required: true }), '')).toEqual(['Please sign']);
    expect(check(field('signature', { required: true }), 'data:image/png;base64,AAAA').success).toBe(true);
  });

  it('accepts the default values of any unconstrained optional form', () => {
    const types: FieldType[] = [
      'text', 'long_text', 'number', 'email', 'phone', 'url', 'dropdown', 'multiple_choice', 'checkbox',
      'multi_select', 'date', 'time', 'rating', 'linear_scale', 'nps', 'ranking', 'file_upload', 'signature',
      'hidden', 'heading', 'paragraph', 'page_break',
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...types), { maxLength: 20 }), (picked) => {
        const blocks = picked.map((type, i) => block(type, { id: `b${i}`, options }));
        expect(buildZodSchema(blocks).safeParse(defaultValues(blocks)).success).toBe(true);
      }),
    );
  });

  it('B12: an invalid pattern is ignored instead of throwing', () => {
    expect(() => buildZodSchema([field('text', { pattern: '[' })])).not.toThrow();
    expect(check(field('text', { pattern: '[' }), 'anything').success).toBe(true);
    expect(patternError('[')).toMatch(/Invalid pattern/);
    expect(patternError('^[0-9]+$')).toBeNull();
    expect(patternError(undefined)).toBeNull();
  });

  it('B8: a required ranking fails until the respondent orders it', () => {
    const blocks = [field('ranking', { required: true }, { options })];
    expect(buildZodSchema(blocks).safeParse(defaultValues(blocks)).success).toBe(false);
  });

  it('B9: an optional multiple choice left as null on blur accepts the empty answer', () => {
    expect(check(field('multiple_choice', {}, { options }), null).success).toBe(true);
  });

  it('optional text with min length or pattern accepts an empty answer (found in WP-0.02)', () => {
    expect(check(field('text', { min: 3 }), '').success).toBe(true);
    expect(check(field('text', { pattern: '^[0-9]+$' }), '').success).toBe(true);
  });

  it('B13: email applies its pattern and custom error message', () => {
    const email = field('email', { required: true, pattern: '@corp\\.com$', errorMessage: 'Use your work email' });
    expect(messages(email, 'a@gmail.com')).toEqual(['Use your work email']);
  });

  it('B14: an empty required number says Required, not NaN', () => {
    expect(messages(field('number', { required: true }), '')).toEqual(['Required']);
  });
});

describe('defaultValues', () => {
  it('uses [] for multi-value types, nothing for an unranked ranking, a number for rating types and a string otherwise', () => {
    const blocks = [
      block('heading', { id: 'h' }),
      block('hidden', { id: 'x' }),
      block('checkbox', { id: 'c', options }),
      block('multi_select', { id: 'm', options }),
      block('ranking', { id: 'r', options }),
      block('rating', { id: 'ra' }),
      block('nps', { id: 'n', customize: { defaultValue: '7' } }),
      block('text', { id: 't' }),
      block('email', { id: 'e', customize: { defaultValue: 'a@b.co' } }),
    ];
    expect(defaultValues(blocks)).toEqual({
      c: [],
      m: [],
      r: undefined,
      ra: undefined,
      n: 7,
      t: '',
      e: 'a@b.co',
    });
  });
});
