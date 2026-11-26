import { describe, expect, it } from 'vitest';
import { fieldTypeFlags, fieldTypePatch, nextFieldType } from '@/lib/fieldType';

describe('field type: required, read-only and hidden exclude one another', () => {
  it('gives a field only the type picked', () => {
    expect(fieldTypePatch({}, 'required')).toEqual({ required: true, readOnly: undefined, concealed: undefined });
    expect(fieldTypePatch({}, 'readOnly')).toEqual({ required: false, readOnly: true, concealed: undefined });
    expect(fieldTypePatch({}, 'concealed')).toEqual({ required: false, readOnly: undefined, concealed: true });
    expect(fieldTypePatch({}, undefined)).toEqual({ required: false, readOnly: undefined, concealed: undefined });
  });

  it('keeps a primary key required, never read-only or hidden', () => {
    expect(fieldTypePatch({ primaryKey: true }, 'readOnly')).toEqual({ required: true, readOnly: undefined, concealed: undefined });
    expect(fieldTypePatch({ primaryKey: true }, 'concealed')).toEqual({ required: true, readOnly: undefined, concealed: undefined });
    expect(fieldTypePatch({ primaryKey: true }, undefined)).toEqual({ required: true, readOnly: undefined, concealed: undefined });
  });

  it('the option just pressed wins over the one already on', () => {
    expect(nextFieldType(['required'], ['required', 'readOnly'])).toBe('readOnly');
    expect(nextFieldType(['readOnly'], ['readOnly', 'concealed'])).toBe('concealed');
    expect(nextFieldType([], ['required'])).toBe('required');
  });

  it('releasing the pressed option leaves none, or the one still on in an old form with two', () => {
    expect(nextFieldType(['required'], [])).toBeUndefined();
    expect(nextFieldType(['required', 'readOnly'], ['readOnly'])).toBe('readOnly');
  });

  it('reads the flags that are on', () => {
    expect(fieldTypeFlags({ required: true, readOnly: true })).toEqual(['required', 'readOnly']);
    expect(fieldTypeFlags({ required: false })).toEqual([]);
  });
});
